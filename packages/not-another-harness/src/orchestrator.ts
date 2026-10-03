import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import * as nodePath from "node:path";
import { promisify } from "node:util";
import type { LanguageModel } from "ai";
import { runAgent } from "./agent.js";
import type { HarnessEvent, HarnessRunOptions, HarnessStopReason, HarnessUsage } from "./types.js";

const execFileAsync = promisify(execFile);

const emptyUsage = (): HarnessUsage => ({ inputTokens: 0, outputTokens: 0, totalTokens: 0, estimated: false });

/** Sum two usage records. `estimated` sticks once anything had to be estimated. */
const addUsage = (acc: HarnessUsage, next: HarnessUsage): HarnessUsage => ({
  inputTokens: acc.inputTokens + next.inputTokens,
  outputTokens: acc.outputTokens + next.outputTokens,
  totalTokens: acc.totalTokens + next.totalTokens,
  estimated: acc.estimated === true || next.estimated === true,
  ...(acc.cachedInputTokens === undefined && next.cachedInputTokens === undefined
    ? {}
    : { cachedInputTokens: (acc.cachedInputTokens ?? 0) + (next.cachedInputTokens ?? 0) }),
  ...(acc.cacheCreationInputTokens === undefined && next.cacheCreationInputTokens === undefined
    ? {}
    : { cacheCreationInputTokens: (acc.cacheCreationInputTokens ?? 0) + (next.cacheCreationInputTokens ?? 0) }),
});

/**
 * Default ceiling on simultaneous children.
 *
 * Three is not a measured number. It is the point where fan-out stops being
 * "the parent asked for three things at once" and starts being a self-inflicted
 * spend event that the parent's own budget rail was never sized for.
 */
const DEFAULT_MAX_CONCURRENCY = 3;

/** A child that has run this long has stopped being a subtask and started being a leak. */
const DEFAULT_TASK_TIMEOUT_MS = 15 * 60_000;

/** Diffs are returned inline into the parent's context, so they need a ceiling. */
const DEFAULT_MAX_DIFF_CHARS = 30_000;

/** The parent's final report is one tool result; it is bounded like any other. */
const DEFAULT_MAX_REPORT_CHARS = 4_000;

/** Thrown when a task is submitted while the orchestrator is already at capacity. */
export class OrchestratorBusyError extends Error {
  constructor(public readonly limit: number) {
    super(`at most ${limit} subtasks can run at once`);
    this.name = "OrchestratorBusyError";
  }
}

/** One unit of delegated work. */
export type SubtaskSpec = {
  /** Stable handle for events and results. Generated when absent. */
  id?: string;
  /** Short label, echoed into the child's system prompt and the report. */
  title: string;
  /**
   * The assignment itself: what to build, where to stop, and how it will be
   * judged. Children get no conversation history, so anything not written here
   * is knowledge they cannot have.
   */
  task: string;
  /** Per-task step cap. Falls back to the orchestrator's. */
  maxSteps?: number;
  /** Per-task spend ceiling in US dollars. Requires `rates`. */
  maxSpendUsd?: number;
  /** Abort one child without touching its siblings. */
  signal?: AbortSignal;
};

/** What an isolation strategy made available to a child. */
export type IsolationHandle = {
  /** Root the child's tools must be confined to. */
  cwd: string;
  /**
   * Facts about the isolation worth telling the child: which revision it starts
   * from, which parent edits it cannot see. A child that does not know the parent
   * has uncommitted work will happily re-implement it.
   */
  boundaryNotes: readonly string[];
  /**
   * The child's output as the parent needs to review it. Absent for isolation
   * that does not produce a reviewable artifact (a shared workspace, say).
   */
  collect?: () => Promise<SubtaskArtifact>;
  /** Release the isolation. `retain` keeps it when the artifact was too big to inline. */
  cleanup: (opts: { retain: boolean }) => Promise<void>;
};

/** What a child produced, in the shape a reviewer needs. */
export type SubtaskArtifact = {
  /** Revision the child branched from. */
  baseRevision?: string;
  /** Paths the child changed, repo-relative. */
  changedPaths: string[];
  /** Unified diff against `baseRevision`. */
  diff: string;
  /** Workspace retained for manual inspection, when one still exists. */
  workspace?: string;
};

