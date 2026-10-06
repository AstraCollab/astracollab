import type { LanguageModel, ModelMessage } from "ai";
import type { CacheAccounting } from "./cache.js";
import type { ModelRates } from "./spend.js";

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
	/**
	 * A caller's own rule ended the run.
	 *
	 * Its own reason rather than a reuse of `no-progress` or `max-steps`, because
	 * both of those mean something specific and neither is true here: the caller
	 * usually knows exactly which loop it caught, and a report saying "max-steps"
	 * for a domain rule sends whoever reads the trace looking for a ceiling nobody
	 * set.
	 */
	| "stopped-by-caller"
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
	/**
	 * A tool asked for approval and is waiting for a decision.
	 *
	 * Its own reason because the run is not finished, merely paused — and the two
	 * need opposite handling. A caller that persists on `completed` and resumes on
	 * anything else would treat this as an error, and one that treats every
	 * non-`completed` reason as an error would report a normal approval prompt as a
	 * failure to the user.
	 *
	 * The run stops here **by necessity**: the SDK emits no tool result for a blocked
	 * call, so continuing would send the next request with a `tool-call` and no
	 * matching result and fail outright. Suspending is the only valid move, not a
	 * policy choice.
	 */
	| "awaiting-approval"
	/**
	 * A tool called {@link toolSuspend} and is waiting for a value.
	 *
	 * Distinct from `awaiting-approval` because the two are answered differently and
	 * fail differently. Approval has a boolean answer and is a permission question —
	 * the tool has not run and may never. Suspension carries an **open-ended typed
	 * value** the tool defines, and the tool *has* run: it got far enough to decide it
	 * needed something. A caller that treats them alike answers a question with
	 * `approved: true` and the tool gets a boolean where it expected text.
	 *
	 * Same necessity as `awaiting-approval`: a suspended tool produced no result, so
	 * continuing would send the next request with a `tool-call` and no matching result.
	 */
	| "suspended"
	| "aborted"
	| "error";

/**
 * A tool call held for a human decision.
 *
 * Carries the `approvalId` the SDK generated, which is the only thing that can
 * answer it later: the response is a message part referencing that id, and a
 * `toolCallId` is not enough to build one.
 */
export type PendingApproval = {
	approvalId: string;
	toolCallId: string;
	toolName: string;
	/** The call's arguments, so a UI can describe what is being approved. */
	input: unknown;
	/** Why the gate fired, when the gate supplied one. */
	reason?: string;
};

/**
 * Answers to held calls, keyed by `approvalId`.
 *
 * Handed back with the transcript — see {@link HarnessRunOptions.toolApproval} and
 * the README's approval section for the round-trip. Exported so a caller persists
 * decisions in the same place it persists the transcript, which is what keeps a
 * resumed run from asking again about something the user already answered.
 *
 * Named for what it is rather than `ApprovalDecision`, which
 * {@link createCodingTools} already uses for a different mechanism entirely: a
 * synchronous in-process gate returning `"allow" | "deny"` before a mutating tool
 * runs. Nothing round-trips through a transcript there, and a caller who reached
 * for the wrong one would get neither behaviour they expected. See
 * {@link HarnessRunOptions.toolApproval} for this one.
 */
export type ToolApprovalAnswers = Record<
	string,
	{ approved: boolean; reason?: string }
>;

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

