import { getErrorMessage, type SharedV2ProviderOptions } from "@ai-sdk/provider";
import {
	type ModelMessage,
	type ToolChoice,
	type ToolSet,
	stepCountIs,
	streamText,
} from "ai";

import {
	cacheOptions,
	contextManagementOptions,
	supportsCaching,
	withCachedTail,
	withCachedToolSchemas,
} from "./cache.js";
import { compactMessages } from "./compaction.js";
import { createStepDedupe } from "./dedupe.js";
import { estimateMessageTokens, estimateRequestTokens } from "./estimate.js";
import { pruneOldToolResults } from "./prune.js";
import { createReadCoverage } from "./read-coverage.js";
import { createSpendMeter, usageCostUsd } from "./spend.js";
import type {
	HarnessEvent,
	HarnessRun,
	HarnessRunOptions,
	HarnessRunResult,
	HarnessSteerDelivery,
	HarnessStopReason,
	HarnessUsage,
	PendingApproval,
	StepOverrides,
} from "./types.js";

/**
 * No step ceiling, by default.
 *
 * It used to be 32, which is not a number anyone chose from evidence — it is a
 * round number that was low enough to feel safe. It bound the *long* tasks and
 * ignored the short ones: across fifteen recorded turns, the median finished in
 * 15 steps and the largest natural completion was 30, while 20% of turns were
 * truncated at the cap. That is the shape of a limit that fires on task length
 * rather than on anything wrong with the run.
 *
 * A real task was cut by it. Resolving a git merge conflict took 27 shell calls
 * — merge-base archaeology, a safety branch, a commit, the merge itself,
 * `checkout --ours` across the conflicts, an install, a `git rm` — and stopped at
 * 32 having done none of the verification, with the model reporting "I ran out
 * of budget before verification, so I stopped rather than push an unverified
 * merge". Its context was 32k with a 99% cache hit rate. Nothing was under
 * pressure; the counter simply ran out.
 *
 * The three mature harnesses agree. Claude's Agent SDK documents `maxTurns` with
 * a default of "No limit" and says "without limits, the loop runs until Claude
 * finishes on its own". opencode is `agent.steps ?? Infinity`, with no global or
 * CLI flag to set it. Claude Code's interactive mode has no turns setting at all;
 * `--max-turns` is print-mode only.
 *
 * So the ceiling is opt-in here too, for the same audience they describe —
 * unattended and batch callers who want a bound and will read the stop reason.
 * An interactive run ends when the task is done, the context window is full, or
 * a human interrupts.
 *
 * What replaces it is not a bigger number: see `NO_PROGRESS_STEPS`, which bounds
 * the one failure a cap was ever for.
 */
const DEFAULT_MAX_STEPS = Number.POSITIVE_INFINITY;
/**
 * The deprecated token rail is **off** by default.
 *
 * It used to default to 400k, which was not a context limit — it was a spend
 * counter, and because every step re-sends the transcript it fired after roughly
 * thirty steps regardless of how much the run had actually cost. That made it a
 * step limit wearing a token costume, and it stopped runs mid-task.
 *
 * A ceiling that fires on the wrong signal is worse than no ceiling, so the
 * honest rails are `maxSpendUsd` (money) and `maxContextTokens` (the window),
 * both opt-in. Callers who want the old behaviour set `maxTokens` explicitly.
 */
const DEFAULT_MAX_TOKENS = 0;
/**
 * Per-step output ceiling when the caller sets none.
 *
 * 16k rather than 8k. Reasoning tokens come out of the same allowance as the
 * reply, so a model that thinks at length can exhaust a small cap mid-thought and
 * the step ends truncated rather than finishing. The cost only rises when the
 * extra room is actually used.
 */
const DEFAULT_MAX_OUTPUT_TOKENS = 16_384;
const DEFAULT_COMPACT_AT_TOKENS = 120_000;
const DEFAULT_KEEP_RECENT = 6;
/** Headroom kept aside so a compaction summary can still be paid for. */
const COMPACTION_RESERVE_TOKENS = 16_000;
/**
 * Headroom kept aside on the dollar rail before compaction is worth its own
 * cost. A compaction is itself a model call, so triggering it at the last
 * moment spends budget the run cannot spare.
 */
const COMPACTION_RESERVE_MULTIPLIER = 2;
/**
 * Room left for the model's own output inside the context window. Thinking
 * tokens count against the window too, so this is not as generous as it looks.
 */
const OUTPUT_HEADROOM_TOKENS = 8_000;

/**
 * Consecutive non-mutating steps before the run is declared stuck.
 *
 * This is what a step cap was actually for, so it is what replaced one. Every
 * mature harness bounds the same thing and none of them count steps:
 *
 * - Claude Code's goal mode stops "if Claude keeps answering the evaluator
 *   without making progress (no tool use for several turns in a row)".
 * - opencode does not stop at all; it guards the loop itself, asking permission
 *   when the same tool gets the same input three times running.
 *
 * A step counter cannot tell those apart, which is why it kept cutting working
 * runs: step 32 of a merge resolution looks exactly like step 32 of a loop.
 * "Has it changed anything lately" can tell them apart, because a stuck run stops
 * mutating and a working one does not.
 *
 * 15 rather than 3 because the signal is coarse — several read-only steps are
 * normal inside a real task (check the output of the last edit, read a file
 * before editing it) — so this wants a margin, not a hair trigger. The nudge
 * below fires far earlier on the same signal, which means a run heading for this
 * has already been told.
 */
const NO_PROGRESS_STEPS = 15;

/**
 * Why a run is being wound up, in the model's own terms.
 *
 * It used to say "you are out of budget" unconditionally, which was already
 * untrue when there is no spend rail — this package has had no default ceiling
 * for money since the dollar rail was removed — and stayed untrue after the step
 * cap went with it. A model told it is out of budget when it is out of steps
 * writes a handoff about money, and a human reading that handoff looks for a
 * spend problem that does not exist. It happened: a merge task was cut at the
 * step ceiling and handed off with "I ran out of budget before verification".
 *
 * So the reason is named, and it is the reason the run actually stopped.
 */
const stopReasonExplanation = (why: HarnessStopReason): string => {
	switch (why) {
		case "max-steps":
			return `This run has a step limit of ${"the configured maximum"}, and it has been reached.`;
		case "max-tokens":
			return "This run has reached its spend or token limit.";
		case "max-output":
			return "A reply was cut off by the per-step output cap, so this run is stopping here.";
		case "max-context":
			return "The context window is full, even after compacting.";
		case "no-progress":
			return (
				"Nothing has changed in the working tree for the last stretch of steps, so this run is stopping rather " +
				"than spend the rest of the session going in circles. If you were in fact making progress, say what " +
				"you were doing and what is left."
			);
		default:
			return "This run is stopping early.";
	}
};

/**
 * The instruction that turns a hard stop into a resumable state.
 *
 * A run that stops with nothing committed loses everything since the last
 * commit, and the next session has to reconstruct it from a half-finished diff.
 * Anthropic's long-running-harness work describes exactly this failure — an agent
 * running out of context mid-implementation and leaving a feature the next
 * session "must guess about" — and notes it happens even with compaction.
 *
 * So the last request is spent on handing off rather than on more work.
 */
const WRAP_UP_INSTRUCTION = (
	why: HarnessStopReason,
): string => `${stopReasonExplanation(why)}

Hand off cleanly. Do exactly this, in order:
1. If you have made any file changes, verify the build/tests still pass and commit the working state with a descriptive message. If something is broken, say so plainly rather than committing it as if it were fine.
2. Update your task ledger so every step reflects reality, including which steps are incomplete.
3. Write a short handoff covering: what is done, what is verified working, and what remains — as concrete next actions with file paths.

Be accurate over complete. Do not claim a step is finished unless you verified it. Do not start new work now.`;

/**
 * Step at which a run that has changed nothing gets told so, once.
 *
 * The prompt already says to plan the edit list and then edit, and a prompt
 * instruction is not enough on its own. The failure is specific: the agent
 * searches, the search reveals more files, it searches those, and every step
 * re-sends a transcript that grows while the diff stays at zero. A real run
 * spent half a million tokens across eight turns and finished with the bulk of
 * a plan unstarted. The mechanism is not stupidity, it is that each individual
 * search looks locally reasonable and only the ratio is wrong.
 *
 * So this says the ratio out loud, once, at the step where it becomes true. Not
 * every step: a repeated nudge is nagging, and nagging teaches the model to
 * discount the message.
 */