/**
 * How a child gets its own workspace.
 *
 * Pluggable because the useful strategies are not comparable: a detached Git
 * worktree is what makes a child unable to see the parent's uncommitted edits,
 * and it needs a repository; a copy is what you use when there is not one. The
 * orchestrator itself only needs "a root, some facts, something to review,
 * something to clean up".
 */
export type SubtaskIsolation = {
  /** Human-readable name of the strategy, surfaced in reports. */
  readonly description: string;
  prepare: (input: { id: string; title: string; task: string }) => Promise<IsolationHandle>;
};

/** The outcome of one child, successful or not. */
export type SubtaskResult = {
  id: string;
  title: string;
  /** The harness stop reason, or `"error"` when the run itself failed. */
  status: HarnessStopReason | "error";
  steps: number;
  toolCalls: number;
  /** Cumulative usage for this child. Zero when the run failed before reporting. */
  usage: HarnessUsage;
  /** The child's closing report, if it produced one. */
  text: string;
  durationMs: number;
  /** Set when `status` is `"error"`. */
  error?: string;
  /** Workspace retained because its artifact exceeded the inline limit. */
  workspace?: string;
  artifact?: SubtaskArtifact;
};

export type OrchestratorEvent =
  | { type: "subtask-start"; id: string; title: string }
  | { type: "subtask-event"; id: string; title: string; event: HarnessEvent }
  | { type: "subtask-finish"; id: string; title: string; result: SubtaskResult };

export type OrchestratorOptions = {
  /** Any AI SDK language model, or a getter for one resolved per child. */
  model: LanguageModel | (() => LanguageModel);
  /** Parent system prompt. Children receive it plus their boundary notes. */
  system: string;
  /** Build a child tool set confined to `cwd`. `createCodingTools(createNodeEnvironment(cwd))`. */
  createTools: (cwd: string) => HarnessRunOptions["tools"];
  /** Defaults to sharing the caller's workspace: a root, and no isolation. */
  isolation?: SubtaskIsolation;
  /** Simultaneous children. Default 3. */
  maxConcurrency?: number;
  /** Step cap per child. No ceiling when unset, as for any run. */
  maxSteps?: number;
  /** Spend ceiling per child, in US dollars. Requires `rates`. */
  maxSpendUsd?: number;
  /**
   * @deprecated Renamed to `maxSpendUsd` in `runAgent`, and deprecated there for
   * the same reason: a token budget measures harness efficiency, not cost.
   * Forwarded only so an existing caller keeps its ceiling.
   */
  maxTokens?: number;
  /** Per-model prices, needed for `maxSpendUsd` to mean anything. */
  rates?: HarnessRunOptions["rates"];
  /** Wall-clock ceiling per child. Default 15 minutes; 0 disables. */
  taskTimeoutMs?: number;
  /** Inline diff ceiling. Longer diffs retain the workspace and are truncated. Default 30_000. */
  maxDiffChars?: number;
  /** Aborts every child still in flight. */
  signal?: AbortSignal;
  onEvent?: (event: OrchestratorEvent) => void;
  /** Called once per finished child, for callers rolling child spend into their own totals. */
  onUsage?: (usage: HarnessUsage) => void;
};

/**
 * Runs bounded subtasks as isolated child agents and returns their work.
 *
 * The point is not concurrency. It is that a child gets a *fresh transcript*
 * against a *known* workspace, so a large read-and-reason job stops competing for
 * one context window with the parent's own work — and so a child that goes wrong
 * leaves something reviewable behind instead of half-applied edits.
 *
 * Deliberately not a dependency of `runAgent`. A caller with one task and one
 * workspace should not pay for this, and an orchestrator that could silently
 * substitute itself for the loop would hide the isolation it exists to provide.
 */
export class Orchestrator {
  readonly #options: Required<Pick<OrchestratorOptions, "createTools" | "system" | "maxConcurrency">> & OrchestratorOptions;
  #active = 0;
  #total = emptyUsage();