export type WorkspaceRestoreResult = {
	restoredPaths: string[];
	conflicts: string[];
};

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
	| {
			type: "tool-call";
			step: number;
			toolCallId: string;
			toolName: string;
			input: unknown;
	  }
	| {
			type: "tool-result";
			step: number;
			toolCallId: string;
			toolName: string;
			/** Text form of the (already output-capped) result. */
			output: string;
			isError: boolean;
	  }
	| {
			/**
			 * A tool is waiting for a decision.
			 *
			 * The call is **not** running and will not until the transcript carries a
			 * decision for `approvalId` — so a consumer that renders only `tool-call`
			 * and `tool-result` shows a call that hangs forever. That is the same shape
			 * of bug as an unmapped `tool-error`: a part the loop drops, so the thing
			 * it meant to report is invisible.
			 */
			type: "tool-approval-request";
			step: number;
			approvalId: string;
			toolCallId: string;
			toolName: string;
			input: unknown;
			reason?: string;
			/**
			 * True when the gate decided this without asking anyone — `toolApproval`
			 * returned `approved` or `denied`, or the tool declared no approval needed.
			 * Nothing is waiting, so a UI must not prompt. The event is still emitted,
			 * because a decision nobody made is worth logging and the pairing with
			 * `tool-approval-response` is what makes an audit trail readable.
			 */
			isAutomatic: boolean;
	  }
	| {
			/**
			 * A tool parked itself and is waiting for a value.
			 *
			 * The tool *ran*, and got far enough to decide it needed something — which
			 * is what separates this from `tool-approval-request`, where the tool has
			 * not run at all. A UI shows a question rather than a confirm button.
			 *
			 * There is no result for this call, exactly as for a held approval, so the
			 * run stops rather than continuing into a request the provider would
			 * reject.
			 */
			type: "tool-suspended";
			step: number;
			toolCallId: string;
			toolName: string;
			/** What the tool needs. Its shape is the tool's, not the harness's. */
			payload: unknown;
			input?: unknown;
	  }
	| {
			/**
			 * A parked call was answered and its tool re-ran.
			 *
			 * The explicit "answered" signal. Deliberately **not** inferred from the
			 * shape of the tool's output: under a delegating tool the output is the
			 * delegate's result, not the answer, so a heuristic reads as a resumed run
			 * that never resumed.
			 */
			type: "tool-resumed";
			step: number;
			toolCallId: string;
			toolName: string;
	  }
	| {
			/**
			 * A held call was answered.
			 *
			 * Fires when the decision reaches the SDK, which on a resumed run is the
			 * moment the tool executes or is denied — so this is the event that means
			 * "the user decided", where the request above means "we asked".
			 */
			type: "tool-approval-response";
			step: number;
			approvalId: string;
			toolCallId: string;
			approved: boolean;
			reason?: string;
	  }
	| {
			type: "step-finish";
			step: number;
			usage: HarnessUsage;
			request: HarnessRequestBreakdown;
	  }
	| {
			type: "compacted";
			droppedMessages: number;
			keptMessages: number;
			summaryChars: number;
	  }
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
	| {
			type: "finish";
			reason: HarnessStopReason;
			text: string;
			usage: HarnessUsage;
	  }
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
	readdir(
		dir: string,
	): Promise<Array<{ name: string; type: "file" | "directory" }>>;
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
	restoreSnapshot?(
		before: WorkspaceSnapshot,
		after: WorkspaceSnapshot,
		paths: string[],
	): Promise<WorkspaceRestoreResult>;
}

export type HarnessCompactionMode = "model" | "truncate" | "off";

/**
 * Per-tool values handed to tool execution as `options.context`.
 *
 * **Keyed by tool name**, because that is the SDK's contract, not a convenience:
 * `executeToolCall` reads `toolsContext[toolName]` for the call it is about to run
 * and nothing else. A single shared object (`{ actor }` instead of
 * `{ read: { actor } }`) is not "not supported" — it is simply read as the context
 * of a tool named `actor`, so every real tool gets `undefined` and the mistake is
 * invisible.
 *
 * A tool that declares a `contextSchema` has its slice validated on every call, so
 * a typo in a key becomes an error at the tool boundary instead of a missing value
 * deep inside a tool's own logic. Tools that declare nothing get the value as-is.
 *
 * Prefer closing over a value that is fixed for the turn: a closure cannot be read
 * by another turn's tool, and it needs no map. This exists for the value that a
 * closure cannot hold — one that changes *per step* — and for keeping a tool's
 * implementation free of the request's identity.
 */