const EXPLORATION_NUDGE_AT_STEP = 7;

const EXPLORATION_NUDGE = (step: number): string =>
	`${step} steps so far and nothing in the working tree has changed. Each of those steps re-sent this whole transcript to the model, so the cost is already paid many times over for zero output.\nIf you know enough to act, make the change now with \`edit\` — a small wrong edit you can correct is cheaper than another search. If you genuinely still need to look, name the one question the next two steps must answer, and stop searching once it is answered.`;

/**
 * Tools whose use means the run has stopped reading and started doing.
 *
 * `bash` counts even when it only prints, because a run that has shelled out has
 * usually built or tested something, and either way it is not still hunting for
 * a file.
 */
const MUTATING_TOOL_NAMES = new Set([
	"edit",
	"write",
	"bash",
	"multi_edit",
	"notebook_edit",
	"apply_patch",
]);

/**
 * How many identical tool calls in a row count as a loop.
 *
 * opencode's `DOOM_LOOP_THRESHOLD`, and the reason it is worth copying rather than
 * inventing: no step limit catches the case it is usually worried about. An agent
 * that has genuinely run out of road stops returning for more road, whereas one
 * stuck in a loop keeps calling tools and burns the whole budget getting nowhere.
 * A progress signal misses that one too, because the loop may well be rewriting
 * the same file on every pass — so it needs its own detector.
 *
 * Three is opencode's number and it is the right one. Two repeats are ordinary
 * deliberation: run a test, read the failure, run it again with a flag.
 */
const REPEAT_CALL_THRESHOLD = 3;

/**
 * Ignored warnings before a repeated call ends the run.
 *
 * Three, which lands the stop at six identical steps in a row. The first
 * detection warns and the model gets room to change approach, because iterating
 * on a call is ordinary — read the file, run the test, read the failure, run it
 * with a flag — and those all differ in their arguments, which is the point of
 * comparing the whole call and not just its name.
 *
 * Past that it is not iteration. Six identical steps means the call is not
 * telling the model anything it did not have.
 *
 * This is load-bearing rather than advisory, which is why the threshold is not
 * "never". `bash` counts as progress because the harness cannot see whether a
 * command changed anything, so a shell-driven loop never trips
 * `NO_PROGRESS_STEPS` no matter how long it runs. If the detector only warned,
 * this class of loop would be the one failure nothing bounded.
 */
const REPEAT_STRIKE_LIMIT = 3;

const REPEAT_CALL_WARNING = (toolName: string): string =>
	`You have made the identical \`${toolName}\` call three steps running and nothing has come of it. The same call returns the same result, so it is not telling you anything you do not already have.\nChange the approach rather than repeating it: read a different file, widen the search, or say plainly what you are stuck on and what you would need to get past it. If the work is genuinely done, say so and stop.`;

/**
 * Does this transcript end in a decision the SDK is waiting on?
 *
 * The SDK matches an answer to its request by `approvalId` and reads answers from
 * the final message only, so this is the one question that decides whether a run is
 * a resume or a new task — and it is asked of the transcript rather than of an
 * option, because the transcript is where the answer actually is. A caller that
 * says "resume" without carrying a decision has not resumed anything.
 */
const endsWithApprovalResponse = (messages: ModelMessage[]): boolean => {
	const last = messages.at(-1);
	if (last?.role !== "tool" || !Array.isArray(last.content)) return false;
	return last.content.some(
		(part) => (part as { type?: string }).type === "tool-approval-response",
	);
};

const emptyUsage = (): HarnessUsage => ({
	inputTokens: 0,
	outputTokens: 0,
	totalTokens: 0,
	estimated: false,
});

const addUsage = (
	acc: HarnessUsage,
	step: Partial<HarnessUsage> | undefined,
): HarnessUsage => {
	acc.inputTokens += step?.inputTokens ?? 0;
	acc.outputTokens += step?.outputTokens ?? 0;
	acc.totalTokens +=
		step?.totalTokens ?? (step?.inputTokens ?? 0) + (step?.outputTokens ?? 0);
	acc.cachedInputTokens =
		(acc.cachedInputTokens ?? 0) + (step?.cachedInputTokens ?? 0);
	acc.cacheCreationInputTokens =
		(acc.cacheCreationInputTokens ?? 0) + (step?.cacheCreationInputTokens ?? 0);
	acc.estimated ||= step?.estimated === true;
	return acc;
};

const lastAssistantText = (messages: ModelMessage[]): string => {
	for (let i = messages.length - 1; i >= 0; i -= 1) {
		const m = messages[i];
		if (!m || m.role !== "assistant") {
			continue;
		}
		if (typeof m.content === "string") {
			return m.content.trim();
		}
		if (Array.isArray(m.content)) {
			const text = m.content
				.filter((p) => p.type === "text")
				.map((p) => p.text)
				.join("\n")
				.trim();
			if (text) {
				return text;
			}
		}
	}
	return "";
};

/**
 * A comparable identity for one tool call.
 *
 * Key order is normalised before serialising, because a repeat detector that
 * misses a loop because the model emitted the same arguments in a different
 * order is worse than no detector: it reports a run as stuck when it is merely
 * inconsistent, and stays quiet on the loop it was written for.
 */
const toolCallSignature = (toolName: string, input: unknown): string => {
	const normalise = (value: unknown): unknown => {
		if (Array.isArray(value)) return value.map(normalise);
		if (value && typeof value === "object") {
			return Object.fromEntries(
				Object.entries(value as Record<string, unknown>)
					.sort(([a], [b]) => a.localeCompare(b))
					.map(([k, v]) => [k, normalise(v)]),
			);
		}
		return value;
	};
	let serialised: string;
	try {
		serialised = JSON.stringify(normalise(input ?? null));
	} catch {
		// A non-serialisable argument is rare, and an unserialisable one cannot be
		// compared, so it gets a signature nothing else can collide with. Better to
		// miss a repeat than to report one that is not there.
		return `${toolName}\\u0000<unserialisable-${Math.random()}>`;
	}
	return `${toolName}\\u0000${serialised}`;
};

const stepHadToolCalls = (stepMessages: ModelMessage[]): boolean =>
	stepMessages.some(
		(m) =>
			m.role === "assistant" &&
			Array.isArray(m.content) &&
			m.content.some((p) => p.type === "tool-call"),
	);

/**
 * Combine provider option bags without letting one provider's entry erase
 * another's.
 *
 * `{ ...a, ...b }` looks like a merge and is not one here: every bag is keyed on
 * the provider name, so the spread keeps only the last bag's settings for that
 * provider. Losing `cacheControl` that way is invisible — the request still
 * succeeds, it just stops being cached.
 */
const mergeProviderOptions = (
	...bags: Array<Record<string, Record<string, unknown>> | undefined>
): Record<string, Record<string, unknown>> | undefined => {
	const out: Record<string, Record<string, unknown>> = {};
	let any = false;
	for (const bag of bags) {
		if (!bag) continue;
		for (const [provider, settings] of Object.entries(bag)) {
			if (!settings || typeof settings !== "object") continue;
			out[provider] = { ...(out[provider] ?? {}), ...settings };
			any = true;
		}
	}
	return any ? out : undefined;
};

const isAbortError = (e: unknown): boolean => {
	const name = (e as { name?: string } | null)?.name ?? "";
	return name === "AbortError" || name === "TimeoutError";
};

/**
 * Cache *write* tokens, read from provider metadata best-effort.
 *
 * The AI SDK's usage type covers cache reads but has no field for writes, and
 * the key lives under provider-specific metadata whose shape is not uniform. A
 * miss here only makes the context estimate slightly low, so a wrong answer is
 * preferable to throwing — but the common case is read correctly, because without
 * it a run that is writing a large prefix looks much smaller than it is.
 */
const readCacheCreationTokens = (metadata: unknown): number => {
	const anthropic = (
		metadata as { anthropic?: Record<string, unknown> } | undefined
	)?.anthropic;
	const value = anthropic?.cacheCreationInputTokens;
	return typeof value === "number" ? value : 0;
};

/**
 * Combine the caller's signal with the run's own interrupt signal.
 * Hand-rolled because `AbortSignal.any` is not in the ES2022 lib.
 */
