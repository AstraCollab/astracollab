import type { LanguageModel, ModelMessage } from "ai";
import type { ModelRates } from "./spend.js";
import type { CacheAccounting } from "./cache.js";

/** Token usage reported for a step or an entire run. */
export type HarnessUsage = {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  /** True when one or more step totals had to be estimated from text length. */
  estimated?: boolean;
  /**
   * Tokens served from prompt cache, cumulative for the run.
   *
   * Reported separately by Anthropic and *not* included in `inputTokens` when
   * caching is active, which makes `inputTokens` alone a misleading measure of
   * how large a request actually was.
   */
  cachedInputTokens?: number;
  /** Tokens written into the prompt cache by this run. */
  cacheCreationInputTokens?: number;
  /** Cumulative dollar spend. Requires `rates`; 0 when unset. */
  spendUsd?: number;
};

/**
 * The cache-aware shape of one request, as the provider billed it.
 *
 * `HarnessUsage` is cumulative, so it cannot answer "how big is the prompt right
 * now" — summing inputs across steps gives the total spent, not the context in
 * use. Providers also split input three ways, and only one of the three is
 * `inputTokens`:
 *
 * ```
 * total input = cache_read + cache_creation + fresh
 * ```
 *
 * Omitting the first two is how a caller ends up displaying a cumulative spend
 * figure as if it were a context size.
 */
export type HarnessRequestBreakdown = {
  /** Everything sent as input, cached and fresh. This is the context footprint. */
  totalInputTokens: number;
  /** Read back from cache. */
  cachedInputTokens: number;
  /** Written into cache by this request. */
  cacheCreationInputTokens: number;
  /** Sent uncached, i.e. after the last breakpoint. */
  freshInputTokens: number;
  /**
   * `cachedInputTokens / totalInputTokens`, or 0 when nothing has been cached.
   *
   * The number to watch: a well-cached run sits above 90%, and a low value means
   * something in the prefix is changing between steps.
   */
  hitRate: number;
};

/** Why an agent run ended. */
export type HarnessStopReason =
  | "completed" /** Model replied with no tool calls. */
  /**
   * An explicit step ceiling was reached.
   *
   * Only reachable when the caller passes `maxSteps`; there is no default. This
   * used to be the default reason a run ended, on a cap of 32 that no evidence
   * chose, and it cut working runs — a 27-call git merge stopped at the ceiling
   * having done none of its verification.
   */
  | "max-steps"
  /**
   * Nothing has changed for long enough that the run is treated as stuck.
   *
   * The guard that replaced the default step cap, and the same signal Claude Code
   * uses for its goal loop: "no tool use for several turns in a row". It measures
   * progress rather than length, so it fires on a loop and stays quiet on a long
   * task — which is the distinction a step counter cannot make.
   */
  | "no-progress"
  /** A spend ceiling was hit: the dollar rail, or the deprecated token rail. */
  | "max-tokens"
  /**
   * The model's reply hit the per-step *output* cap and was cut off.
   *
   * Distinct from `max-tokens` because it means something completely different:
   * nothing was wrong with input size or spend, one response was simply longer
   * than the allowance. Thinking tokens count against that cap, so on a reasoning
   * model a single verbose step can trip it - and reporting that as `max-tokens`
   * sends the reader to tune input context, the one knob that cannot fix it.
   */
  | "max-output"
  | "max-context" /** Next request exceeded the context window even after compaction. */
  | "aborted"
  | "error";

export type WorkspaceSnapshotEntry =
  | { kind: "directory"; mode: number }
  | { kind: "file"; mode: number; contentBase64: string }
  | { kind: "symlink"; mode: number; target: string };

export type WorkspaceSnapshot = {
  complete: boolean;
  entries: Record<string, WorkspaceSnapshotEntry>;
  excludedPaths: string[];
  reason?: string;
};

export type WorkspaceRestoreResult = { restoredPaths: string[]; conflicts: string[] };

/** How a mid-run user message is delivered into the transcript. */
export type HarnessSteerDelivery = "steer" | "follow-up";