export type ToolContextMap = Readonly<Record<string, unknown>>;

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
	 * repeated re-sending of the transcript does not inflate the trigger.
	 *
	 * Defaults to 80% of `maxContextTokens` less a summary reserve, or 120_000
	 * when no window is stated — so setting the window alone is enough to get a
	 * trigger that fits the model.
	 *
	 * The high trigger is deliberate: compaction is lossy, and the research on
	 * constraint decay is unambiguous that a single compaction can drop
	 * invariants the agent was relying on. Compact late, and keep cheap
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
	onStepStart?: (
		step: number,
		messages: ModelMessage[],
	) => void | Promise<void>;
	onStepFinish?: (
		step: number,
		messages: ModelMessage[],
	) => void | Promise<void>;
	/**
	 * Adjust each step before its model call.
	 *
	 * `onStepStart` is a notification: it receives a copy and its return value is
	 * discarded, so it cannot change what the step does. This one can.
	 */
	prepareStep?: PrepareStep;
	/**
	 * End the run when this returns true.
	 *
	 * Runs after each step, alongside the harness's own guards and before them, so
	 * a caller rule that fires explains the stop rather than being reported as a
	 * generic one.
	 */
	shouldStop?: ShouldStop;
	/**
	 * Tool choice for every step.
	 *
	 * Overridden per step by `prepareStep`. Left undefined, the provider default
	 * applies — which for most providers is "auto", and is why an agent that must
	 * act sometimes answers in prose instead.
	 */
	toolChoice?: StepToolChoice;
	/**
	 * Values handed to tools as `options.context`, keyed by tool name.
	 *
	 * See {@link ToolContextMap} for the keying rule and for why a per-turn value
	 * belongs in a closure instead.
	 */
	toolsContext?: ToolContextMap;
	/**
	 * Which tools need a human to agree before they run.
	 *
	 * Pass the SDK's own shape — `{ deleteFile: "user-approval" }`, or a function per
	 * tool that decides from the call, or one function for every tool. Anything not
	 * named here runs unattended, which is why this defaults to nothing rather than to
	 * a safe default: a harness cannot know which of its tools are destructive, and a
	 * gate that silently approved everything would be worse than no gate, because it
	 * would look deliberate.
	 *
	 * A call held here **ends the run** with reason `awaiting-approval`. Not a policy
	 * choice — the SDK emits no tool result for a blocked call, so the next request
	 * would carry a `tool-call` with no matching result and be rejected. To continue:
	 * persist the transcript, add a `tool` message holding a
	 * `{ type: "tool-approval-response" }` part per decision, and call `runAgent`
	 * again with it. The gate can stay configured; a call that already has a decision
	 * in the transcript is not asked about twice.
	 *
	 * @see ToolApprovalAnswers
	 */
	toolApproval?: unknown;
	/**
	 * Resume values for parked tool calls, keyed by `toolCallId`.
	 *
	 * Paired with a transcript that ends in a `tool` message holding the same keys,
	 * because the SDK reads tool-message content to decide what to execute. This
	 * option exists so a caller can pass the answer *and* the transcript from one
	 * place, rather than hand-assembling the message part and hoping the two agree —
	 * a mismatch is silent, and the tool simply waits forever.
	 *
	 * A `toolCallId` that is not parked is ignored, and a parked call with no entry
	 * re-suspends. Both are ordinary: a stale resume is a UI double-click, not a bug.
	 *
	 * **Keyed by `toolCallId`, not by approval id.** The two differ — the approval id
	 * is generated per approval and the call id is the model's — and the value is put
	 * into the tool's own context, which is keyed by the call being re-run. A map keyed
	 * by approval id compiles, satisfies every type, and silently delivers nothing: the
	 * call is released, the tool re-runs, and it sees no answer. Found by driving the
	 * whole round trip rather than by reading either half.
	 */
	toolResumeData?: Record<string, unknown>;
	/** Pinned onto every {@link PendingSuspension}, for cross-thread resume safety. */
	suspensionScope?: { threadId?: string; resourceId?: string };
	/**
	 * Treat the next user message as the answer to any parked call.
	 *
	 * Makes `ask_user` a conversation rather than a form: someone who reads "Which
	 * environment?" and replies "staging" continues the run, instead of the harness
	 * asking again because no one clicked.
	 *
	 * **Off by default, and the default is the point.** A wrong auto-resume silently
	 * continues a run on a value nobody chose — the tool executes against a reply that
	 * was never an answer. Only a caller who has decided that an unrecognised reply
	 * should proceed rather than re-ask should turn it on.
	 *
	 * The answer is the message verbatim. No model decides whether it answers the
	 * question: a model can refuse or hedge, for something a human has already said
	 * plainly.
	 */
	autoResumeSuspensions?: boolean;
};