  constructor(options: OrchestratorOptions) {
    this.#options = {
      ...options,
      maxConcurrency: Math.max(1, Math.floor(options.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY)),
    };
  }

  /** Children currently in flight. */
  get active(): number {
    return this.#active;
  }

  /** Usage summed across every child that has finished. */
  get totalUsage(): HarnessUsage {
    return { ...this.#total };
  }

  /**
   * Run one subtask and wait for it.
   *
   * Rejects with `OrchestratorBusyError` rather than queueing: a queued child
   * starts later than the parent expected and can outlive the run that asked for
   * it. Saturation is a signal the parent should act on, not something to hide
   * behind a wait.
   */
  async run(spec: SubtaskSpec): Promise<SubtaskResult> {
    if (this.#active >= this.#options.maxConcurrency) throw new OrchestratorBusyError(this.#options.maxConcurrency);
    const id = spec.id ?? randomUUID();
    this.#options.onEvent?.({ type: "subtask-start", id, title: spec.title });
    this.#active += 1;
    try {
      const result = await this.#execute({ ...spec, id });
      this.#total = addUsage(this.#total, result.usage);
      this.#options.onUsage?.(result.usage);
      this.#options.onEvent?.({ type: "subtask-finish", id, title: spec.title, result });
      return result;
    } finally {
      this.#active -= 1;
    }
  }

  /**
   * Run subtasks concurrently, up to the concurrency cap, and return them all.
   *
   * Runs in waves rather than rejecting a plan larger than the cap. A plan is
   * rarely one item, and `runAll` is the call a parent makes *because* it has
   * several — so the cap is a scheduling constraint here, not a refusal. (`run`
   * still rejects, because a caller delegating one task at a time can see the
   * queue and choose to wait.)
   *
   * Settles every task even when one fails, because a child that errored still
   * produced a reviewable workspace and a status the parent needs.
   */
  async runAll(specs: readonly SubtaskSpec[]): Promise<SubtaskResult[]> {
    const limit = this.#options.maxConcurrency;
    const results: SubtaskResult[] = [];
    for (let start = 0; start < specs.length; start += limit) {
      const wave = specs.slice(start, start + limit);
      results.push(
        ...(await Promise.all(
          wave.map(async (spec) => {
            try {
              return await this.run(spec);
            } catch (error) {
              if (error instanceof OrchestratorBusyError) throw error;
              return this.#failed(spec, error);
            }
          }),
        )),
      );
    }
    return results;
  }

  async #execute(spec: SubtaskSpec): Promise<SubtaskResult> {
    const startedAt = Date.now();
    const isolation = this.#options.isolation ?? sharedWorkspaceIsolation();
    let handle: IsolationHandle | undefined;
    try {
      handle = await isolation.prepare({ id: spec.id ?? "", title: spec.title, task: spec.task });
      const child = await this.#runChild(spec, handle);
      const artifact = handle.collect ? await handle.collect() : undefined;
      // An artifact too large to inline is only useful if someone can still go
      // look at it, so a truncated diff retains the workspace it came from.
      const retain = artifact !== undefined && artifact.diff.length > this.#diffLimit();
      const result: SubtaskResult = {
        ...child,
        durationMs: Date.now() - startedAt,
        workspace: retain ? handle.cwd : undefined,
        artifact: artifact
          ? {
              ...artifact,
              diff: retain
                ? `${artifact.diff.slice(0, this.#diffLimit())}\n[diff truncated at ${this.#diffLimit()} characters; full diff remains in ${handle.cwd}. Review it there and remove the worktree when finished.]`
                : artifact.diff || "(no changes produced)",
            }
          : undefined,
      };
      await handle.cleanup({ retain });
      handle = undefined;
      return result;
    } catch (error) {
      if (handle) await handle.cleanup({ retain: false }).catch(() => {});
      return this.#failed(spec, error, Date.now() - startedAt);
    }
  }

  async #runChild(spec: SubtaskSpec, handle: IsolationHandle): Promise<Omit<SubtaskResult, "durationMs" | "workspace" | "artifact">> {
    const options = this.#options;
    const controller = new AbortController();
    const timeoutMs = options.taskTimeoutMs ?? DEFAULT_TASK_TIMEOUT_MS;
    const timer = timeoutMs > 0 ? setTimeout(() => controller.abort(new DOMException("Delegated task timed out", "TimeoutError")), timeoutMs) : undefined;
    const external = spec.signal ?? options.signal;
    const onExternalAbort = () => controller.abort(external?.reason);
    external?.addEventListener("abort", onExternalAbort, { once: true });

    const run = runAgent({
      model: typeof options.model === "function" ? options.model() : options.model,
      system: [options.system, "\nDelegated subtask boundaries:", `- Assignment: ${spec.title}`, "- Work only on the assigned subtask and its acceptance criteria.", ...handle.boundaryNotes].join("\n"),
      prompt: spec.task,
      tools: options.createTools(handle.cwd),
      maxSteps: spec.maxSteps ?? options.maxSteps,
      maxTokens: options.maxTokens,
      maxSpendUsd: spec.maxSpendUsd ?? options.maxSpendUsd,
      rates: options.rates,
      abortSignal: controller.signal,
    });

    let toolCalls = 0;
    // The event stream has to be drained even when nobody renders it: it is what
    // unblocks the run, and an undrained stream is a run that never settles.
    const consume = (async () => {
      for await (const event of run.events) {
        if (event.type === "tool-call") toolCalls += 1;
        options.onEvent?.({ type: "subtask-event", id: spec.id ?? "", title: spec.title, event });
      }
    })();

    try {
      const settled = await Promise.allSettled([run.result, consume]);
      const runResult = settled[0];
      if (runResult?.status === "rejected") throw runResult.reason;
      const eventFailure = settled[1];
      if (eventFailure?.status === "rejected") throw eventFailure.reason;
      const result = runResult.status === "fulfilled" ? runResult.value : undefined;
      if (!result) throw new Error("child task produced no result");
      return {
        id: spec.id ?? "",
        title: spec.title,
        status: result.reason,
        steps: result.steps,
        toolCalls,
        usage: result.usage,
        text: result.text,
        ...(result.reason === "error" ? { error: result.text || "child task failed" } : {}),
      };
    } finally {
      if (timer) clearTimeout(timer);
      external?.removeEventListener("abort", onExternalAbort);
    }
  }

  #failed(spec: SubtaskSpec, error: unknown, durationMs = 0): SubtaskResult {
    return {
      id: spec.id ?? randomUUID(),
      title: spec.title,
      status: "error",
      steps: 0,
      toolCalls: 0,
      usage: emptyUsage(),
      text: "",
      durationMs,
      error: error instanceof Error ? error.message : String(error),
    };
  }

  #diffLimit(): number {
    return Math.max(1_000, Math.floor(this.#options.maxDiffChars ?? DEFAULT_MAX_DIFF_CHARS));
  }
}