const linkSignals = (
	...signals: Array<AbortSignal | undefined>
): AbortSignal | undefined => {
	const present = signals.filter((s): s is AbortSignal => Boolean(s));
	if (present.length === 0) return undefined;
	if (present.length === 1) return present[0];
	const combined = new AbortController();
	const abort = (reason: unknown) => {
		if (!combined.signal.aborted) combined.abort(reason);
	};
	for (const signal of present) {
		if (signal.aborted) {
			abort(signal.reason);
			break;
		}
		signal.addEventListener("abort", () => abort(signal.reason), {
			once: true,
		});
	}
	return combined.signal;
};

class EventQueue {
	private queue: HarnessEvent[] = [];
	private waiters: Array<() => void> = [];
	private closed = false;

	push(event: HarnessEvent): void {
		this.queue.push(event);
		this.waiters.splice(0).forEach((w) => w());
	}

	close(): void {
		this.closed = true;
		this.waiters.splice(0).forEach((w) => w());
	}

	async *iterate(): AsyncIterable<HarnessEvent> {
		for (;;) {
			const next = this.queue.shift();
			if (next) {
				yield next;
				continue;
			}
			if (this.closed) {
				return;
			}
			await new Promise<void>((resolve) => this.waiters.push(resolve));
		}
	}
}

/**
 * The whole point of not-another-harness: a small, transparent agent loop.
 *
 * One `streamText` call per step (Pi-style), real events between steps, hard
 * step/token budgets, and mid-run compaction when the transcript grows past
 * `compactAtTokens`. No hidden magic: what you see in `events` is the loop.
 *
 * The run is steerable: `run.steer()` appends a user message at the next step
 * boundary. A steer never interrupts the model call in flight — it lands after
 * that step's tools settle, and it grants a fresh step window so a long task
 * cannot lose a pending message to `maxSteps`.
 */