/**
 * A tool call parked by {@link toolSuspend}, waiting for a value.
 *
 * Carries the `toolCallId` because that is how a resume is routed — the answer is
 * delivered by tool call, not by tool name, so two suspended calls to the same tool
 * stay independent. The `payload` is whatever the tool suspended with: the shape is
 * the tool's business, not the harness's, so it is carried as `unknown` and rendered
 * by whoever knows what it means.
 */
export type PendingSuspension = {
	toolCallId: string;
	toolName: string;
	/** What the tool needs, verbatim. */
	payload: unknown;
	/** The tool's input, so a UI can describe the call the question belongs to. */
	input?: unknown;
	/**
	 * `threadId`/`resourceId` are pinned here rather than read at resume time.
	 *
	 * A session can switch threads while a call is parked, so a resume that looks up
	 * "the current thread" can answer a question into a different conversation. Both
	 * are what the caller passed to the run that parked this; a caller resuming a
	 * suspended call should check them against the run it is about to resume.
	 */
	threadId?: string;
	resourceId?: string;
};

/**
 * Park the current tool call until it is given `resumeData`.
 *
 * The AI SDK has no equivalent — there is no suspension primitive in it at all — so
 * this is the harness's own. It follows Mastra's semantics, which are the ones a
 * client already knows:
 *
 * - **It throws.** Not returns, not returns a sentinel: a tool that continues past a
 *   suspend has already answered, and the alternative is a flag every caller must
 *   remember to check.
 * - **The tool is re-run from the top on resume, statelessly.** There is no coroutine
 *   and no parked stack frame. A suspended tool checks for resume data first and
 *   returns it, and suspends again otherwise. That is the entire round trip, and it
 *   is why a tool built this way must not do work before suspending: the work happens
 *   twice.
 * - **Not re-entering the approval gate on resume.** The resume schema of an askable
 *   tool is rarely able to carry an `{ approved }` field, so re-checking approval
 *   would reject the answer.
 *
 * @param payload anything the tool needs to render its request and to interpret the
 * answer. Validated by nobody: the shape belongs to the tool.
 */
export type ToolSuspend = (payload: unknown) => never;

/**
 * The per-call half of a tool's execution context.
 *
 * Passed alongside whatever the caller's own tool context carries, so a tool
 * written for `toolsContext` and a tool written for suspension can coexist in one
 * tool set without either knowing about the other.
 */
export type ToolCallScope = {
	/** Park this call. Only present while an `askable` tool set is installed. */
	suspend?: ToolSuspend;
	/**
	 * The value supplied for this call, if it is being resumed.
	 *
	 * `undefined` on a first run **and** on a resume where the caller supplied
   * nothing, which are different situations. A tool that can suspend must therefore
   * decide on something else — which is what `suspendPayload` is for.
	 */
	resumeData?: unknown;
	/** Why this call was parked, on a resume. Lets the tool re-suspend identically. */
	suspendPayload?: unknown;
	/** This call's id, for routing a resume. */
	toolCallId: string;
};

