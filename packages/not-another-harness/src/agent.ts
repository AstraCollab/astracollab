import { streamText, stepCountIs, type ModelMessage, type ToolSet } from "ai";
import type { SharedV2ProviderOptions } from "@ai-sdk/provider";

import { compactMessages } from "./compaction.js";
import {
  cacheOptions,
  contextManagementOptions,
  supportsCaching,
  withCachedTail,
  withCachedToolSchemas,
} from "./cache.js";
import { createStepDedupe } from "./dedupe.js";
import { createReadCoverage } from "./read-coverage.js";
import { pruneOldToolResults } from "./prune.js";
import { createSpendMeter, usageCostUsd } from "./spend.js";
import { estimateMessageTokens, estimateRequestTokens } from "./estimate.js";
import type {
  HarnessEvent,
  HarnessRun,
  HarnessRunOptions,
  HarnessRunResult,
  HarnessSteerDelivery,
  HarnessStopReason,
  HarnessUsage,
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
        `Nothing has changed in the working tree for the last stretch of steps, so this run is stopping rather ` +
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
const WRAP_UP_INSTRUCTION = (why: HarnessStopReason): string => `${stopReasonExplanation(why)}

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
  `${step} steps so far and nothing in the working tree has changed. Each of those steps re-sent this whole ` +
  "transcript to the model, so the cost is already paid many times over for zero output.\n" +
  "If you know enough to act, make the change now with `edit` — a small wrong edit you can correct is " +
  "cheaper than another search. If you genuinely still need to look, name the one question the next two " +
  "steps must answer, and stop searching once it is answered.";

/**
 * Tools whose use means the run has stopped reading and started doing.
 *
 * `bash` counts even when it only prints, because a run that has shelled out has
 * usually built or tested something, and either way it is not still hunting for
 * a file.
 */
const MUTATING_TOOL_NAMES = new Set(["edit", "write", "bash", "multi_edit", "notebook_edit", "apply_patch"]);

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
  `You have made the identical \`${toolName}\` call three steps running and nothing has come of it. The same ` +
  "call returns the same result, so it is not telling you anything you do not already have.\n" +
  "Change the approach rather than repeating it: read a different file, widen the search, or say plainly what " +
  "you are stuck on and what you would need to get past it. If the work is genuinely done, say so and stop.";

const emptyUsage = (): HarnessUsage => ({ inputTokens: 0, outputTokens: 0, totalTokens: 0, estimated: false });

const addUsage = (acc: HarnessUsage, step: Partial<HarnessUsage> | undefined): HarnessUsage => {
  acc.inputTokens += step?.inputTokens ?? 0;
  acc.outputTokens += step?.outputTokens ?? 0;
  acc.totalTokens += step?.totalTokens ?? (step?.inputTokens ?? 0) + (step?.outputTokens ?? 0);
  acc.cachedInputTokens = (acc.cachedInputTokens ?? 0) + (step?.cachedInputTokens ?? 0);
  acc.cacheCreationInputTokens = (acc.cacheCreationInputTokens ?? 0) + (step?.cacheCreationInputTokens ?? 0);
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
  const anthropic = (metadata as { anthropic?: Record<string, unknown> } | undefined)?.anthropic;
  const value = anthropic?.cacheCreationInputTokens;
  return typeof value === "number" ? value : 0;
};

/**
 * Combine the caller's signal with the run's own interrupt signal.
 * Hand-rolled because `AbortSignal.any` is not in the ES2022 lib.
 */
const linkSignals = (...signals: Array<AbortSignal | undefined>): AbortSignal | undefined => {
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
    signal.addEventListener("abort", () => abort(signal.reason), { once: true });
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

  const enqueue = (queue: string[], text: string, delivery: HarnessSteerDelivery): boolean => {
    const trimmed = text.trim();
    if (!trimmed || settled) {
      return false;
    }
    queue.push(trimmed);
    events.push({ type: "user-message", text: trimmed, delivery, phase: "queued" });
    return true;
  };

  const resultPromise = (async (): Promise<HarnessRunResult> => {
    /**
     * `Infinity` by default, so `stepLimit` and the steer arithmetic below need no
     * special case: `step + Infinity` is `Infinity`, which is the correct answer
     * for "grant a fresh window" when there was no window to begin with.
     */
    const maxSteps = options.maxSteps === undefined
      ? DEFAULT_MAX_STEPS
      : Math.max(1, Math.floor(options.maxSteps));
    // Deprecated token budget, still honoured. See `maxSpendUsd` for why a token
    // count is the wrong unit for a spend ceiling.
    const maxTokens = Math.max(0, Math.floor(options.maxTokens ?? DEFAULT_MAX_TOKENS));
    const maxSpendUsd = Math.max(0, options.maxSpendUsd ?? 0);
    const maxContextTokens = Math.max(0, Math.floor(options.maxContextTokens ?? 0));
    const maxOutputTokens = Math.max(1, Math.floor(options.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS));
    const compactAt = Math.max(
      10_000,
      Math.floor(options.compactAtTokens ?? DEFAULT_COMPACT_AT_TOKENS),
    );
    const compactionMode = options.compaction ?? "model";
    const keepRecent = Math.max(2, Math.floor(options.compactKeepRecent ?? DEFAULT_KEEP_RECENT));
    const wrapUpEnabled = options.wrapUpOnLimit !== false;
    const spend = options.rates ? createSpendMeter(options.rates) : null;

    let messages: ModelMessage[] = [...(options.messages ?? [])];
    messages.push({ role: "user", content: options.prompt });

    const usage = emptyUsage();
    let compactions = 0;
    let steps = 0;
    let wrappedUp = false;
    let streamedText = "";
    let reason: HarnessStopReason = "completed";
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
    const cachedTools = withCachedToolSchemas(coverage.tools, options.cacheProvider, options.cacheTtl);
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
        events.push({ type: "user-message", text, delivery, phase: "delivered" });
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
  const compactNow = async (opts: { force?: boolean } = {}): Promise<boolean> => {
    if (compactionMode === "off") return false;
    if (!opts.force && lastRequestTokens < compactAt) return false;
    const compacted = await compactMessages({
      model: options.model,
      system: options.system,
      messages,
      keepRecent,
      mode: compactionMode,
      ...(maxTokens > 0 ? { maxTokensRemaining: Math.max(0, maxTokens - usage.totalTokens) } : {}),
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
      maxSpendUsd > 0 && spend ? maxSpendUsd - spend.total() : Number.POSITIVE_INFINITY;

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
      const observedOutput = steps > 0 ? usage.outputTokens / steps : maxOutputTokens;
      return usageCostUsd({ inputTokens, outputTokens: observedOutput }, options.rates);
    };

    /** Whether either ceiling is close enough that compaction is worth buying. */
    const underSpendPressure = (inputTokens: number): boolean => {
      if (tokenRailLeft() <= inputTokens + COMPACTION_RESERVE_TOKENS) return true;
      if (dollarRailLeft() <= projectedStepCostUsd(inputTokens) * COMPACTION_RESERVE_MULTIPLIER) {
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
        allowance = Math.min(allowance, afterInput / ((rates.output || 1) / 1_000_000));
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
          const pruned = pruneOldToolResults(messages, options.pruneToolResults.keepRecentToolCalls, {
            // Reasoning signatures are an Anthropic concept. Without this the
            // guard fired for every provider, so pruning never ran anywhere.
            provider: options.cacheProvider,
            // `LanguageModel` is `string | LanguageModelV2`, so the id is only
            // reachable on the object arm.
            modelId: typeof options.model === "string" ? options.model : options.model.modelId,
          });
          requestMessages = pruned.messages;
        }
        let estimatedInputTokens = estimateRequestTokens(options.system, requestMessages);

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
            estimatedInputTokens = estimateRequestTokens(options.system, requestMessages);
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
          if (canAffordSummary && stepsLeft && (await compactNow({ force: true }))) {
            requestMessages = messages;
            estimatedInputTokens = estimateRequestTokens(options.system, requestMessages);
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
          model: options.model,
          system: options.system,
          messages: cachedRequestMessages,
          tools: cachedTools as ToolSet,
          ...(effectiveProviderOptions ? { providerOptions: effectiveProviderOptions } : {}),
          abortSignal: signal,
          maxOutputTokens: stepOutputLimit,
          // One model round-trip (+ its tool executions) per loop iteration —
          // stop conditions, compaction, and events live in *this* loop.
          stopWhen: stepCountIs(1),
        });

        for await (const part of stepResult.fullStream) {
          if (part.type === "text-delta") {
            streamedText += part.text;
            events.push({ type: "text-delta", step, text: part.text });
          } else if (part.type === "tool-call") {
            if (MUTATING_TOOL_NAMES.has(part.toolName)) {
              mutations += 1;
              mutatedThisStep = true;
            }
            stepCallSignatures.push(toolCallSignature(part.toolName, part.input));
            events.push({
              type: "tool-call",
              step,
              toolCallId: part.toolCallId,
              toolName: part.toolName,
              input: part.input,
            });
          } else if (part.type === "tool-result") {
            const output = part.output;
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
          } else if (part.type === "error") {
            throw part.error instanceof Error ? part.error : new Error(String(part.error));
          }
        }

        const [response, stepUsage, finishReason, providerMetadata] = await Promise.all([
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
          tokenDetails?.cacheWriteTokens || readCacheCreationTokens(providerMetadata);
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
              Math.max(0, inputTokens - cachedInputTokens - cacheCreationInputTokens),
            hitRate: requestSize > 0 ? Math.min(1, cachedInputTokens / requestSize) : 0,
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
        const canAffordWrapUp = (): boolean => !spendExhausted(lastRequestTokens);

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
        const singleCall = stepCallSignatures.length === 1 ? stepCallSignatures[0] : undefined;
        recentSteps.push(singleCall ?? `\u0000multi:${stepCallSignatures.length}`);
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
              content: REPEAT_CALL_WARNING(singleCall.split("\u0000")[0] ?? "tool"),
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
          if (!wrapUpEnabled || reason === "aborted" || signal?.aborted || !affordable) {
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
        if (stepsSinceMutation >= NO_PROGRESS_STEPS || looping || repeatStrikes >= REPEAT_STRIKE_LIMIT) {
          if (stopFor("no-progress")) break;
          continue;
        }

        // Context pressure, not spend: only compact when the next request is
        // genuinely large. Compacting early destroys the working memory the
        // agent needs to finish, which is far worse than a big prompt.
        if (await compactNow()) {
          requestMessages = messages;
          estimatedInputTokens = estimateRequestTokens(options.system, requestMessages);
          cachedTailIndex = Math.min(cachedTailIndex, requestMessages.length);
          if (spendExhausted(lastRequestTokens)) {
            reason = "max-tokens";
            break;
          }
        }
      }
    } catch (e) {
      if (isAbortError(e) || signal?.aborted) {
        events.push({ type: "finish", reason: "aborted", text: streamedText, usage: { ...usage } });
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
        };
      }
      events.push({ type: "error", error: e });
      events.push({ type: "finish", reason: "error", text: "", usage: { ...usage } });
      events.close();
      settled = true;
      throw e;
    }

    const text = reason === "aborted" ? streamedText : lastAssistantText(messages);
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
