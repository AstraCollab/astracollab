import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as nodePath from "node:path";
import { promisify } from "node:util";
import type { LanguageModel } from "ai";
import { runAgent } from "./agent.js";
import type {
	HarnessEvent,
	HarnessRunOptions,
	HarnessStopReason,
	HarnessUsage,
} from "./types.js";
import type {
	Workflow,
	WorkflowContext,
	WorkflowEvent,
	WorkflowRun,
	WorkflowRunOptions,
	WorkflowRunResult,
	WorkflowSnapshot,
} from "./workflow.js";

const execFileAsync = promisify(execFile);

const emptyUsage = (): HarnessUsage => ({
	inputTokens: 0,
	outputTokens: 0,
	totalTokens: 0,
	estimated: false,
});

/** Sum two usage records. `estimated` sticks once anything had to be estimated. */
const addUsage = (acc: HarnessUsage, next: HarnessUsage): HarnessUsage => ({
	inputTokens: acc.inputTokens + next.inputTokens,
	outputTokens: acc.outputTokens + next.outputTokens,
	totalTokens: acc.totalTokens + next.totalTokens,
	estimated: acc.estimated === true || next.estimated === true,
	...(acc.cachedInputTokens === undefined &&
	next.cachedInputTokens === undefined
		? {}
		: {
				cachedInputTokens:
					(acc.cachedInputTokens ?? 0) + (next.cachedInputTokens ?? 0),
			}),
	...(acc.cacheCreationInputTokens === undefined &&
	next.cacheCreationInputTokens === undefined
		? {}
		: {
				cacheCreationInputTokens:
					(acc.cacheCreationInputTokens ?? 0) +
					(next.cacheCreationInputTokens ?? 0),
			}),
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

/** How often a workflow step waiting for a delegation slot checks whether one is free. */
const DELEGATE_SLOT_POLL_MS = 20;

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
	/**
	 * Workspace strategy for this child alone, overriding the orchestrator's.
	 *
	 * Per-task because the right workspace depends on the kind of work, not the
	 * session: a child that is only searching for its answer has nothing to
	 * branch, and paying for a detached worktree to ask a question is overhead
	 * with no payoff. Children that edit keep the orchestrator's default.
	 */
	isolation?: SubtaskIsolation;
	/**
	 * Tool set for this child alone, overriding the orchestrator's.
	 *
	 * The other half of a read-only child: narrowing tools is how "do not edit
	 * anything" stops being an instruction the child can ignore and becomes a
	 * capability it does not have.
	 */
	createTools?: (cwd: string) => HarnessRunOptions["tools"];
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
	prepare: (input: {
		id: string;
		title: string;
		task: string;
	}) => Promise<IsolationHandle>;
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
	| {
			type: "subtask-finish";
			id: string;
			title: string;
			result: SubtaskResult;
	  };

/** The one result variant worth keeping around: the run that is waiting on an answer. */
type SuspendedRunResult = Extract<WorkflowRunResult, { status: "suspended" }>;

/** What a workflow step can reach for, handed to it in `context`. */
export type WorkflowStepDelegate = {
	/** Run one subtask as a child agent, on the same terms as any other delegation. */
	delegate: (spec: SubtaskSpec) => Promise<SubtaskResult>;
	/** Run subtasks concurrently, up to the orchestrator's cap. */
	delegateAll: (specs: readonly SubtaskSpec[]) => Promise<SubtaskResult[]>;
	/** Workflows stopped on an answer only a caller can give. */
	pendingWorkflows: () => Array<{
		runId: string;
		workflowId: string;
		suspended: string[];
		suspendPayload: unknown;
		waitingMs: number;
	}>;
	/**
	 * Answer a suspended workflow, by run id.
	 *
	 * Takes the run id rather than the object, because a step is handed context and
	 * not the run it is executing inside — and a run id is what a caller has once the
	 * run that produced it has returned.
	 */
	resumeWorkflow: (
		runId: string,
		resumeData?: unknown,
	) => Promise<WorkflowRunResult>;
};

export type OrchestratorWorkflowOptions<TInput = any, TState = any> = Omit<
	WorkflowRunOptions<TInput>,
	"signal"
> & {
	signal?: AbortSignal;
	/** Progress, for a caller rendering a run. */
	onEvent?: (event: WorkflowEvent<TState>) => void;
	/** Skips the concurrency cap that applies to direct delegation. */
	ignoreConcurrency?: boolean;
};

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
	readonly #options: Required<
		Pick<OrchestratorOptions, "createTools" | "system" | "maxConcurrency">
	> &
		OrchestratorOptions;
	#active = 0;
	#total = emptyUsage();
	/** Runs stopped on a caller's answer, so they can be found and resumed. */
	readonly #suspended = new Map<
		string,
		{
			workflow: Workflow;
			run: WorkflowRun;
			result: SuspendedRunResult;
			startedAt: number;
		}
	>();

	constructor(options: OrchestratorOptions) {
		this.#options = {
			...options,
			maxConcurrency: Math.max(
				1,
				Math.floor(options.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY),
			),
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
		if (this.#active >= this.#options.maxConcurrency)
			throw new OrchestratorBusyError(this.#options.maxConcurrency);
		const id = spec.id ?? randomUUID();
		this.#options.onEvent?.({ type: "subtask-start", id, title: spec.title });
		this.#active += 1;
		try {
			const result = await this.#execute({ ...spec, id });
			this.#total = addUsage(this.#total, result.usage);
			this.#options.onUsage?.(result.usage);
			this.#options.onEvent?.({
				type: "subtask-finish",
				id,
				title: spec.title,
				result,
			});
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

	/**
	 * Run a workflow, with delegation available to every step.
	 *
	 * The split this exists for: a step that needs judgement calls `delegate`, and a
	 * step that does not is just code. The order, the fan-out and the retries are
	 * already decided before a model is asked anything, so a model is only consulted
	 * for the part that was never deterministic — and a workflow that delegates is
	 * the one place where "have the agent do it" and "do it the same way every time"
	 * stop being alternatives.
	 *
	 * A suspended run is kept until it is resumed or the orchestrator is dropped.
	 * A run waiting on a human that nobody can find again is not a pause, it is a
	 * hang, so `pendingWorkflows` is part of the contract and not a debug helper.
	 */
	async runWorkflow<TOutput = any, TInput = any, TState = any>(
		workflow: Workflow<TOutput, TInput, TState>,
		options: OrchestratorWorkflowOptions<TInput, TState> = {},
	): Promise<WorkflowRunResult<TOutput, TInput, TState>> {
		const run = workflow.createRun();
		const result = await run.start({
			inputData: options.inputData,
			context: this.#stepContext(options.context, options.signal),
			signal: options.signal ?? this.#options.signal,
			onEvent: options.onEvent,
		});
		this.#track(workflow, run, result);
		return result;
	}

	/** The same run as `runWorkflow`, reporting progress as it goes. */
	streamWorkflow<TOutput = any, TInput = any, TState = any>(
		workflow: Workflow<TOutput, TInput, TState>,
		options: OrchestratorWorkflowOptions<TInput, TState> = {},
	): {
		events: AsyncIterable<WorkflowEvent<TState>>;
		result: Promise<WorkflowRunResult<TOutput, TInput, TState>>;
		runId: string;
	} {
		const run = workflow.createRun();
		const handle = run.stream({
			inputData: options.inputData,
			context: this.#stepContext(options.context, options.signal),
			signal: options.signal ?? this.#options.signal,
		});
		// The iterable is the caller's to drain; a run nobody drains would queue events
		// forever, so the bookkeeping rides on the result instead of the iteration.
		void handle.result.then((result) => this.#track(workflow, run, result));
		return { ...handle, runId: run.runId };
	}

	/**
	 * Workflows stopped on something only a caller can answer.
	 *
	 * Reports what each is waiting on, so a UI can show the question and a decision
	 * can be routed back to `resumeWorkflow` by run id.
	 */
	pendingWorkflows(): Array<{
		runId: string;
		workflowId: string;
		suspended: string[];
		suspendPayload: unknown;
		waitingMs: number;
	}> {
		return [...this.#suspended.entries()].map(([runId, entry]) => ({
			runId,
			workflowId: entry.workflow.id,
			suspended: entry.result.suspended,
			suspendPayload: entry.result.suspendPayload,
			waitingMs: Date.now() - entry.startedAt,
		}));
	}

	/**
	 * Continue a suspended workflow with the caller's answer.
	 *
	 * Rejects on an unknown run id rather than starting a new one: a typo in a run id
	 * would otherwise run the whole sequence again from the top, paying for steps
	 * that already succeeded.
	 */
	async resumeWorkflow(
		runId: string,
		resumeData?: unknown,
		options: { context?: WorkflowContext; signal?: AbortSignal } = {},
	): Promise<WorkflowRunResult> {
		const entry = this.#suspended.get(runId);
		if (!entry)
			throw new Error(
				`orchestrator: no suspended workflow with run id "${runId}"`,
			);
		const result = await entry.run.resume({
			resumeData,
			context: this.#stepContext(options.context, options.signal),
			signal: options.signal ?? this.#options.signal,
		});
		this.#track(entry.workflow, entry.run, result);
		return result;
	}

	#track(
		workflow: Workflow,
		run: WorkflowRun,
		result: WorkflowRunResult,
	): void {
		if (result.status === "suspended")
			this.#suspended.set(run.runId, {
				workflow,
				run,
				result,
				startedAt: Date.now(),
			});
		else this.#suspended.delete(run.runId);
	}

	/**
	 * What a step can reach for: delegation, and the runs still waiting on an answer.
	 *
	 * Built per run so `signal` and any caller context belong to that run, and a
	 * workflow's steps cannot see another run's delegate.
	 */
	#stepContext(
		extra: WorkflowContext | undefined,
		signal: AbortSignal | undefined,
	): WorkflowContext & WorkflowStepDelegate {
		return {
			...extra,
			delegate: (spec: SubtaskSpec) => this.#delegate(spec, signal),
			delegateAll: (specs: readonly SubtaskSpec[]) =>
				Promise.all(specs.map((spec) => this.#delegate(spec, signal))),
			pendingWorkflows: () => this.pendingWorkflows(),
			resumeWorkflow: (runId: string, resumeData?: unknown) =>
				this.resumeWorkflow(runId, resumeData, { signal }),
		};
	}

	/**
	 * Delegation from inside a workflow waits for a slot instead of rejecting.
	 *
	 * `run` rejects at the cap so a caller delegating one task at a time learns the
	 * queue is full. A workflow step has no such freedom: the sequence it belongs to
	 * is already the queue, and failing the run over a full slot would fail it for
	 * something the author of the workflow cannot act on.
	 */
	async #delegate(
		spec: SubtaskSpec,
		signal: AbortSignal | undefined,
	): Promise<SubtaskResult> {
		const external = spec.signal ?? signal ?? this.#options.signal;
		while (this.#active >= this.#options.maxConcurrency) {
			if (external?.aborted)
				return this.#failed(
					spec,
					external.reason instanceof Error
						? external.reason
						: new Error("aborted"),
				);
			await new Promise((resolve) =>
				setTimeout(resolve, DELEGATE_SLOT_POLL_MS),
			);
		}
		return this.run(spec);
	}

	async #execute(spec: SubtaskSpec): Promise<SubtaskResult> {
		const startedAt = Date.now();
		const isolation = this.#options.isolation ?? sharedWorkspaceIsolation();
		let handle: IsolationHandle | undefined;
		try {
			handle = await isolation.prepare({
				id: spec.id ?? "",
				title: spec.title,
				task: spec.task,
			});
			const child = await this.#runChild(spec, handle);
			const artifact = handle.collect ? await handle.collect() : undefined;
			// An artifact too large to inline is only useful if someone can still go
			// look at it, so a truncated diff retains the workspace it came from.
			const retain =
				artifact !== undefined && artifact.diff.length > this.#diffLimit();
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

	async #runChild(
		spec: SubtaskSpec,
		handle: IsolationHandle,
	): Promise<Omit<SubtaskResult, "durationMs" | "workspace" | "artifact">> {
		const options = this.#options;
		const controller = new AbortController();
		const timeoutMs = options.taskTimeoutMs ?? DEFAULT_TASK_TIMEOUT_MS;
		const timer =
			timeoutMs > 0
				? setTimeout(
						() =>
							controller.abort(
								new DOMException("Delegated task timed out", "TimeoutError"),
							),
						timeoutMs,
					)
				: undefined;
		const external = spec.signal ?? options.signal;
		const onExternalAbort = () => controller.abort(external?.reason);
		external?.addEventListener("abort", onExternalAbort, { once: true });

		const run = runAgent({
			model:
				typeof options.model === "function" ? options.model() : options.model,
			system: [
				options.system,
				"\nDelegated subtask boundaries:",
				`- Assignment: ${spec.title}`,
				"- Work only on the assigned subtask and its acceptance criteria.",
				...handle.boundaryNotes,
			].join("\n"),
			prompt: spec.task,
			tools: (spec.createTools ?? options.createTools)(handle.cwd),
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
				options.onEvent?.({
					type: "subtask-event",
					id: spec.id ?? "",
					title: spec.title,
					event,
				});
			}
		})();

		try {
			const settled = await Promise.allSettled([run.result, consume]);
			const runResult = settled[0];
			if (runResult?.status === "rejected") throw runResult.reason;
			const eventFailure = settled[1];
			if (eventFailure?.status === "rejected") throw eventFailure.reason;
			const result =
				runResult.status === "fulfilled" ? runResult.value : undefined;
			if (!result) throw new Error("child task produced no result");
			return {
				id: spec.id ?? "",
				title: spec.title,
				status: result.reason,
				steps: result.steps,
				toolCalls,
				usage: result.usage,
				text: result.text,
				...(result.reason === "error"
					? { error: result.text || "child task failed" }
					: {}),
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
		return Math.max(
			1_000,
			Math.floor(this.#options.maxDiffChars ?? DEFAULT_MAX_DIFF_CHARS),
		);
	}
}

/**
 * System-prompt guidance for a parent that owns an orchestrator.
 *
 * Kept here rather than in each caller's prompt because the constraints are
 * properties of the mechanism: a child works from a snapshot taken when it
 * starts, and its diff is never applied automatically. A parent that does not
 * know both will delegate dependent work and then apply a diff to a tree it has
 * since moved.
 *
 * The snapshot is the reason this guidance does not carry the old "a child
 * cannot see uncommitted parent work" restriction. It used to, and that single
 * sentence made delegation almost never fire: a live agent session has
 * uncommitted work by definition, so "delegate only what does not depend on
 * your uncommitted changes" excluded nearly every real task. The remaining
 * caveat is the one that is actually true — the snapshot is frozen at start, so
 * a child cannot see parent edits made after it began.
 */
export const orchestratorPrompt = (
	opts: { concurrency?: number; isolation?: string } = {},
): string => {
	const lines = [
		"Delegated subtasks:",
		`- A child starts from a snapshot of your working state taken when it starts, in its own ${opts.isolation ?? "workspace"} isolation, so it can build on the work you have already done. Anything you change after that point is not in its snapshot.`,
		"- A child's changes are never merged automatically. Review its diff and integrate deliberately.",
		"- Children do not share history. State the task, the boundaries, and the acceptance criteria in the assignment itself.",
	];
	if (opts.concurrency !== undefined) {
		lines.push(
			`- At most ${opts.concurrency} children run at once; further delegations are refused until one finishes.`,
		);
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
export const formatSubtaskReport = (
	result: SubtaskResult,
	opts: { maxReportChars?: number } = {},
): string => {
	const artifact = result.artifact;
	const metrics =
		result.status === "error" && result.steps === 0
			? `status: error; steps: 0; tool calls: 0; elapsed: ${result.durationMs}ms; error: ${result.error ?? "child task failed"}`
			: `status: ${result.status}; steps: ${result.steps}; tool calls: ${result.toolCalls}; tokens: ${result.usage.inputTokens} in / ${result.usage.outputTokens} out / ${result.usage.totalTokens} total; estimated usage: ${result.usage.estimated === true}; elapsed: ${result.durationMs}ms`;
	const limit = Math.max(0, opts.maxReportChars ?? DEFAULT_MAX_REPORT_CHARS);
	return [
		`Delegated task: ${result.title}`,
		...(artifact?.baseRevision
			? [`Base revision: ${artifact.baseRevision}`]
			: []),
		metrics,
		...(artifact
			? [
					`Changed paths: ${artifact.changedPaths.length ? artifact.changedPaths.join(", ") : "none"}`,
				]
			: []),
		...(artifact
			? ["Review this diff before applying any of it:", artifact.diff]
			: []),
		result.error ? `Child error: ${result.error}` : "",
		result.text
			? `Child report:\n${limit ? result.text.slice(0, limit) : result.text}`
			: "",
	]
		.filter(Boolean)
		.join("\n\n");
};

/** Default isolation: children share the caller's workspace and are given no isolation. */
export const sharedWorkspaceIsolation = (): SubtaskIsolation => ({
	description: "shared workspace",
	prepare: async () => ({
		cwd: ".",
		boundaryNotes: [
			"- You share a workspace with the parent agent. Coordinate through files, and keep to your assignment.",
		],
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
	/**
	 * Branch children from a snapshot of the parent's working tree rather than
	 * from `HEAD`. On by default; set false for the original strict behaviour.
	 */
	snapshotParentChanges?: boolean;
};

/**
 * Isolation by detached Git worktree.
 *
 * The property that matters: the child gets its own checkout, so two children
 * cannot collide and a child cannot half-apply over a parent edit in progress.
 *
 * It branches from a snapshot of the parent's working tree rather than from
 * `HEAD`, because a live agent session almost always has uncommitted work —
 * that is what it just produced. Branching from `HEAD` made the parent's
 * in-flight changes invisible to every child, which made almost every real task
 * undelegable: the model was told to delegate only work that did not depend on
 * its uncommitted changes, and in practice everything did. The snapshot is
 * built through a temporary index, so the parent's real index and working tree
 * are never touched and nothing is stashed.
 *
 * `boundaryNotes` still names the paths, because "included" is not "live": the
 * snapshot is frozen at the moment the child starts, so parent edits made after
 * that are genuinely invisible and the child must not expect them.
 */
export const createGitWorktreeIsolation = (
	options: GitWorktreeIsolationOptions,
): SubtaskIsolation => {
	const runGit = async (cwd: string, args: string[], env?: Record<string, string>) => {
		const result = await execFileAsync("git", args, {
			cwd,
			maxBuffer: 8 * 1024 * 1024,
			encoding: "utf8",
			...(env ? { env: { ...process.env, ...env } } : {}),
		});
		return { stdout: result.stdout, stderr: result.stderr };
	};

	/**
	 * The committer the snapshot commit is authored by.
	 *
	 * `git commit-tree` refuses to run without a resolvable identity, and a
	 * repository can be perfectly usable with none configured — CI checkouts and
	 * fresh clones routinely are. Supplying it here means the snapshot does not
	 * add a failure mode that plain `HEAD` branching never had.
	 */
	const SNAPSHOT_IDENTITY = {
		GIT_AUTHOR_NAME: "nah",
		GIT_AUTHOR_EMAIL: "nah@localhost",
		GIT_COMMITTER_NAME: "nah",
		GIT_COMMITTER_EMAIL: "nah@localhost",
	};

	/**
	 * Freeze the parent's working tree into a commit, without touching it.
	 *
	 * `GIT_INDEX_FILE` redirects the index so `add --all` stages the parent's real
	 * state — including untracked files, which are usually the new ones a child
	 * most needs to see — into a throwaway index. `git stash` was the obvious
	 * alternative and is the wrong tool: it mutates the parent's working tree to
	 * take the snapshot, so a crash mid-delegation would leave the user's
	 * uncommitted work sitting in a stash.
	 *
	 * The commit is a child of `HEAD` so `git worktree add` and `git diff` treat it
	 * as an ordinary revision, and it is parented on `HEAD` rather than replacing
	 * it so the snapshot never moves the repository's own history.
	 */
	const writeSnapshotCommit = async (repositoryRoot: string, indexFile: string) => {
		await runGit(repositoryRoot, ["add", "--all", "."], {
			GIT_INDEX_FILE: indexFile,
			...SNAPSHOT_IDENTITY,
		});
		const tree = (
			await runGit(repositoryRoot, ["write-tree"], { GIT_INDEX_FILE: indexFile })
		).stdout.trim();
		const head = (await runGit(repositoryRoot, ["rev-parse", "HEAD"])).stdout.trim();
		const commit = (
			await runGit(
				repositoryRoot,
				["commit-tree", tree, "-p", head, "-m", "nah delegation snapshot"],
				SNAPSHOT_IDENTITY,
			)
		).stdout.trim();
		return commit;
	};

	return {
		description: "temporary Git worktree",
		prepare: async () => {
			// A caller-supplied `tmpRoot` is a directory it expects to exist, but the
			// default OS temp dir always does, so neither is guaranteed. `git worktree
			// add` and the temp index both need the parent to be there already.
			const tmpRoot = options.tmpRoot ?? tmpdir();
			await mkdir(tmpRoot, { recursive: true });
			const worktree = nodePath.join(
				tmpRoot,
				`nah-delegate-${randomUUID()}`,
			);
			const repositoryRoot = (
				await runGit(options.cwd, ["rev-parse", "--show-toplevel"])
			).stdout.trim();
			const parentStatus = (
				await runGit(repositoryRoot, [
					"status",
					"--porcelain=v1",
					"-z",
					"--untracked-files=all",
				])
			).stdout;
			const parentChangedPaths = parentStatus
				.split("\0")
				.filter(Boolean)
				.map((entry) => entry.slice(3));
			const snapshotIndex =
				options.snapshotParentChanges === false || parentChangedPaths.length === 0
					? undefined
					: nodePath.join(
							tmpRoot,
							`nah-delegate-index-${randomUUID()}`,
						);
			/**
			 * Freeze the parent's working tree into a commit, without touching it.
			 *
			 * `GIT_INDEX_FILE` redirects the index so `add -A` stages the parent's
			 * real state — including untracked files, which are usually the new ones
			 * a child most needs to see — into a throwaway index. `git stash` was the
			 * obvious alternative and is the wrong tool: it mutates the parent's
			 * working tree to take the snapshot, so a crash mid-delegation would
			 * leave the user's uncommitted work sitting in a stash.
			 */
			const baseRevision = snapshotIndex
				? await writeSnapshotCommit(repositoryRoot, snapshotIndex)
				: (await runGit(repositoryRoot, ["rev-parse", "HEAD"])).stdout.trim();
			await runGit(repositoryRoot, [
				"worktree",
				"add",
				"--detach",
				worktree,
				baseRevision,
			]);

			return {
				cwd: worktree,
				baseRevision,
				boundaryNotes: [
					...(parentChangedPaths.length
						? [
								snapshotIndex
									? `- The parent's uncommitted working state is included in this worktree (${parentChangedPaths.join(", ")}), so you can build on it. It was frozen when this child started, so anything the parent changes after that is not here.`
									: `- The parent has uncommitted changes in: ${parentChangedPaths.join(", ")}. They are not present here; do not depend on them.`,
							]
						: []),
					"- This is an isolated worktree. Do not attempt to access or modify the parent worktree.",
					"- Do not commit changes. Inspect and validate your changes when practical, then report what changed and any check results.",
					"- The parent agent will review your diff and decide whether to integrate it.",
				],
				collect: async (): Promise<SubtaskArtifact> => {
					const statusOutput = (
						await runGit(worktree, [
							"status",
							"--porcelain=v1",
							"--untracked-files=all",
						])
					).stdout;
					if (statusOutput.trim())
						await runGit(worktree, ["add", "--intent-to-add", "--", "."]);
					const changedPaths = (
						await runGit(worktree, [
							"diff",
							"--name-only",
							"-z",
							baseRevision,
							"--",
						])
					).stdout
						.split("\0")
						.filter(Boolean);
					const diff = (
						await runGit(worktree, [
							"diff",
							"--no-ext-diff",
							"--no-color",
							"--no-renames",
							baseRevision,
							"--",
						])
					).stdout;
					return { baseRevision, changedPaths, diff, workspace: worktree };
				},
				cleanup: async ({ retain }) => {
					// The temp index is ours alone and never useful after the child starts,
					// so it goes even when the worktree is retained for inspection.
					if (snapshotIndex) {
						try {
							await rm(snapshotIndex, { force: true });
						} catch {
							// A leftover index file in the temp directory is inert.
						}
					}
					if (retain || options.retain) return;
					try {
						await runGit(repositoryRoot, [
							"worktree",
							"remove",
							"--force",
							worktree,
						]);
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