export type HarnessRunResult = {
	text: string;
	reason: HarnessStopReason;
	steps: number;
	usage: HarnessUsage;
	/**
	 * The transcript after the run.
	 *
	 * **Post-compaction, and not an append-only delta.** When `compactions > 0`
	 * this array is a summary plus a recent tail: its length is unrelated to how
	 * many messages were added, and it shares no reliable prefix with the input. So
	 * `result.messages.slice(before)` is not "the new messages" — it silently
	 * returns the wrong ones, and a store that appends them loses history without
	 * erroring.
	 *
	 * Use `sessionUpdate(before, result)`, which decides append-vs-replace for you,
	 * or check `compactions` yourself.
	 */
	messages: ModelMessage[];
	/** Number of compactions performed during the run. */
	compactions: number;
	/** True when the run was ended by a wrap-up step rather than cut off. */
	wrappedUp: boolean;
	/**
	 * Calls waiting for a decision, empty unless `reason` is `awaiting-approval`.
	 *
	 * On the result rather than only on the event stream, because the two answer
	 * different questions and a resuming caller needs the second one: the event says a
	 * request happened, and this says what is still outstanding **after** the run
	 * stopped. A caller resuming from a persisted transcript has no event stream to
	 * replay, so a request that was already answered — by a decision appended to the
	 * transcript before the resume — would otherwise be prompted for a second time.
	 * Filter by what the transcript has not already decided.
	 */
	pendingApprovals: PendingApproval[];
	/**
	 * Calls parked by {@link toolSuspend}, empty unless `reason` is `suspended`.
	 *
	 * The resume-side counterpart to `pendingApprovals`, and it answers a different
	 * question: not "was anything asked" but "what is still unanswered". A caller
	 * resuming from a persisted transcript has no event stream to replay, so this is
	 * how it learns what is outstanding.
	 */
	pendingSuspensions: PendingSuspension[];
};

/**
 * Build the `tool` message that answers held calls.
 *
 * Exists because the round-trip is not guessable: the SDK matches a decision to its
 * request by `approvalId`, and nothing in the transcript says which ids are still
 * open. Assembling the part by hand is where a resumed run goes wrong — a
 * mismatched id is rejected outright, and a *missing* one is the dangerous case,
 * because the tool silently stays blocked and the run waits forever for a decision
 * that was already made.
 *
 * ```ts
 * const { messages, pendingApprovals } = await run.result;
 * // … user approves "deleteFile", denies the rest …
 * const resumed = runAgent({
 *   model, system, tools,
 *   toolApproval: { deleteFile: "user-approval" },
 *   messages: appendApprovalResponses(messages, { [pendingApprovals[0].approvalId]: { approved: true } }),
 * });
 * ```
 *
 * Decisions for ids that are not pending are ignored rather than rejected: the caller
 * may hold a decision made against a transcript that has since been compacted, and
 * dropping it would re-ask a question the user already answered.
 */
export const appendApprovalResponses = (
	messages: readonly ModelMessage[],
	decisions: ToolApprovalAnswers,
): ModelMessage[] => {
	const open = new Set<string>();
	for (const message of messages) {
		if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
		for (const part of message.content as Array<Record<string, unknown>>) {
			if (part.type === "tool-approval-request" && typeof part.approvalId === "string") {
				open.add(part.approvalId);
			}
		}
	}
	for (const message of messages) {
		if (message.role !== "tool" || !Array.isArray(message.content)) continue;
		for (const part of message.content as Array<Record<string, unknown>>) {
			if (part.type === "tool-approval-response" && typeof part.approvalId === "string") {
				open.delete(part.approvalId);
			}
		}
	}
	const parts = Object.entries(decisions)
		.filter(([approvalId]) => open.has(approvalId))
		.map(([approvalId, decision]) => ({
			type: "tool-approval-response" as const,
			approvalId,
			approved: decision.approved,
			...(decision.reason === undefined ? {} : { reason: decision.reason }),
		}));
	if (parts.length === 0) return [...messages];
	return [...messages, { role: "tool", content: parts } as unknown as ModelMessage];
};

/**
 * How a store should be brought up to date with a finished run.
 *
 * `append` is the common case and the cheap one. `replace` is not an error
 * condition — it is what compaction *means*, and a store that cannot represent
 * "the transcript was summarised" has to take the whole thing or lose history.
 */
export type SessionUpdate =
	| { mode: "append"; messages: ModelMessage[] }
	| { mode: "replace"; messages: ModelMessage[] };

/**
 * Decide how to persist a finished run.
 *
 * The decision lives here because every caller otherwise re-derives it, and the
 * wrong derivation is silent: appending a compacted transcript does not throw, it
 * just quietly loses the middle of a conversation.
 *
 * @param before the transcript length before the run started, or the transcript
 * itself. Passing the array is safer, because a caller that holds a mutated
 * reference cannot get the count wrong.
 */