/**
 * System-prompt guidance for a parent that owns an orchestrator.
 *
 * Kept here rather than in each caller's prompt because the constraints are
 * properties of the mechanism: a child cannot see uncommitted parent work, and
 * its diff is never applied automatically. A parent that does not know both will
 * delegate dependent work and then apply a diff to a tree it has since moved.
 */
export const orchestratorPrompt = (opts: { concurrency?: number; isolation?: string } = {}): string => {
  const lines = [
    "Delegated subtasks:",
    `- A child starts from committed ${opts.isolation ?? "workspace"} state and cannot see uncommitted parent work. Delegate only tasks that are independent of those changes, and never the whole user request.`,
    "- A child's changes are never merged automatically. Review its diff and integrate deliberately.",
    "- Children do not share history. State the task, the boundaries, and the acceptance criteria in the assignment itself.",
  ];
  if (opts.concurrency !== undefined) {
    lines.push(`- At most ${opts.concurrency} children run at once; further delegations are refused until one finishes.`);
  }
  return lines.join("\n");
};

/**
 * Render a finished subtask as the block of text a parent reviews.
 *
 * Shape is fixed on purpose: identity, base, metrics, changed paths, diff, then
 * the child's own report. A reviewer that has to find these by scrolling learns
 * to trust the diff alone.
 */