/** Streaming events emitted while the agent loop runs. */
export type HarnessEvent =
  /**
   * `stepBudget` is `null` when the run is unbounded, which is the default.
   * `Infinity` is not JSON, and a display rendering "∞" where there is no limit
   * invites the reader to go looking for the knob that produced it.
   */
  | { type: "run-start"; stepBudget: number | null; tokenBudget: number }
  | { type: "step-start"; step: number }
  | { type: "text-delta"; step: number; text: string }
  | { type: "tool-call"; step: number; toolCallId: string; toolName: string; input: unknown }
  | {
      type: "tool-result";
      step: number;
      toolCallId: string;
      toolName: string;
      /** Text form of the (already output-capped) result. */
      output: string;
      isError: boolean;
    }
  | { type: "step-finish"; step: number; usage: HarnessUsage; request: HarnessRequestBreakdown }
  | { type: "compacted"; droppedMessages: number; keptMessages: number; summaryChars: number }
  /**
   * A budget or step limit is about to stop the run, so one final step is being
   * spent on handing off cleanly instead. A UI should show this as "wrapping up",
   * not as a failure — the run is ending by design, not because it broke.
   */
  | { type: "wrap-up"; reason: HarnessStopReason }
  /**
   * A user message sent while the run was in flight. `queued` fires when the
   * harness accepts it, `delivered` when it actually enters the transcript —
   * these are different moments, and a UI needs both to show a pending chip
   * that clears once the model can see it.
   */
  | {
      type: "user-message";
      text: string;
      delivery: HarnessSteerDelivery;
      phase: "queued" | "delivered";
    }
  | { type: "finish"; reason: HarnessStopReason; text: string; usage: HarnessUsage }
  | { type: "error"; error: unknown };

