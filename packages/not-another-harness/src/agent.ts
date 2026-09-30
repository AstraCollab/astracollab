import { streamText, stepCountIs, type ModelMessage, type ToolSet } from "ai";

import { compactMessages } from "./compaction.js";
import type {
  HarnessEvent,
  HarnessRun,
  HarnessRunOptions,
  HarnessRunResult,
  HarnessStopReason,
  HarnessUsage,
} from "./types.js";

const DEFAULT_MAX_STEPS = 32;
const DEFAULT_MAX_TOKENS = 400_000;
const DEFAULT_MAX_OUTPUT_TOKENS = 8_192;
const DEFAULT_COMPACT_AT_TOKENS = 120_000;
const DEFAULT_KEEP_RECENT = 6;

/** Rough estimate used only when the provider omits usage. */
const estimateTokens = (value: unknown, charsPerToken = 4): number =>
  Math.ceil((typeof value === "string" ? value.length : JSON.stringify(value ?? "").length) / charsPerToken);

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
 */
export const runAgent = (options: HarnessRunOptions): HarnessRun => {
  const events = new EventQueue();

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

    events.push({ type: "run-start", stepBudget: maxSteps, tokenBudget: maxTokens });

    try {
      for (let step = 1; step <= maxSteps; step += 1) {
        if (options.abortSignal?.aborted) {
          reason = "aborted";
          break;
        }

        const remainingTokens = maxTokens > 0 ? maxTokens - usage.totalTokens : Number.POSITIVE_INFINITY;
        const requestMessages = messages;
        const estimatedInputTokens = estimateTokens({ system: options.system, messages: requestMessages }, 3);
        if (maxTokens > 0 && remainingTokens <= estimatedInputTokens) {
          reason = "max-tokens";
          break;
        }

        const stepOutputLimit = Math.min(
          maxOutputTokens,
          maxTokens > 0 ? Math.max(1, remainingTokens - estimatedInputTokens) : maxOutputTokens,
        );
        steps = step;
        await options.onStepStart?.(step, [...messages]);
        events.push({ type: "step-start", step });

        const stepResult = streamText({
          model: options.model,
          system: options.system,
          messages: requestMessages,
          tools: options.tools as ToolSet,
          abortSignal: options.abortSignal,
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
        } else {
          const estimatedInput = estimateTokens({ system: options.system, messages: requestMessages });
          const estimatedOutput = estimateTokens(response.messages.filter((message) => message.role === "assistant"));
          usage.inputTokens += estimatedInput;
          usage.outputTokens += estimatedOutput;
          usage.totalTokens += estimatedInput + estimatedOutput;
          usage.estimated = true;
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
          reason = "completed";
          break;
        }
        if (step === maxSteps) {
          reason = "max-steps";
          break;
        }

        if (compactionMode !== "off" && usage.totalTokens >= compactAt) {
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
      if (isAbortError(e) || options.abortSignal?.aborted) {
        events.push({ type: "finish", reason: "aborted", text: streamedText, usage: { ...usage } });
        events.close();
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
      throw e;
    }

    const text = reason === "aborted" ? streamedText : lastAssistantText(messages);
    events.push({ type: "finish", reason, text, usage: { ...usage } });
    events.close();
    return {
      text,
      reason,
      steps,
      usage,
      messages,
      compactions,
    };
  })();

  return { events: events.iterate(), result: resultPromise };
};