export const formatSubtaskReport = (result: SubtaskResult, opts: { maxReportChars?: number } = {}): string => {
  const artifact = result.artifact;
  const metrics =
    result.status === "error" && result.steps === 0
      ? `status: error; steps: 0; tool calls: 0; elapsed: ${result.durationMs}ms; error: ${result.error ?? "child task failed"}`
      : `status: ${result.status}; steps: ${result.steps}; tool calls: ${result.toolCalls}; tokens: ${result.usage.inputTokens} in / ${result.usage.outputTokens} out / ${result.usage.totalTokens} total; estimated usage: ${result.usage.estimated === true}; elapsed: ${result.durationMs}ms`;
  const limit = Math.max(0, opts.maxReportChars ?? DEFAULT_MAX_REPORT_CHARS);
  return [
    `Delegated task: ${result.title}`,
    ...(artifact?.baseRevision ? [`Base revision: ${artifact.baseRevision}`] : []),
    metrics,
    ...(artifact ? [`Changed paths: ${artifact.changedPaths.length ? artifact.changedPaths.join(", ") : "none"}`] : []),
    ...(artifact ? ["Review this diff before applying any of it:", artifact.diff] : []),
    result.error ? `Child error: ${result.error}` : "",
    result.text ? `Child report:\n${limit ? result.text.slice(0, limit) : result.text}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
};

/** Default isolation: children share the caller's workspace and are given no isolation. */
export const sharedWorkspaceIsolation = (): SubtaskIsolation => ({
  description: "shared workspace",
  prepare: async () => ({
    cwd: ".",
    boundaryNotes: ["- You share a workspace with the parent agent. Coordinate through files, and keep to your assignment."],
    cleanup: async () => {},
  }),
});

export type GitWorktreeIsolationOptions = {
  /** Any directory inside the repository the children branch from. */
  cwd: string;
  /** Where worktrees are created. Defaults to the OS temp directory. */
  tmpRoot?: string;
  /** Keep the worktree even when its diff fit inline. Off by default. */
  retain?: boolean;
};

/**
 * Isolation by detached Git worktree.
 *
 * The property that matters: the child sees committed `HEAD` and nothing else, so
 * two children cannot collide and a child cannot half-apply over a parent edit in
 * progress. The cost is that it needs a repository, and that uncommitted parent
 * work is invisible — which is why `boundaryNotes` names those paths instead of
 * leaving the child to guess.
 */
export const createGitWorktreeIsolation = (options: GitWorktreeIsolationOptions): SubtaskIsolation => {
  const runGit = async (cwd: string, args: string[]) => {
    const result = await execFileAsync("git", args, { cwd, maxBuffer: 8 * 1024 * 1024, encoding: "utf8" });
    return { stdout: result.stdout, stderr: result.stderr };
  };

  return {
    description: "temporary Git worktree",
    prepare: async () => {
      const worktree = nodePath.join(options.tmpRoot ?? tmpdir(), `nah-delegate-${randomUUID()}`);
      const repositoryRoot = (await runGit(options.cwd, ["rev-parse", "--show-toplevel"])).stdout.trim();
      const parentStatus = (await runGit(repositoryRoot, ["status", "--porcelain=v1", "-z", "--untracked-files=all"])).stdout;
      const parentChangedPaths = parentStatus.split("\0").filter(Boolean).map((entry) => entry.slice(3));
      const baseRevision = (await runGit(repositoryRoot, ["rev-parse", "HEAD"])).stdout.trim();
      await runGit(repositoryRoot, ["worktree", "add", "--detach", worktree, baseRevision]);

      return {
        cwd: worktree,
        baseRevision,
        boundaryNotes: [
          ...(parentChangedPaths.length ? [`- The parent has uncommitted changes in: ${parentChangedPaths.join(", ")}. They are not present here; do not depend on them.`] : []),
          "- This is an isolated worktree. Do not attempt to access or modify the parent worktree.",
          "- Do not commit changes. Inspect and validate your changes when practical, then report what changed and any check results.",
          "- The parent agent will review your diff and decide whether to integrate it.",
        ],
        collect: async (): Promise<SubtaskArtifact> => {
          const statusOutput = (await runGit(worktree, ["status", "--porcelain=v1", "--untracked-files=all"])).stdout;
          if (statusOutput.trim()) await runGit(worktree, ["add", "--intent-to-add", "--", "."]);
          const changedPaths = (await runGit(worktree, ["diff", "--name-only", "-z", baseRevision, "--"])).stdout.split("\0").filter(Boolean);
          const diff = (await runGit(worktree, ["diff", "--no-ext-diff", "--no-color", "--no-renames", baseRevision, "--"])).stdout;
          return { baseRevision, changedPaths, diff, workspace: worktree };
        },
        cleanup: async ({ retain }) => {
          if (retain || options.retain) return;
          try {
            await runGit(repositoryRoot, ["worktree", "remove", "--force", worktree]);
          } catch {
            // The report already carries the child's work; a stale worktree is
            // recoverable with `git worktree prune`, and failing the child over it
            // would throw away a diff the parent needs.
          }
        },
      };
    },
  };
};