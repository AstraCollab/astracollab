import { streamText, stepCountIs, type ModelMessage, type ToolSet } from "ai";

import { compactMessages } from "./compaction.js";
import { cacheOptions, withCachedToolSchemas } from "./cache.js";
import { createStepDedupe } from "./dedupe.js";
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
const DEFAULT_MAX_TOKENS = 400_000;
const DEFAULT_MAX_OUTPUT_TOKENS = 8_192;
const DEFAULT_COMPACT_AT_TOKENS = 120_000;
const DEFAULT_KEEP_RECENT = 6;

const emptyUsage = (): HarnessUsage => ({ inputTokens: 0, outputTokens: 0, totalTokens: 0, estimated: false });

const addUsage = (acc: HarnessUsage, step: Partial<HarnessUsage> | undefined): HarnessUsage => {
  acc.inputTokens += step?.inputTokens ?? 0;
  acc.outputTokens += step?.outputTokens ?? 0;
  acc.totalTokens += step?.totalTokens ?? (step?.inputTokens ?? 0) + (step?.outputTokens ?? 0);
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

const isAbortError = (e: unknown): boolean => {
  const name = (e as { name?: string } | null)?.name ?? "";
  return name === "AbortError" || name === "TimeoutError";
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
    const maxTokens = Math.max(0, Math.floor(options.maxTokens ?? DEFAULT_MAX_TOKENS));
    const maxOutputTokens = Math.max(1, Math.floor(options.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS));
    const compactAt = Math.max(
      10_000,
      Math.floor(options.compactAtTokens ?? DEFAULT_COMPACT_AT_TOKENS),
    );
    const compactionMode = options.compaction ?? "model";
    const keepRecent = Math.max(2, Math.floor(options.compactKeepRecent ?? DEFAULT_KEEP_RECENT));

    let messages: ModelMessage[] = [...(options.messages ?? [])];
    messages.push({ role: "user", content: options.prompt });

    const usage = emptyUsage();
    let compactions = 0;
    let steps = 0;
    let streamedText = "";
    let reason: HarnessStopReason = "completed";
    /**
     * Size of the most recent request as the provider counted it. Every step
     * re-sends the whole transcript, so *cumulative* usage is not a measure of
     * context pressure — the same tokens are billed again on every step. The
     * last step's real input count is the only honest signal for "is the next
     * request about to overflow", so that is what drives compaction.
     */
    let lastRequestTokens = estimateRequestTokens(options.system, messages);

    events.push({ type: "run-start", stepBudget: maxSteps, tokenBudget: maxTokens });

    // Collapses identical tool calls emitted twice in the same step. The memo is
    // cleared per step, so re-running a command later — after an edit — still
    // works normally.
    const dedupe = createStepDedupe(options.tools);
    // Tool definitions and the system prompt are re-sent verbatim every step, so
    // they carry cache breakpoints. Marking a prefix is safe; rewriting one is
    // not, because editing a prior tool_result invalidates Anthropic's
    // thinking-block signatures.
    const cachedTools = withCachedToolSchemas(dedupe.tools, options.cacheProvider, options.cacheTtl);
    const providerOptions = cacheOptions(options.cacheProvider, options.cacheTtl);

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

    try {
      let step = 0;
      let stepLimit = maxSteps;
      while (step < stepLimit) {
        step += 1;
        if (signal?.aborted) {
          reason = "aborted";
          break;
        }

        const remainingTokens = maxTokens > 0 ? maxTokens - usage.totalTokens : Number.POSITIVE_INFINITY;
        // Steers land here: after the previous step's tools settled, before this
        // request is assembled, so nothing is ever cut off mid-token.
        if (steerQueue.length > 0 && promote("steer") > 0) {
          // A human just gave the agent more work. Grant a fresh step window so
          // `maxSteps` cannot silently drop a message they deliberately sent.
          stepLimit = step + maxSteps;
        }
        const requestMessages = messages;
        const estimatedInputTokens = estimateRequestTokens(options.system, requestMessages);
        if (maxTokens > 0 && remainingTokens <= estimatedInputTokens) {
          reason = "max-tokens";
          break;
        }

        const stepOutputLimit = Math.min(
          maxOutputTokens,
          maxTokens > 0 ? Math.max(1, remainingTokens - estimatedInputTokens) : maxOutputTokens,
        );
        steps = step;
        dedupe.beginStep();
        await options.onStepStart?.(step, [...messages]);
        events.push({ type: "step-start", step });

        const stepResult = streamText({
          model: options.model,
          system: options.system,
          messages: requestMessages,
          tools: cachedTools as ToolSet,
          ...(providerOptions ? { providerOptions } : {}),
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

        const [response, stepUsage, finishReason] = await Promise.all([
          stepResult.response,
          stepResult.usage,
          stepResult.finishReason,
        ]);
        messages.push(...response.messages);
        await options.onStepFinish?.(step, [...messages]);
        const inputTokens = stepUsage.inputTokens ?? 0;
        const outputTokens = stepUsage.outputTokens ?? 0;
        const totalTokens = stepUsage.totalTokens ?? inputTokens + outputTokens;
        if (totalTokens > 0 || inputTokens > 0 || outputTokens > 0) {
          addUsage(usage, { inputTokens, outputTokens, totalTokens });
          lastRequestTokens = inputTokens > 0 ? inputTokens : lastRequestTokens;
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
        events.push({ type: "step-finish", step, usage: { ...usage } });

        if (maxTokens > 0 && usage.totalTokens >= maxTokens) {
          reason = "max-tokens";
          break;
        }
        if (finishReason === "length") {
          reason = "max-tokens";
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
        if (step >= stepLimit) {
          reason = "max-steps";
          break;
        }

        // Context pressure, not spend: only compact when the next request is
        // genuinely large. Compacting early destroys the working memory the
        // agent needs to finish the task, which is far worse than a big prompt.
        if (compactionMode !== "off" && lastRequestTokens >= compactAt) {
          const compacted = await compactMessages({
            model: options.model,
            system: options.system,
            messages,
            keepRecent,
            mode: compactionMode,
            maxTokensRemaining: maxTokens > 0 ? maxTokens - usage.totalTokens : undefined,
          });
          if (compacted) {
            addUsage(usage, compacted.usage);
            events.push({
              type: "compacted",
              droppedMessages: compacted.droppedMessages,
              keptMessages: compacted.messages.length,
              summaryChars: compacted.summaryChars,
            });
            messages = compacted.messages;
            compactions += 1;
            if (maxTokens > 0 && usage.totalTokens >= maxTokens) {
              reason = "max-tokens";
              break;
            }
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
