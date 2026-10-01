import { streamText, stepCountIs, type ModelMessage, type ToolSet } from "ai";
import type { SharedV2ProviderOptions } from "@ai-sdk/provider";

import { compactMessages } from "./compaction.js";
import {
  cacheAccountingFor,
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

const DEFAULT_MAX_STEPS = 32;
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
 * The instruction that turns a hard stop into a resumable state.
 *
 * A run that stops on a budget with nothing committed loses everything since the
 * last commit, and the next session has to reconstruct it from a half-finished
 * diff. Anthropic's long-running-harness work describes exactly this failure —
 * an agent running out of context mid-implementation and leaving a feature the
 * next session "must guess about" — and notes it happens even with compaction.
 *
 * So the last request is spent on handing off rather than on more work.
 */
const WRAP_UP_INSTRUCTION = `You are out of budget for this run. Stop starting new work and hand off cleanly.

Do exactly this, in order:
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
    const maxSteps = Math.max(1, Math.floor(options.maxSteps ?? DEFAULT_MAX_STEPS));
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
    const cacheAccounting = options.cacheAccounting ?? cacheAccountingFor(options.cacheProvider);

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

    events.push({ type: "run-start", stepBudget: maxSteps, tokenBudget: maxTokens });

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
      let mutations = 0;
      let nudged = false;
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
         * Placed beside the steer queue so a human's message always wins: if
         * both were pending, the nudge would otherwise be the last thing the
         * model read and read as a criticism of what they just asked for.
         */
        if (!nudged && step === EXPLORATION_NUDGE_AT_STEP && mutations === 0) {
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
            if (MUTATING_TOOL_NAMES.has(part.toolName)) mutations += 1;
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
        const totalTokens = stepUsage.totalTokens ?? inputTokens + outputTokens;
        /**
         * The cached portion, which the provider reports separately and which
         * `inputTokens` excludes once caching is active.
         *
         * Anthropic puts cache *writes* in `input_tokens` but cache *reads* in
         * `cache_read_input_tokens`, so the request's true size is the sum. The
         * SDK surfaces reads as `cachedInputTokens`; writes arrive in provider
         * metadata, and are read best-effort because the shape differs by provider.
         */
        const cachedInputTokens = stepUsage.cachedInputTokens ?? 0;
        const cacheCreationInputTokens = readCacheCreationTokens(providerMetadata);
        /**
         * The request's real input size.
         *
         * Depends on the provider's convention: Anthropic reports the cached
         * prefix outside `input_tokens`, OpenAI-compatible gateways include it.
         * Summing blindly double-counts the cached portion on the latter — which
         * on a healthy 90%-hit run inflates the reported context roughly 10x and
         * then drives compaction and the spend rail off a fiction.
         */
        const requestSize =
          cacheAccounting === "split"
            ? inputTokens + cachedInputTokens + cacheCreationInputTokens
            : inputTokens;
        if (totalTokens > 0 || inputTokens > 0 || outputTokens > 0) {
          const stepUsageDelta = {
            inputTokens,
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
            // On an inclusive provider the fresh portion is what is left after
            // the cached share; on a split one `inputTokens` already is that.
            freshInputTokens:
              cacheAccounting === "split" ? inputTokens : Math.max(0, inputTokens - cachedInputTokens),
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
         * A budget or step ceiling is about to end the run. Spend the last
         * affordable request on a clean handoff rather than cutting the agent off
         * mid-task — but only once, and never on a path where the model has
         * already answered or the caller has cancelled.
         */
        const stopFor = (why: HarnessStopReason): boolean => {
          const affordable = canAffordWrapUp();
          if (!wrapUpEnabled || wrappedUp || reason === "aborted" || signal?.aborted || !affordable) {
            reason = why;
            return true;
          }
          reason = why;
          wrappedUp = true;
          events.push({ type: "wrap-up", reason: why });
          messages.push({ role: "user", content: WRAP_UP_INSTRUCTION });
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
        if (step >= stepLimit) {
          if (stopFor("max-steps")) break;
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