/** Pluggable working-directory backend for the built-in tools. */
export interface ToolEnvironment {
  /** Read a UTF-8 text file. Throws when the path is missing or binary. */
  readFile(path: string): Promise<string>;
  /** Write a UTF-8 text file, creating parent directories as needed. */
  writeFile(path: string, content: string): Promise<void>;
  /** Remove a file created in the workspace. */
  deleteFile?(path: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  /** Single-level directory listing of `dir`. */
  readdir(dir: string): Promise<Array<{ name: string; type: "file" | "directory" }>>;
  /**
   * Content search. Returns newline-delimited `path:line: text` matches
   * (relative paths preferred). Empty string when there are no matches.
   */
  grep(opts: {
    pattern: string;
    /** Narrow to a file/dir or glob, repo-relative. */
    path?: string;
    ignoreCase?: boolean;
    maxPerFile?: number;
    includeHidden?: boolean;
  }): Promise<string>;
  /**
   * Find files by glob pattern (`*`, `**`, `?`, `{a,b}`), workspace-relative.
   * Returns matching paths sorted with directories shallowest-first. Optional:
   * the built-in `glob` tool is only registered when the environment supports it.
   */
  glob?(opts: {
    pattern: string;
    /** Directory to search under (default the workspace root). */
    path?: string;
    includeHidden?: boolean;
    limit?: number;
  }): Promise<string[]>;
  /**
   * Run a shell command in the workspace root. Implementations must honour
   * `signal` so an aborted run stops promptly, and must not leave the command
   * reading from an open stdin (that blocks until the timeout).
   */
  exec(
    command: string,
    opts?: { timeoutSeconds?: number; signal?: AbortSignal },
  ): Promise<{ stdout: string; stderr: string; exitCode: number }>;
  /** Optional complete snapshot of workspace files for safe per-step recovery. */
  snapshot?(): Promise<WorkspaceSnapshot>;
  /** Restore paths only if current contents still match the expected post-step snapshot. */
  restoreSnapshot?(before: WorkspaceSnapshot, after: WorkspaceSnapshot, paths: string[]): Promise<WorkspaceRestoreResult>;
}

export type HarnessCompactionMode = "model" | "truncate" | "off";

export type HarnessRunOptions = {
  /** Any AI SDK v5 language model. */
  model: LanguageModel;
  /** The task/instruction (becomes the first user message). */
  prompt: string;
  /** Full system prompt (see `buildSystemPrompt` for the Pi-style builder). */
  system: string;
  /** Tool set — use `createCodingTools` or bring your own (`tool()` map). */
  tools: Record<string, unknown>;
  /** Hard step cap (one step = one model round-trip + its tool calls). Default 32. */
  maxSteps?: number;
  /**
   * @deprecated Renamed to `maxSpendUsd`. A token budget cannot express cost,
   * because a cached token costs a tenth of a fresh one — so this fired on
   * harness efficiency rather than on money, which made it behave as a step
   * counter. Still honoured when set; prefer `maxSpendUsd` plus `rates`.
   */
  maxTokens?: number;
  /**
   * Cumulative spend ceiling in US dollars. Requires `rates`.
   *
   * This is the safety rail, and it is checked against what the run has actually
   * cost rather than against a token count. 0 or undefined disables it.
   */
  maxSpendUsd?: number;
  /** Per-model prices used to turn usage into the `maxSpendUsd` figure. */
  rates?: ModelRates;
  /**
   * Per-request input ceiling in tokens, checked against the model's context
   * window. When the next request would exceed it the response is to compact,
   * not to stop — a full context window is fixable, so stopping is the worst
   * available response to one.
   */
  maxContextTokens?: number;
  /** Maximum generated tokens for one model response. Default 8_192. */
  maxOutputTokens?: number;
  /** Cancel the run. */
  abortSignal?: AbortSignal;
  /**
   * Mid-run transcript compaction. "model" summarizes the older half with the
   * same model (default when compactAtTokens is set), "truncate" drops it
   * lossily, "off" never compacts. Default: "model".
   */
  compaction?: HarnessCompactionMode;
  /**
   * Trigger compaction when the *next request* would carry roughly this many
   * input tokens. Measured from the last step's reported input count, so
   * repeated re-sending of the transcript does not inflate the trigger. Default
   * 120_000.
   *
   * Set high relative to the model's window on purpose: compaction is lossy, and
   * the research on constraint decay is unambiguous that a single compaction can
   * drop invariants the agent was relying on. Compact late, and keep cheap
   * tool-output elision underneath it.
   */
  compactAtTokens?: number;
  /**
   * Run one final wrap-up step before a hard stop, so the agent commits its
   * work and states what remains instead of being cut off mid-task. Default true.
   *
   * Costs one request and converts every hard stop from lost work into a
   * resumable state. Does not fire on `completed` or `error`, or when the caller
   * has aborted — someone who pressed Escape does not want a farewell message.
   */
  wrapUpOnLimit?: boolean;
  /** Messages to keep verbatim when compacting. Default 6. */
  compactKeepRecent?: number;
  /** Prior messages to continue from (e.g. restored session branch). */
  messages?: ModelMessage[];
  /**
   * Provider id used to decide whether prompt caching applies, e.g. "anthropic".
   * Set it to opt into Anthropic-style cache breakpoints.
   */
  cacheProvider?: string;
  /**
   * Override the inferred cache-accounting convention.
   *
   * @deprecated AI SDK v7 normalises cache accounting, so this is ignored. It
   * used to say whether the provider reported the cached prefix inside
   * `input_tokens` or beside it; v7 always reports the total in `inputTokens`
   * and the composition in `inputTokenDetails`, so there is nothing to choose.
   */
  cacheAccounting?: CacheAccounting;
  /** Cache lifetime for breakpoints. 5m is cheaper, 1h holds across longer runs. */
  cacheTtl?: "5m" | "1h";
  /**
   * Server-side context editing: ask the API to clear old tool results and
   * replace them with placeholders. Applied only for providers that support it.
   */
  /**
   * Client-side pruning of old tool results, for providers without server-side
   * context editing. Automatically skipped when the transcript contains
   * reasoning, because rewriting those results would invalidate signatures.
   */
  pruneToolResults?: {
    /** Recent tool rounds kept verbatim. Default 6. */
    keepRecentToolCalls?: number;
  };
  contextEditing?: {
    /** Input tokens that trigger clearing. Default 40_000. */
    triggerTokens?: number;
    /** Recent tool rounds kept intact. Default 6. */
    keepToolUses?: number;
    /** Tools whose results are never cleared. */
    excludeTools?: readonly string[];
  };
  /** Optional awaited callbacks at each model step boundary. */
  onStepStart?: (step: number, messages: ModelMessage[]) => void | Promise<void>;
  onStepFinish?: (step: number, messages: ModelMessage[]) => void | Promise<void>;
};

export type HarnessRunResult = {
  text: string;
  reason: HarnessStopReason;
  steps: number;
  usage: HarnessUsage;
  /** Full transcript after the run (append + persist for sessions). */
  messages: ModelMessage[];
  /** Number of compactions performed during the run. */
  compactions: number;
  /** True when the run was ended by a wrap-up step rather than cut off. */
  wrappedUp: boolean;
};

export type HarnessRun = {
  /** Typed event stream — drive UIs / JSONL logs from this. */
  events: AsyncIterable<HarnessEvent>;
  result: Promise<HarnessRunResult>;

  /**
   * Send a message while the run is in flight. It is appended to the transcript
   * at the next step boundary — after the current step's tool calls settle, and
   * before the next model request — so the in-flight call is never cut off
   * mid-token. Returns false if the run has already settled.
   *
   * Steers jump ahead of follow-ups.
   */
  steer(text: string): boolean;

  /**
   * Send a message that is delivered only if the run would otherwise finish.
   * Use this for "also, once you're done, ..." so a mid-run nudge does not
   * derail the task already in flight.
   */
  followUp(text: string): boolean;

  /**
   * Abort the run (the equivalent of pressing Escape). Unlike steering this
   * *does* cut off the in-flight model call and any running tool. Queued
   * messages are left intact so the caller can decide whether to replay them.
   */
  interrupt(): void;

  /** Currently queued messages, for rendering a pending indicator. */
  pending(): { steer: readonly string[]; followUp: readonly string[] };
};