export const sessionUpdate = (
	before: number | readonly ModelMessage[],
	result: Pick<HarnessRunResult, "messages" | "compactions">,
): SessionUpdate => {
	const beforeCount = typeof before === "number" ? before : before.length;
	if (result.compactions > 0 || result.messages.length < beforeCount) {
		return { mode: "replace", messages: result.messages };
	}
	return { mode: "append", messages: result.messages.slice(beforeCount) };
};

/**
 * Tool choice for one step.
 *
 * Mirrors the AI SDK's vocabulary so a value can be handed straight through,
 * named here because `toolChoice` is the option and this is the value.
 */
export type StepToolChoice =
	| "auto"
	| "none"
	| "required"
	| { type: "tool"; toolName: string };

/** Per-step overrides for the model call. Omitted fields fall back to the run's. */
export type StepOverrides = {
	/**
	 * Replaces the run's tool context for **this step only**.
	 *
	 * Every other override here is per step too, and this one used to read as
	 * though it carried forward ("this step and every step after it"). It does not:
	 * a step that returns nothing falls back to the run's `toolsContext`, so a value
	 * that has to advance — a step counter, a deadline — has to be recomputed from
	 * `PrepareStepContext.stepNumber` each time rather than read off the last
	 * override. That is the same discipline as `stepCallSignatures`: per-step state
	 * is derived at the step boundary, never carried in a variable declared outside
	 * the loop.
	 *
	 * The reason it exists rather than a closure: a value that varies *per step* —
	 * the step number, a deadline, the text of the step so far — cannot be captured
	 * when the tools are built, because the tools are built once. A value that
	 * varies per *turn* should still be a closure, which is simpler and cannot be
	 * read by the wrong turn.
	 *
	 * Keyed by tool name; see {@link ToolContextMap}.
	 */
	toolsContext?: ToolContextMap;
	/**
	 * `required` forces a tool call this step, which is how a caller stops a model
	 * that answers in prose when the task needs the filesystem.
	 */
	toolChoice?: StepToolChoice;
	temperature?: number;
	maxOutputTokens?: number;
	/** A different model for this step only. */
	model?: LanguageModel;
};

export type PrepareStepContext = {
	/** 1-based, matching the `step-start` event and `onStepStart`. */
	stepNumber: number;
	/** The transcript as it stands, before this step. A copy — mutating it does nothing. */
	messages: readonly ModelMessage[];
	/**
	 * Tool calls made in each completed step of this run.
	 *
	 * Present because "force a tool until one has happened" is the common rule, and
	 * answering it needs to know what already ran rather than re-reading messages.
	 */
	steps: ReadonlyArray<{ step: number; toolNames: readonly string[] }>;
};

/**
 * Adjust a step before its model call.
 *
 * Returning nothing leaves the step on the run's settings. Throwing ends the run,
 * which is deliberate: a hook that fails while deciding whether to require a tool
 * would otherwise be indistinguishable from one that decided not to.
 */
export type PrepareStep = (
	context: PrepareStepContext,
) => StepOverrides | undefined | Promise<StepOverrides | undefined>;

/**
 * Decide whether the run should end, after a step.
 *
 * The harness's own guards measure generic things — steps, spend, whether
 * anything changed. They cannot see what a *particular* agent does when it is
 * lost: verifying git over and over, calling a tool that does not exist,
 * restating the same failure, declaring itself finished repeatedly. That
 * knowledge belongs to the caller, and without a hook the only way to express it
 * is to give up and run the loop yourself.
 *
 * The context is the same shape {@link PrepareStep} receives, deliberately: one
 * vocabulary for "change this step" and "end this run", so a rule spanning both
 * is not written twice.
 *
 * Returning `undefined` or `false` continues. Throwing ends the run as an error,
 * so a rule that cannot decide fails loudly rather than quietly not firing.
 *
 * Called after each step completes, and never before the first one — a rule that
 * inspects step history has nothing to inspect on step 1, and firing there would
 * stop every run.
 */
export type ShouldStop = (
	context: PrepareStepContext,
) => boolean | undefined | Promise<boolean | undefined>;

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