export const runAgent = (options: HarnessRunOptions): HarnessRun => {
	const events = new EventQueue();

	const interruptController = new AbortController();
	const signal = linkSignals(options.abortSignal, interruptController.signal);
	const steerQueue: string[] = [];
	const followUpQueue: string[] = [];
	let settled = false;

	const enqueue = (
		queue: string[],
		text: string,
		delivery: HarnessSteerDelivery,
	): boolean => {
		const trimmed = text.trim();
		if (!trimmed || settled) {
			return false;
		}
		queue.push(trimmed);
		events.push({
			type: "user-message",
			text: trimmed,
			delivery,
			phase: "queued",
		});
		return true;
	};

	const resultPromise = (async (): Promise<HarnessRunResult> => {
		/**
		 * `Infinity` by default, so `stepLimit` and the steer arithmetic below need no
		 * special case: `step + Infinity` is `Infinity`, which is the correct answer
		 * for "grant a fresh window" when there was no window to begin with.
		 */
		const maxSteps =
			options.maxSteps === undefined
				? DEFAULT_MAX_STEPS
				: Math.max(1, Math.floor(options.maxSteps));
		// Deprecated token budget, still honoured. See `maxSpendUsd` for why a token
		// count is the wrong unit for a spend ceiling.
		const maxTokens = Math.max(
			0,
			Math.floor(options.maxTokens ?? DEFAULT_MAX_TOKENS),
		);
		const maxSpendUsd = Math.max(0, options.maxSpendUsd ?? 0);
		const maxContextTokens = Math.max(
			0,
			Math.floor(options.maxContextTokens ?? 0),
		);
		const maxOutputTokens = Math.max(
			1,
			Math.floor(options.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS),
		);
		const compactAt = Math.max(
			10_000,
			Math.floor(options.compactAtTokens ?? DEFAULT_COMPACT_AT_TOKENS),
		);
		const compactionMode = options.compaction ?? "model";
		const keepRecent = Math.max(
			2,
			Math.floor(options.compactKeepRecent ?? DEFAULT_KEEP_RECENT),
		);
		const wrapUpEnabled = options.wrapUpOnLimit !== false;
		const spend = options.rates ? createSpendMeter(options.rates) : null;

		let messages: ModelMessage[] = [...(options.messages ?? [])];
		/**
		 * Append the task, unless this run is *resuming* one.
		 *
		 * The SDK reads approval answers from the **last** message only —
		 * `collectToolApprovals` returns early unless `messages.at(-1).role === "tool"`
		 * — and appending `prompt` unconditionally would push the answer out of that
		 * position, so the approved tool would never execute and the run would report
		 * success having done nothing. Silent, because a model that was asked to
		 * continue will happily produce text.
		 *
		 * So a run that arrives carrying answers resumes: `prompt` is not appended.
		 * That is not a special case invented for approval — it is the only coherent
		 * meaning of a transcript that already ends in a decision. A caller resuming
		 * passes `prompt: ""`, which is documented on the option.
		 */
		const resumesApproval = endsWithApprovalResponse(messages);
		if (!resumesApproval) messages.push({ role: "user", content: options.prompt });

		const usage = emptyUsage();
		let compactions = 0;
		let steps = 0;
		let wrappedUp = false;
		let streamedText = "";
		let reason: HarnessStopReason = "completed";
		/**
		 * Calls waiting on a person, in the order they were asked.
		 *
		 * Declared out here rather than beside the rest of the step state, because the
		 * result is returned from outside the `try` — an abort mid-step still has to
		 * report what was left unapproved, and a `catch` that cannot see it reports an
		 * empty list for a run that was waiting on a person.
		 */
		const pendingApprovals: PendingApproval[] = [];
		/**
		 * Every approval this run has seen, by id.
		 *
		 * Needed because two of the three approval parts identify a call only
		 * indirectly: `tool-approval-response` carries an `approvalId` and no
		 * `toolCallId` at all, and `tool-output-denied` carries a `toolCallId` and no
		 * `toolName`. Reading either off the stream alone means emitting an event with
		 * an empty field, which is how a result ends up attributed to no tool at all.
		 */
		const approvalCalls = new Map<string, PendingApproval>();
		/** Tool name per `toolCallId`, read from the transcript this run was given. */
		const transcriptToolNames = new Map<string, string>();
		/**
		 * Tool name per `toolCallId`, for calls this run did not itself make.
		 *
		 * Seeded from the transcript on the way in. A denial decided in an *earlier* run
		 * is re-announced by the SDK before this run's first step, with no approval
		 * request part alongside it — so `approvalCalls` is empty and the name can only
		 * come from the call the transcript already recorded. Without this the resumed
		 * denial reported `toolName: ""`, which is a result attributed to no tool at
		 * all: exactly the call a user refused, the one most worth naming in a log.
		 */
		for (const message of messages) {
			if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
			for (const part of message.content as Array<Record<string, unknown>>) {
				if (part.type !== "tool-call") continue;
				const toolCallId = String(part.toolCallId ?? "");
				if (!toolCallId) continue;
				transcriptToolNames.set(toolCallId, String(part.toolName ?? ""));
			}
		}
		/**
		 * Calls whose result has already been reported on the event stream.
		 *
		 * Exists because of a replay in the SDK, not a guess. A denied call is written
		 * into the transcript as an approval response, and **every subsequent step of
		 * the same run re-announces it**: each new `streamText` call re-reads the
		 * transcript and re-emits `tool-output-denied` for that call before its first
		 * `start-step`. A plain `tool-result` is not replayed, so this only ever bit
		 * denials — mapping them faithfully produced two `tool-result` events for one
		 * call, which breaks the one-call-one-result pairing every consumer assumes and
		 * makes a denied `deleteFile` look like it was attempted twice.
		 *
		 * First report wins, so the step that actually made the decision is the one
		 * reported, rather than whichever later step re-read the transcript.
		 */
		const reportedResults = new Set<string>();
		/**
		 * Size of the most recent request as the provider counted it. Every step
		 * re-sends the whole transcript, so *cumulative* usage is not a measure of
		 * context pressure — the same tokens are billed again on every step. The
		 * last step's real input count is the only honest signal for "is the next
		 * request about to overflow", so that is what drives compaction.
		 *
		 * "Real" has to include the cached prefix. Anthropic reports
		 * `input_tokens` as only the tokens *after* the last cache breakpoint and
		 * the cached portion separately as `cache_read_input_tokens`. Reading
		 * `inputTokens` alone made this figure collapse toward the size of the
		 * newest few blocks once caching worked, so `compactAtTokens` silently
		 * stopped firing precisely when compaction mattered most.
		 */
		let lastRequestTokens = estimateRequestTokens(options.system, messages);

		events.push({
			type: "run-start",
			stepBudget: Number.isFinite(maxSteps) ? maxSteps : null,
			tokenBudget: maxTokens,
		});

		// Collapses identical tool calls emitted twice in the same step. The memo is
		// cleared per step, so re-running a command later — after an edit — still
		// works normally.
		const dedupe = createStepDedupe(options.tools);
		/**
		 * Re-reads of lines this run already fetched, served from what is in hand.
		 *
		 * Wrapped outside the step memo because the redundancy spans steps: a read
		 * with no limit covers end-of-file, so the next request for a later offset
		 * is inside it. Any mutating tool clears the window, since a stale read
		 * would be worse than a duplicate one.
		 */
		const coverage = createReadCoverage(dedupe.tools);
		// Tool definitions and the system prompt are re-sent verbatim every step, so
		// they carry cache breakpoints. Marking a prefix is safe; rewriting one is
		// not, because editing a prior tool_result invalidates Anthropic's
		// thinking-block signatures.
		// Coverage sits outside the memo and inside the cache marking, so the model
		// sees the wrapped tools and the breakpoints still land on the real schemas.
		const cachedTools = withCachedToolSchemas(
			coverage.tools,
			options.cacheProvider,
			options.cacheTtl,
		);
		/**
		 * Merge the request-level breakpoint and the context-editing options.
		 *
		 * Both are keyed on the provider name, so a plain object spread has the
		 * second one *replace* the first — silently discarding the system prompt's
		 * `cacheControl` whenever context editing is enabled, which is always. The
		 * merge therefore has to go one level deeper than the provider key.
		 */
		const providerOptions = mergeProviderOptions(
			cacheOptions(options.cacheProvider, options.cacheTtl),
			contextManagementOptions(options.cacheProvider, options.contextEditing),
		);
		const effectiveProviderOptions: SharedV2ProviderOptions | undefined =
			providerOptions && Object.keys(providerOptions).length > 0
				? (providerOptions as SharedV2ProviderOptions)
				: undefined;

		/**
		 * Append queued messages for `delivery` to the transcript. Returns how many
		 * landed. Runs before the next model request is assembled, which is what
		 * makes a steer invisible to the step already in flight.
		 */
		const promote = (delivery: HarnessSteerDelivery): number => {
			const queue = delivery === "steer" ? steerQueue : followUpQueue;
			const pending = queue.splice(0);
			for (const text of pending) {
				messages.push({ role: "user", content: text });
				events.push({
					type: "user-message",
					text,
					delivery,
					phase: "delivered",
				});
			}
			return pending.length;
		};

		/**
		 * Compact the transcript, optionally ignoring the size threshold.
		 *
		 * Used twice: on the ordinary size trigger, and under budget pressure, where
		 * the next request no longer fits in what is left of the spend cap and the only
		 * way to continue is to make the request smaller.
		 */
		const compactNow = async (
			opts: { force?: boolean } = {},
		): Promise<boolean> => {
			if (compactionMode === "off") return false;
			if (!opts.force && lastRequestTokens < compactAt) return false;
			const compacted = await compactMessages({
				model: options.model,
				system: options.system,
				messages,
				keepRecent,
				mode: compactionMode,
				...(maxTokens > 0
					? { maxTokensRemaining: Math.max(0, maxTokens - usage.totalTokens) }
					: {}),
			});
			if (!compacted) return false;
			addUsage(usage, compacted.usage);
			if (spend) usage.spendUsd = spend.charge(compacted.usage);
			events.push({
				type: "compacted",
				droppedMessages: compacted.droppedMessages,
				keptMessages: compacted.messages.length,
				summaryChars: compacted.summaryChars,
			});
			messages = compacted.messages;
			lastRequestTokens = estimateRequestTokens(options.system, messages);
			compactions += 1;
			return true;
		};

		/**
		 * How much of the context window the next request would occupy, including the
		 * room the model's own output needs.
		 *
		 * Output counts against the window — thinking tokens included — so a request
		 * that fits exactly will still fail mid-generation without headroom for the
		 * response it is about to produce.
		 */
		const contextFootprint = (inputTokens: number): number =>
			inputTokens + Math.min(maxOutputTokens, OUTPUT_HEADROOM_TOKENS);

		/**
		 * The two ceilings, kept in their own units.
		 *
		 * They cannot be combined into a single "remaining" figure: one is dollars
		 * and the other is tokens. Adding or comparing them across units is the
		 * mistake that made a $40 rail behave as though it were 40 tokens.
		 */
		const tokenRailLeft = (): number =>
			maxTokens > 0 ? maxTokens - usage.totalTokens : Number.POSITIVE_INFINITY;
		const dollarRailLeft = (): number =>
			maxSpendUsd > 0 && spend
				? maxSpendUsd - spend.total()
				: Number.POSITIVE_INFINITY;

		/**
		 * What the next request is projected to cost, in dollars.
		 *
		 * Input is known exactly. Output is not, so it is projected from what steps
		 * have actually produced so far — a real run's step cost is stable enough for
		 * that to be a fair estimate, and the alternative (assuming the worst case)
		 * would compact a run that was never in danger.
		 */
		const projectedStepCostUsd = (inputTokens: number): number => {
			if (!options.rates) return 0;
			const observedOutput =
				steps > 0 ? usage.outputTokens / steps : maxOutputTokens;
			return usageCostUsd(
				{ inputTokens, outputTokens: observedOutput },
				options.rates,
			);
		};

		/** Whether either ceiling is close enough that compaction is worth buying. */
		const underSpendPressure = (inputTokens: number): boolean => {
			if (tokenRailLeft() <= inputTokens + COMPACTION_RESERVE_TOKENS)
				return true;
			if (
				dollarRailLeft() <=
				projectedStepCostUsd(inputTokens) * COMPACTION_RESERVE_MULTIPLIER
			) {
				return true;
			}
			return false;
		};

		/** Whether either ceiling cannot cover the next request at all. */
		const spendExhausted = (inputTokens: number): boolean => {
			if (tokenRailLeft() <= inputTokens) return true;
			if (dollarRailLeft() <= projectedStepCostUsd(inputTokens)) return true;
			return false;
		};

		/** Whether the next request would exceed the context window. */
		const contextExceeded = (inputTokens: number): boolean =>
			maxContextTokens > 0 && contextFootprint(inputTokens) > maxContextTokens;

		/**
		 * Output allowance for this step, clamped by every ceiling that applies.
		 *
		 * The dollar rail clamps output by *price* rather than by bailing out
		 * afterwards: the remaining dollars are converted into the output tokens they
		 * can buy, after paying for the input this step is about to send. A step that
		 * can only afford a short answer gets one, rather than being truncated
		 * mid-sentence or overspending and then stopping.
		 */
		const stepOutputAllowance = (inputTokens: number): number => {
			let allowance = maxOutputTokens;
			if (maxContextTokens > 0) {
				allowance = Math.min(allowance, maxContextTokens - inputTokens);
			}
			if (Number.isFinite(tokenRailLeft())) {
				allowance = Math.min(allowance, tokenRailLeft() - inputTokens);
			}
			if (options.rates && Number.isFinite(dollarRailLeft())) {
				const rates = options.rates;
				const inputCost = usageCostUsd({ inputTokens, outputTokens: 0 }, rates);
				const afterInput = dollarRailLeft() - inputCost;
				if (afterInput <= 0) return 1;
				allowance = Math.min(
					allowance,
					afterInput / ((rates.output || 1) / 1_000_000),
				);
			}
			return Math.max(1, Math.floor(allowance));
		};

		try {
			let step = 0;
			let stepLimit = maxSteps;
			/** Mutating tool calls made this run, which the exploration nudge watches. */
			/** Mutating tool calls made this run. */
			let mutations = 0;
			/**
			 * Steps since the run last changed anything.
			 *
			 * The single signal behind both the exploration nudge and the no-progress
			 * stop, so the two can never disagree about whether a run is going
			 * anywhere — and so neither of them is a step counter wearing a costume.
			 */
			let stepsSinceMutation = 0;
			let nudged = false;
			/** Tool-call signatures made during the step being assembled. */
			let stepCallSignatures: string[] = [];
			/** Tool names called in the step currently streaming. */
			let stepToolNames: string[] = [];
			/** Tool calls per completed step, which is what `prepareStep` is asked about. */
			const toolCallsByStep: Array<{ step: number; toolNames: string[] }> = [];
			/** Whether the step being assembled has changed anything. */
			let mutatedThisStep = false;
			/**
			 * Signatures of the last few *steps*, one entry each.
			 *
			 * A single entry per step, not per call: three steps that each made the
			 * identical call is a loop, whereas one step that issued the same call twice
			 * is a model that wanted two things at once and says nothing about progress.
			 */
			const recentSteps: string[] = [];
			let repeatWarnedFor = "";
			/**
			 * Consecutive detections of the same repeat, after the model was warned.
			 *
			 * The warning alone is not a bound. `bash` counts as progress because the
			 * harness cannot tell whether a command changed anything, so a shell-driven
			 * loop mutates its way past `NO_PROGRESS_STEPS` forever — every step looks
			 * like work. This is the only signal that catches it, so it has to end the
			 * run rather than merely observe it.
			 */
			let repeatStrikes = 0;
			/**
			 * Index of the last message that was present when the previous request was
			 * sent. The tail cache breakpoint is placed here, so it always marks a
			 * prefix a prior request already wrote.
			 */
			let cachedTailIndex = 0;
			while (step < stepLimit) {
				step += 1;
				if (signal?.aborted) {
					reason = "aborted";
					break;
				}

				// Steers land here: after the previous step's tools settled, before this
				// request is assembled, so nothing is ever cut off mid-token.
				if (steerQueue.length > 0 && promote("steer") > 0) {
					// A human just gave the agent more work. Grant a fresh step window so
					// `maxSteps` cannot silently drop a message they deliberately sent.
					stepLimit = step + maxSteps;
				}
				/**
				 * Say the explore-to-edit ratio out loud, once it is bad.
				 *
				 * Keyed on `stepsSinceMutation` rather than the absolute step, so it is the
				 * early half of the same measurement the no-progress stop uses later. A
				 * run that has been exploring for six steps after editing gets the same
				 * nudge as one that never edited at all, which is the case that matters.
				 *
				 * Placed beside the steer queue so a human's message always wins: if both
				 * were pending, the nudge would otherwise be the last thing the model read
				 * and read as a criticism of what they just asked for.
				 */
				if (!nudged && stepsSinceMutation === EXPLORATION_NUDGE_AT_STEP) {
					nudged = true;
					messages.push({ role: "user", content: EXPLORATION_NUDGE(step) });
				}
				// Bound transcript growth on providers with no server-side context
				// editing. Skipped automatically when reasoning is present.
				let requestMessages = messages;
				/**
				 * Client-side pruning and prompt caching are mutually exclusive.
				 *
				 * Eliding a tool result rewrites bytes that sit *behind* the cache
				 * breakpoint, so the prefix hash stops matching what the previous
				 * request wrote. Measured on the configured model over a growing
				 * conversation: a stable prefix cached 3,242 tokens per turn on
				 * average, the same conversation with old results rewritten cached 487 -
				 * an 85% collapse, matching a real run that reported 2% cached.
				 *
				 * The trade is not close. A cached token costs 0.1x, so replaying a
				 * large prefix at a discount is far cheaper than paying full price for
				 * a slightly smaller one. On a 548k turn that is roughly 60k billed
				 * versus 537k - pruning saved 1% of the tokens and gave away a 90%
				 * discount.
				 *
				 * So pruning is for providers with no cache to lose. Growth is bounded
				 * by compaction instead, which rewrites the whole conversation rarely
				 * enough that one cache write per compaction is worth paying.
				 */
				const cacheable = supportsCaching(options.cacheProvider);
				if (options.pruneToolResults && step > 1 && !cacheable) {
					const pruned = pruneOldToolResults(
						messages,
						options.pruneToolResults.keepRecentToolCalls,
						{
							// Reasoning signatures are an Anthropic concept. Without this the
							// guard fired for every provider, so pruning never ran anywhere.
							provider: options.cacheProvider,
							// `LanguageModel` is `string | LanguageModelV2`, so the id is only
							// reachable on the object arm.
							modelId:
								typeof options.model === "string"
									? options.model
									: options.model.modelId,
						},
					);
					requestMessages = pruned.messages;
				}
				let estimatedInputTokens = estimateRequestTokens(
					options.system,
					requestMessages,
				);

				/**
				 * Context pressure, and it is fixable. Unlike the spend rail, exceeding
				 * the window is not a reason to stop: compaction makes the request
				 * smaller. So compact first and only consider stopping if even a
				 * compacted request does not fit.
				 */
				if (contextExceeded(estimatedInputTokens)) {
					const stepsLeft = stepLimit - step > 0;
					if (stepsLeft && (await compactNow({ force: true }))) {
						requestMessages = messages;
						estimatedInputTokens = estimateRequestTokens(
							options.system,
							requestMessages,
						);
					}
					if (contextExceeded(estimatedInputTokens)) {
						reason = "max-context";
						break;
					}
				}

				// Budget triage. Waiting until the next request stops fitting means the
				// run has already overspent, and the reason it stopped fitting is
				// transcript size - which compaction fixes. So act while there is still
				// headroom: if the next step plus a reserve is no longer affordable,
				// spend a compaction to buy room, and only give up when even a compacted
				// request cannot be paid for.
				if (underSpendPressure(estimatedInputTokens)) {
					const stepsLeft = stepLimit - step > 0;
					// Only compact if there is budget left to pay for the summary itself,
					// otherwise the compaction is what pushes the run over the rail.
					const canAffordSummary = tokenRailLeft() > COMPACTION_RESERVE_TOKENS;
					if (
						canAffordSummary &&
						stepsLeft &&
						(await compactNow({ force: true }))
					) {
						requestMessages = messages;
						estimatedInputTokens = estimateRequestTokens(
							options.system,
							requestMessages,
						);
					}
					// Once a wrap-up is armed it has already been checked for affordability,
					// so triage must not retract it here — otherwise the run emits a
					// `wrap-up` event and then stops without the step it announced.
					if (!wrappedUp && spendExhausted(estimatedInputTokens)) {
						reason = "max-tokens";
						break;
					}
				}

				const stepOutputLimit = stepOutputAllowance(estimatedInputTokens);
				steps = step;
				dedupe.beginStep();
				// Reset at the step boundary, not at declaration. These two accumulate
				// during a step and are read once it finishes, so a declaration outside
				// the loop made every step's record a cumulative snapshot of the whole run
				// — `steps[1].toolNames` grew with every call ever made, which quietly
				// broke any caller rule counting them.
				stepCallSignatures = [];
				stepToolNames = [];

				// The hook runs before onStepStart so a returned override is in force for
				// this step's request, and so a hook that throws stops the run before any
				// work is done rather than halfway through it.
				let overrides: StepOverrides = {};
				if (options.prepareStep) {
					overrides =
						(await options.prepareStep({
							stepNumber: step,
							messages: [...messages],
							// A snapshot, like `messages`: handing out the live array would let
							// a consumer rewrite the run's own bookkeeping.
							steps: toolCallsByStep.map((entry) => ({
								step: entry.step,
								toolNames: [...entry.toolNames],
							})),
						})) ?? {};
				}
				const stepToolChoice = overrides.toolChoice ?? options.toolChoice;
				/**
				 * This step's tool context, or the run's.
				 *
				 * `prepareStep` is per step, so returning nothing falls back rather than
				 * inheriting the previous step's value — a counter has to be recomputed
				 * from `stepNumber` every step. Only forwarded when set, so a run that
				 * configures no tool context leaves the SDK's own default in charge.
				 */
				const stepToolsContext = overrides.toolsContext ?? options.toolsContext;

				await options.onStepStart?.(step, [...messages]);
				events.push({ type: "step-start", step });

				/**
				 * Mark the transcript tail so the growing prefix is read back from cache
				 * rather than re-billed at full price. `cachedTailIndex` is the last
				 * message that was already present when the previous request went out,
				 * so everything up to it is byte-identical to what that request wrote —
				 * which is exactly the condition a cache read requires. Marking the very
				 * last message instead would write a fresh entry every step and read
				 * nothing back.
				 */
				const cachedRequestMessages = withCachedTail(
					requestMessages,
					Math.min(cachedTailIndex, requestMessages.length - 1),
					options.cacheProvider,
					options.cacheTtl,
				);

				const stepResult = streamText({
					model: overrides.model ?? options.model,
					system: options.system,
					messages: cachedRequestMessages,
					tools: cachedTools as ToolSet,
					// Left unset rather than defaulted. streamText resolves an unset
					// toolChoice to "auto" itself today, so passing "auto" would be
					// equivalent — and pinning it here would freeze a default the SDK is
					// free to change, in a harness whose job is not to second-guess it.
					...(stepToolChoice === undefined
						? {}
						: { toolChoice: stepToolChoice as ToolChoice<ToolSet> }),
					...(overrides.temperature === undefined
						? {}
						: { temperature: overrides.temperature }),
					/**
					 * Cast, because `toolsContext` is not typeable here and never will be
					 * in this shape: the SDK accepts it only for a tool set whose tools
					 * *declare* a context (`ToolsContextParameter` resolves to
					 * `{ toolsContext?: undefined }` otherwise), and the harness's tools
					 * are `Record<string, unknown>` with every declaration erased by the
					 * time they are handed over. Nothing at runtime cares — the SDK reads
					 * the slice per tool and validates it only when that tool declared a
					 * `contextSchema` — so the type is wrong here and the behaviour is not.
					 */
					...(stepToolsContext === undefined
						? {}
						: { toolsContext: stepToolsContext as never }),
					/**
					 * Cast for the same reason as `toolsContext`: the SDK types this
					 * against the tool set's declared approval, and the harness's tools
					 * are `Record<string, unknown>` with that erased. The value is
					 * forwarded untouched either way.
					 */
					...(options.toolApproval === undefined
						? {}
						: { toolApproval: options.toolApproval as never }),
					...(effectiveProviderOptions
						? { providerOptions: effectiveProviderOptions }
						: {}),
					abortSignal: signal,
					maxOutputTokens: overrides.maxOutputTokens ?? stepOutputLimit,
					// One model round-trip (+ its tool executions) per loop iteration —
					// stop conditions, compaction, and events live in *this* loop.
					stopWhen: stepCountIs(1),
				});

				/**
				 * Turn a stream `error` part into a thrown Error.
				 *
				 * The SDK has already run the provider's payload through
				 * `normalizeStreamProviderError`, which produces a `StreamProviderError`
				 * whenever the payload has a `message` string. But a gateway that only
				 * sends `{ message: "ERROR" }` — no `statusCode`, no `code`, no
				 * `isRetryable` — yields an error carrying none of the fields a caller
				 * needs: the message alone is a dead end, and rethrowing it unchanged
				 * puts a bare `AI_StreamProviderError: ERROR` in front of the user with
				 * no indication whether the turn is worth repeating.
				 *
				 * So the raw part is kept as `cause`, and whatever the payload *did*
				 * carry is lifted onto the message. `ERROR` with nothing behind it is
				 * the only case that gets invented text, and it says so explicitly
				 * rather than dressing itself up as a diagnosis.
				 */
				const toStreamError = (part: { error?: unknown }): Error => {
					if (part.error instanceof Error) {
						const error = part.error as Error & {
							statusCode?: number;
							isRetryable?: boolean;
						};
						const facts = [
							typeof error.statusCode === "number"
								? `status ${error.statusCode}`
								: undefined,
							typeof error.isRetryable === "boolean"
								? error.isRetryable
									? "retryable"
									: "not retryable"
								: undefined,
						].filter((fact): fact is string => fact != null);
						if (facts.length === 0) return error;
						return new Error(
							`provider stream error: ${error.message} (${facts.join(", ")})`,
							{ cause: error },
						);
					}
					const payload =
						typeof part.error === "string"
							? part.error
							: JSON.stringify(part.error ?? "unknown");
					return new Error(`provider stream error: ${payload}`);
				};

				for await (const part of stepResult.fullStream) {
					if (part.type === "text-delta") {
						streamedText += part.text;
						events.push({ type: "text-delta", step, text: part.text });
					} else if (part.type === "tool-call") {
						stepToolNames.push(part.toolName);
						if (MUTATING_TOOL_NAMES.has(part.toolName)) {
							mutations += 1;
							mutatedThisStep = true;
						}
						stepCallSignatures.push(
							toolCallSignature(part.toolName, part.input),
						);
						events.push({
							type: "tool-call",
							step,
							toolCallId: part.toolCallId,
							toolName: part.toolName,
							input: part.input,
						});
					} else if (part.type === "tool-approval-request") {
						/**
						 * A tool held for a decision, which used to be invisible too.
						 *
						 * The same family as the `tool-error` case below: a part the loop
						 * did not map. But the consequence is worse than a lost log line.
						 * A blocked call produces a `tool-call` event and **no** result —
						 * the SDK emits neither, because the tool has not run — so a UI
						 * shows a call that spins forever and a trace shows a span that
						 * never closes. Neither can tell the difference between "waiting on
						 * a person" and "hung".
						 *
						 * `isAutomatic` is carried rather than filtered, because the two
						 * cases belong to one stream and a consumer that cannot tell them
						 * apart either prompts on a decision nobody needs to make, or
						 * ignores a decision a person is waiting on.
						 *
						 * The id is remembered because the response part does not repeat it:
						 * `tool-approval-response` carries an `approvalId` and nothing that
						 * identifies the call, so without this the event would have to
						 * repeat the approval id in place of the call id and every consumer
						 * would have to correlate the two back together.
						 */
						const approval: PendingApproval = {
							approvalId: part.approvalId,
							toolCallId: part.toolCall.toolCallId,
							toolName: part.toolCall.toolName,
							input: part.toolCall.input,
							...(part.reason === undefined ? {} : { reason: part.reason }),
						};
						approvalCalls.set(part.approvalId, approval);
						if (part.isAutomatic !== true) pendingApprovals.push(approval);
						events.push({
							type: "tool-approval-request",
							step,
							...approval,
							isAutomatic: part.isAutomatic === true,
						});
					} else if (part.type === "tool-approval-response") {
						const held = approvalCalls.get(part.approvalId);
						events.push({
							type: "tool-approval-response",
							step,
							approvalId: part.approvalId,
							toolCallId: held?.toolCallId ?? "",
							approved: part.approved,
							...(part.reason === undefined ? {} : { reason: part.reason }),
						});
					} else if (part.type === "tool-output-denied") {
						/**
						 * A denied call, as a result event.
						 *
						 * The SDK emits this instead of a `tool-result`, so without it a
						 * denied call is the one case where a `tool-call` never gets a
						 * result — the pairing every consumer relies on, broken for exactly
						 * the call a user just refused. Marked `isError` so a trace marks the
						 * span failed and a UI can say "denied" rather than "no output".
						 *
						 * `toolName` comes from the call the approval was raised against:
						 * the part itself omits it, and an empty name in a result event is
						 * worse than one recovered from the transcript.
						 */
						if (reportedResults.has(part.toolCallId)) continue;
						reportedResults.add(part.toolCallId);
						const held = [...approvalCalls.values()].find(
							(entry) => entry.toolCallId === part.toolCallId,
						);
						events.push({
							type: "tool-result",
							step,
							toolCallId: part.toolCallId,
							toolName:
								held?.toolName ?? transcriptToolNames.get(part.toolCallId) ?? "",
							output: `Denied${held?.reason ? `: ${held.reason}` : "."}`,
							isError: true,
						});
					} else if (part.type === "tool-result") {
						const output = part.output;
						reportedResults.add(part.toolCallId);
						events.push({
							type: "tool-result",
							step,
							toolCallId: part.toolCallId,
							toolName: part.toolName,
							output:
								typeof output === "string"
									? output
									: JSON.stringify(output ?? "").slice(0, 2000),
							isError:
								(part as { isError?: boolean }).isError === true ||
								(part as { error?: unknown }).error != null,
						});
					} else if (part.type === "tool-error") {
						/**
						 * A tool that threw, which used to be invisible.
						 *
						 * The SDK does not put a failure on the `tool-result` part — it
						 * emits a separate `tool-error` part, and this loop used to map
						 * neither, so a tool that failed at its own boundary produced a
						 * `tool-call` event and then nothing. Not a run-level error, not a
						 * result, no exception: the model was handed the failure as
						 * error-text and carried on, while every consumer of `events` — a
						 * UI's spinner, a trace's span, a log — saw a call that never
						 * returned. Silently, because the SDK had already done the right
						 * thing at the transcript level.
						 *
						 * So it is mapped onto `tool-result` with `isError`, rather than
						 * onto `error`, which ends the run. The SDK is deliberate here: the
						 * model can recover from a failed tool, and a harness that threw
						 * would turn one bad `grep` into a dead run. Every call still
						 * pairs with exactly one result, matched by `toolCallId`, and the
						 * text is the same `getErrorMessage` the model itself reads.
						 */
						events.push({
							type: "tool-result",
							step,
							toolCallId: part.toolCallId,
							toolName: part.toolName,
							output: getErrorMessage(part.error).slice(0, 2000),
							isError: true,
						});
					} else if (part.type === "error") {
						throw toStreamError(part);
					}
				}

				const [response, stepUsage, finishReason, providerMetadata] =
					await Promise.all([
						stepResult.response,
						stepResult.usage,
						stepResult.finishReason,
						// A promise, not a value — reading it synchronously would silently
						// yield nothing on every run.
						stepResult.providerMetadata,
					]);
				messages.push(...response.messages);
				await options.onStepFinish?.(step, [...messages]);
				const inputTokens = stepUsage.inputTokens ?? 0;
				const outputTokens = stepUsage.outputTokens ?? 0;
				/**
				 * The cache breakdown, normalised by the SDK.
				 *
				 * This used to be `stepUsage.cachedInputTokens` plus a best-effort read of
				 * `anthropic.cacheCreationInputTokens` out of provider metadata, and the
				 * comment above it explained a subtle trap: on AI SDK v5 `inputTokens`
				 * *excluded* the cached prefix, so the request's true size was the sum of
				 * all three, and summing on a provider that already counted the cache
				 * inflated a 90%-hit run roughly 10x.
				 *
				 * On v7 that trap is gone rather than moved. `inputTokens` is now the
				 * total — cache reads and writes included — with the composition broken
				 * out under `inputTokenDetails`. So `inputTokens` alone is the request's
				 * real size, and the old sum would now double-count exactly the portion
				 * the old code went to such lengths to add correctly.
				 *
				 * `cacheWriteTokens` is preferred over the metadata read, since the SDK
				 * now normalises it; the provider-metadata path stays as a fallback so a
				 * provider that reports neither still contributes rather than silently
				 * reporting zero cache writes.
				 */
				const tokenDetails = stepUsage.inputTokenDetails;
				const cachedInputTokens = tokenDetails?.cacheReadTokens ?? 0;
				/**
				 * `||`, not `??`: the SDK always fills `cacheWriteTokens` in, with 0 when
				 * the provider reported none, so `??` would treat "not reported" as "there
				 * were none" and never reach the metadata read. A provider that reports
				 * cache writes only in `providerMetadata` — which is what Anthropic did
				 * before the SDK normalised it — then reported zero writes forever, and
				 * a large cache write was priced as fresh input.
				 */
				const cacheCreationInputTokens =
					tokenDetails?.cacheWriteTokens ||
					readCacheCreationTokens(providerMetadata);
				/**
				 * The request's real input size.
				 *
				 * Identical to the pre-v7 result under both conventions — the old
				 * `split` branch computed exactly this total by summing three numbers the
				 * SDK has since folded into one, and the `inclusive` branch already took
				 * the provider's own count, which is now the same value.
				 */
				const requestSize = inputTokens;
				/**
				 * The billed input: prompt tokens the provider charged full price for.
				 *
				 * `HarnessUsage.inputTokens` has always meant this, and the rest of the
				 * package is built on it: `totalTokens` is `inputTokens + outputTokens`
				 * with the cache tracked beside them, and `spend.ts` charges
				 * `inputTokens` at the full input rate *and* `cachedInputTokens` and
				 * `cacheCreationInputTokens` at their own cheaper rates.
				 *
				 * Passing v7's `inputTokens` straight through would therefore bill the
				 * cached prefix twice — once at the full rate and again at the cache-read
				 * rate. On a 90%-hit request that is roughly 11x the correct cost for the
				 * cached portion, which is why a well-cached run came out *more*
				 * expensive than an uncached one on the same rail. The uncached count is
				 * `noCacheTokens`; a provider that reports no breakdown falls back to the
				 * total, which is what it would have meant under the old convention.
				 */
				const freshInputTokens = tokenDetails?.noCacheTokens ?? inputTokens;
				const totalTokens = freshInputTokens + outputTokens;
				if (totalTokens > 0 || inputTokens > 0 || outputTokens > 0) {
					const stepUsageDelta = {
						inputTokens: freshInputTokens,
						outputTokens,
						totalTokens,
						cachedInputTokens,
						cacheCreationInputTokens,
					};
					addUsage(usage, stepUsageDelta);
					if (spend) usage.spendUsd = spend.charge(stepUsageDelta);
					lastRequestTokens = requestSize > 0 ? requestSize : lastRequestTokens;
				} else {
					const estimatedInput = estimatedInputTokens;
					const estimatedOutput = response.messages
						.filter((message) => message.role === "assistant")
						.reduce((sum, message) => sum + estimateMessageTokens(message), 0);
					usage.inputTokens += estimatedInput;
					usage.outputTokens += estimatedOutput;
					usage.totalTokens += estimatedInput + estimatedOutput;
					usage.estimated = true;
					lastRequestTokens = estimatedInput;
				}
				/**
				 * Per-request breakdown, emitted alongside the cumulative totals.
				 *
				 * The two answer different questions and neither substitutes for the
				 * other: `usage` is everything the run has spent, this is the size and
				 * cache composition of the prompt just sent. A caller that only has the
				 * former cannot show a context size or a cache hit rate at all.
				 */
				events.push({
					type: "step-finish",
					step,
					usage: { ...usage },
					request: {
						totalInputTokens: lastRequestTokens,
						cachedInputTokens,
						cacheCreationInputTokens,
						// The uncached portion of the prompt. `inputTokens` is the total on
						// v7, so this is the total minus both cache reads and cache writes —
						// which is what `noCacheTokens` already is, and the subtraction is
						// the fallback for a provider that reports no breakdown.
						freshInputTokens:
							tokenDetails?.noCacheTokens ??
							Math.max(
								0,
								inputTokens - cachedInputTokens - cacheCreationInputTokens,
							),
						hitRate:
							requestSize > 0
								? Math.min(1, cachedInputTokens / requestSize)
								: 0,
					},
				});

				// Everything sent this step is now a prefix a future step can read back.
				cachedTailIndex = requestMessages.length;

				/**
				 * A wrap-up step is itself a request, so it must be genuinely affordable.
				 *
				 * Judged against the size of the last request, since the next one will be
				 * at least that large. Arming a wrap-up that the pre-request triage then
				 * refuses would emit a `wrap-up` event for a step that never happens —
				 * announcing a handoff and then not delivering one, which is worse than
				 * staying quiet. With no rails set both checks are vacuously true, so a
				 * step-limited run always gets its handoff.
				 */
				const canAffordWrapUp = (): boolean =>
					!spendExhausted(lastRequestTokens);

				/**
				 * Progress accounting for this step.
				 *
				 * Reset by any mutating tool call, which is the whole definition of
				 * progress for this purpose. It deliberately does not count `bash` alone
				 * as progress if the command was a no-op — it cannot know that without
				 * parsing, and a run that shells out forever without editing anything is
				 * the exact case the guard exists for. Counting the *call* rather than
				 * its effect is the honest limit of what a harness can see.
				 */
				if (mutatedThisStep) {
					stepsSinceMutation = 0;
					repeatStrikes = 0;
				} else {
					stepsSinceMutation += 1;
				}
				mutatedThisStep = false;

				/**
				 * opencode's doom-loop detector, adapted.
				 *
				 * Three consecutive steps whose entire tool-call set is the same single
				 * call. That exactness is the point: a step that also did something else
				 * is doing something, and comparing only the *first* call would fire on a
				 * run that reads a file and then greps for it, which is ordinary work.
				 *
				 * Warned rather than stopped, because unlike the step cap this signal can
				 * be a coincidence — a test genuinely failing the same way twice, a build
				 * that needs a flag the model is about to find. opencode asks the user;
				 * a harness cannot, so the next best thing is to put the observation in
				 * front of the model while there is still budget to act on it.
				 */
				if (stepToolNames.length > 0)
					toolCallsByStep.push({ step, toolNames: [...stepToolNames] });
				const singleCall =
					stepCallSignatures.length === 1 ? stepCallSignatures[0] : undefined;
				recentSteps.push(
					singleCall ?? `\u0000multi:${stepCallSignatures.length}`,
				);
				if (recentSteps.length > REPEAT_CALL_THRESHOLD) recentSteps.shift();
				let looping = false;
				if (
					singleCall !== undefined &&
					recentSteps.length === REPEAT_CALL_THRESHOLD &&
					recentSteps.every((entry) => entry === singleCall)
				) {
					looping = true;
					if (repeatWarnedFor !== singleCall) {
						repeatWarnedFor = singleCall;
						messages.push({
							role: "user",
							content: REPEAT_CALL_WARNING(
								singleCall.split("\u0000")[0] ?? "tool",
							),
						});
					} else {
						repeatStrikes += 1;
					}
				}
				stepCallSignatures = [];

				/**
				 * A budget or step ceiling is about to end the run. Spend the last
				 * affordable request on a clean handoff rather than cutting the agent off
				 * mid-task — but only once, and never on a path where the model has
				 * already answered or the caller has cancelled.
				 */
				const stopFor = (why: HarnessStopReason): boolean => {
					/**
					 * The wrap-up step runs on a one-step budget of its own, so reaching it
					 * trips `stepLimit` again.
					 *
					 * That is not a second stop — it is the end of the first one — and the
					 * reason the run is ending is still the one that started the wind-down.
					 * Relabelling it here reported every wind-down as a step ceiling, so a
					 * run stopped for making no progress came back saying `max-steps`, an
					 * opt-in limit that, by default, nothing had set.
					 */
					if (wrappedUp) {
						if (signal?.aborted) reason = "aborted";
						return true;
					}
					reason = why;
					const affordable = canAffordWrapUp();
					if (
						!wrapUpEnabled ||
						reason === "aborted" ||
						signal?.aborted ||
						!affordable ||
						/**
						 * A held call makes the very next request invalid, so a wrap-up step
						 * would fail rather than tidy up: the transcript ends in a
						 * `tool-call` with no result, and the SDK rejects that with
						 * `MissingToolResultsError`. It surfaces as a crashed run on the
						 * path where a caller rule and an approval happen to coincide, which
						 * is the worst place to discover it.
						 *
						 * Checked here rather than only at the approval stop, because this
						 * function is reached from every other stop reason too — and the
						 * caller-stop case is the one that bites, since a run is far more
						 * likely to be ended by a rule while a human is thinking than by a
						 * budget.
						 */
						pendingApprovals.length > 0
					) {
						return true;
					}
					wrappedUp = true;
					events.push({ type: "wrap-up", reason: why });
					messages.push({ role: "user", content: WRAP_UP_INSTRUCTION(why) });
					// Exactly one more step, whatever the step budget said.
					stepLimit = step + 1;
					return false;
				};

				if (spendExhausted(lastRequestTokens)) {
					if (stopFor("max-tokens")) break;
					continue;
				}
				if (finishReason === "length") {
					// Cut mid-sentence by the per-step output cap. Reported as `max-output`,
					// not `max-tokens`: this limits how much the model *wrote*, and
					// thinking tokens count against it, so pointing the reader at input
					// size or spend sends them to the one knob that cannot help.
					if (stopFor("max-output")) break;
					continue;
				}
				/**
				 * The caller's own rules, at the step boundary.
				 *
				 * Before the "did the model answer?" check, not after it, and that is the
				 * whole point. A rule about a coding agent going in circles has to be able
				 * to see a step the model finished on — a repeated "I'm done", a step that
				 * only verified git — and placed after that check the hook would only ever
				 * see steps that made tool calls, which is precisely the subset where such
				 * a rule has nothing to say.
				 *
				 * Skipped on the first step, where there is no history to inspect and a
				 * rule that fired would end every run before it began.
				 */
				if (options.shouldStop && step > 1) {
					const callerStop = await options.shouldStop({
						stepNumber: step,
						messages: [...messages],
						steps: toolCallsByStep.map((entry) => ({
							step: entry.step,
							toolNames: [...entry.toolNames],
						})),
					});
					if (callerStop) {
						if (stopFor("stopped-by-caller")) break;
						continue;
					}
				}

				/**
				 * A tool is waiting on a person, so the run stops here.
				 *
				 * Placed after the step's usage is recorded and after `shouldStop`, and
				 * for two reasons. Usage first, because the request that asked for
				 * approval was paid for whether or not anyone ever answers — dropping it
				 * would make a suspended run look free. `shouldStop` first, because a
				 * caller's rule may already have ended the run, and reporting
				 * `awaiting-approval` for a run the caller stopped would name a
				 * different cause than the one that applied.
				 *
				 * **Not** routed through `stopFor`, deliberately. A wrap-up step would
				 * spend a request asking the model to summarise while a destructive call
				 * sits unapproved — spending money to talk about work that is not
				 * happening, and appending a user message to a transcript whose
				 * unanswered tool call makes the next request invalid. The run ends
				 * cleanly and the caller resumes it when there is an answer.
				 *
				 * Automatic approvals never land here: they were decided in-step, the
				 * tool already ran, and `pendingApprovals` is empty for them.
				 */
				if (pendingApprovals.length > 0) {
						reason = "awaiting-approval";
						break;
					}

				if (!stepHadToolCalls(response.messages)) {
					// The model produced its final answer — but a human may already have
					// queued something while that was streaming. Dropping it here would
					// silently discard the message, so drain *both* queues and keep going.
					// A steer belongs here too: it is easy to type one just as the model
					// is wrapping up, and that is precisely when it must not be lost.
					const promoted =
						(steerQueue.length > 0 ? promote("steer") : 0) +
						(followUpQueue.length > 0 ? promote("follow-up") : 0);
					if (promoted > 0) {
						stepLimit = step + maxSteps;
						continue;
					}
					reason = "completed";
					break;
				}
				/**
				 * The only two ways a run stops for its own reasons.
				 *
				 * `max-steps` only fires when the caller asked for a ceiling, so by
				 * default it never does. What replaced it is the guard that measures the
				 * thing the ceiling was guessing at: a run that has stopped changing
				 * anything. Fifteen non-mutating steps in a row, having just declined to
				 * finish, is not a long task — it is a loop or a stall, and spending the
				 * rest of the session on it produces nothing.
				 *
				 * It sits after the "did the model answer?" check on purpose, so a run
				 * that decides it is finished is never overridden by a stale progress
				 * count from earlier in the turn.
				 */
				if (step >= stepLimit) {
					if (stopFor("max-steps")) break;
					continue;
				}
				if (
					stepsSinceMutation >= NO_PROGRESS_STEPS ||
					looping ||
					repeatStrikes >= REPEAT_STRIKE_LIMIT
				) {
					if (stopFor("no-progress")) break;
					continue;
				}

				// Context pressure, not spend: only compact when the next request is
				// genuinely large. Compacting early destroys the working memory the
				// agent needs to finish, which is far worse than a big prompt.
				if (await compactNow()) {
					requestMessages = messages;
					estimatedInputTokens = estimateRequestTokens(
						options.system,
						requestMessages,
					);
					cachedTailIndex = Math.min(cachedTailIndex, requestMessages.length);
					if (spendExhausted(lastRequestTokens)) {
						reason = "max-tokens";
						break;
					}
				}
			}
		} catch (e) {
			if (isAbortError(e) || signal?.aborted) {
				events.push({
					type: "finish",
					reason: "aborted",
					text: streamedText,
					usage: { ...usage },
				});
				events.close();
				settled = true;
				return {
					text: streamedText,
					reason: "aborted",
					steps,
					usage,
					messages,
					compactions,
					wrappedUp,
					// An abort can land mid-step, after a request part already asked for
					// approval, so this is not necessarily empty here. Reporting it keeps
					// "the user pressed Escape" and "a tool is still unapproved" from being
					// reported as the same empty list — the caller resuming from a
					// transcript needs to know a decision is outstanding.
					pendingApprovals: [...pendingApprovals],
				};
			}
			events.push({ type: "error", error: e });
			events.push({
				type: "finish",
				reason: "error",
				text: "",
				usage: { ...usage },
			});
			events.close();
			settled = true;
			throw e;
		}

		const text =
			reason === "aborted" ? streamedText : lastAssistantText(messages);
		events.push({ type: "finish", reason, text, usage: { ...usage } });
		events.close();
		settled = true;
		return {
			text,
			reason,
			steps,
			usage,
			messages,
			compactions,
			wrappedUp,
			pendingApprovals: [...pendingApprovals],
		};
	})();

	return {
		events: events.iterate(),
		result: resultPromise,
		steer: (text: string) => enqueue(steerQueue, text, "steer"),
		followUp: (text: string) => enqueue(followUpQueue, text, "follow-up"),
		interrupt: () => {
			if (!interruptController.signal.aborted) {
				interruptController.abort(new Error("interrupted"));
			}
		},
		pending: () => ({ steer: [...steerQueue], followUp: [...followUpQueue] }),
	};
};
