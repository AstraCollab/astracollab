import { generateText, type LanguageModel, type ModelMessage } from "ai";
import type { HarnessUsage } from "./types.js";

const estimateTokens = (value: string): number => Math.ceil(value.length / 4);

const toolOutputText = (part: Record<string, unknown>): string => {
  const output = part.output as { type?: string; value?: unknown } | string | undefined;
  if (typeof output === "string") return output;
  const value = output && typeof output === "object" ? output.value : undefined;
  return typeof value === "string" ? value : JSON.stringify(value ?? "");
};

/**
 * Mid-run transcript compaction.
 *
 * Long runs blow past the context window (or the budget) mostly because of
 * stale tool output. Compaction replaces the older half of the transcript with
 * a summary (the original messages stay in whatever session store the caller
 * keeps — this only changes what the next model request carries).
 */

const messageText = (msg: ModelMessage): string => {
  const content = msg.content;
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .map((part) => {
      if (part.type === "text") {
        return part.text;
      }
      if (part.type === "tool-call") {
        return `[tool call: ${part.toolName}]`;
      }
      if (part.type === "tool-result") {
        const text = toolOutputText(part as unknown as Record<string, unknown>);
        const isTaskLedger = part.toolName === "task_ledger";
        return `[tool result${isTaskLedger ? ": task_ledger" : ""}: ${text.slice(0, isTaskLedger ? 12_000 : 280)}]`;
      }
      return "";
    })
    .filter(Boolean)
    .join("\n");
};

/** Keep the most recent durable ledger snapshot and its latest check evidence verbatim. */
const latestTaskLedgerOutput = (messages: ModelMessage[]): string | null => {
  let latest: string | null = null;
  for (const message of messages) {
    if (typeof message.content === "string") {
      const start = "<durable-task-ledger-preserved-verbatim>\n";
      const end = "\n</durable-task-ledger-preserved-verbatim>";
      const startAt = message.content.lastIndexOf(start);
      const endAt = startAt < 0 ? -1 : message.content.indexOf(end, startAt + start.length);
      if (startAt >= 0 && endAt >= 0) latest = message.content.slice(startAt + start.length, endAt);
      continue;
    }
    if (!Array.isArray(message.content)) continue;
    for (const part of message.content) {
      if (part.type !== "tool-result" || part.toolName !== "task_ledger") continue;
      const text = toolOutputText(part as unknown as Record<string, unknown>);
      if (text.trim()) latest = text;
    }
  }
  return latest;
};

const SUMMARIZE_INSTRUCTION = `Summarize this coding-agent transcript prefix for a future model that will continue the task.
Preserve the user's original request verbatim, including exact strings to find/replace, replacement text, and path scope. The original user request is authoritative; assistant plans and prior summaries are fallible and must never change or override it.
Keep: the task, decisions made, files read/edited (with paths), commands run and their outcomes, anything still unresolved.
If a durable task plan or task_ledger output appears, preserve its goal, ordered step IDs and statuses, exact acceptance check commands, latest attempt exit codes, outputs, and results precisely.
Be terse — bullet points, no prose.`;

const summarizeWithModel = async (
  model: LanguageModel,
  system: string,
  chunk: ModelMessage[],
  maxOutputTokens: number,
): Promise<{ summary: string; usage: HarnessUsage }> => {
  const transcript = chunk
    .map((m) => `<${m.role}>\n${messageText(m).slice(0, 4000)}\n</${m.role}>`)
    .join("\n");
  const prompt = `${SUMMARIZE_INSTRUCTION}\n\n---\n\n${transcript}`;
  const result = await generateText({
    model,
    system,
    prompt,
    maxOutputTokens,
  });
  const estimatedInput = estimateTokens(`${system}\n${prompt}`);
  const estimatedOutput = estimateTokens(result.text);
  const inputTokens = result.usage.inputTokens ?? estimatedInput;
  const outputTokens = result.usage.outputTokens ?? estimatedOutput;
  return {
    summary: result.text.trim(),
    usage: {
      inputTokens,
      outputTokens,
      totalTokens: result.usage.totalTokens ?? inputTokens + outputTokens,
      estimated:
        result.usage.inputTokens == null ||
        result.usage.outputTokens == null ||
        result.usage.totalTokens == null,
    },
  };
};

export type CompactionOutcome = {
  messages: ModelMessage[];
  droppedMessages: number;
  summaryChars: number;
  usage: HarnessUsage;
};

/**
 * Start index for the verbatim tail, grown backwards until it begins on a
 * complete tool round.
 *
 * A `tool` message is only valid when the `tool-call` that produced it is also
 * in the transcript. Slicing on a raw message count routinely lands between an
 * assistant's tool calls and their results, which produces a transcript every
 * provider rejects (`tool_result` with no matching `tool_call`) and which the
 * AI SDK refuses to send at all. So we walk back until the first kept message is
 * not an orphaned tool result, which also re-admits its owning assistant message.
 */
export const alignTailToToolBoundary = (messages: ModelMessage[], keepRecent: number): number => {
  const wanted = Math.max(0, Math.min(keepRecent, messages.length));
  let start = messages.length - wanted;
  while (start > 0 && messages[start]?.role === "tool") {
    start -= 1;
  }
  return start;
};

/**
 * Compact `messages`, keeping the first user message (the task) and the last
 * `keepRecent` verbatim; everything between becomes one summary message.
 */
export const compactMessages = async (opts: {
  model: LanguageModel;
  system: string;
  messages: ModelMessage[];
  keepRecent: number;
  mode: "model" | "truncate";
  maxTokensRemaining?: number;
}): Promise<CompactionOutcome | null> => {
  const { messages, keepRecent } = opts;
  const tailStart = alignTailToToolBoundary(messages, keepRecent);
  // [task, ...middle..., ...recent]
  //
  // The question is whether the middle has anything in it. Expressing that
  // directly matters: deriving it from message counts instead makes the answer
  // depend on `keepRecent` in a way that silently disables compaction at small
  // values. Since `tailStart` is `length - keepRecent` for an aligned tail, a
  // `length <= tailStart + 2` guard reduces to `keepRecent <= 2` — so
  // `keepRecent: 2`, the minimum the agent loop allows, could never compact at
  // any transcript length.
  if (tailStart < 2) {
    return null;
  }
  const head = messages.slice(0, 1);
  const recent = messages.slice(tailStart);
  const middle = messages.slice(1, tailStart);
  if (middle.length === 0) {
    return null;
  }

  let summary: string;
  const ledgerSnapshot = latestTaskLedgerOutput(middle);
  let usage: HarnessUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0, estimated: false };
  const summaryInput = `${opts.system}\n${SUMMARIZE_INSTRUCTION}\n${middle.map(messageText).join("\n")}`;
  const estimatedSummaryInput = estimateTokens(summaryInput);
  const availableOutput =
    opts.maxTokensRemaining === undefined
      ? 2048
      : Math.min(2048, Math.max(1, opts.maxTokensRemaining - estimatedSummaryInput));
  const canSummarize =
    opts.mode === "model" &&
    (opts.maxTokensRemaining === undefined || opts.maxTokensRemaining > estimatedSummaryInput);
  try {
    if (canSummarize) {
      const summarized = await summarizeWithModel(
        opts.model,
        opts.system,
        middle,
        availableOutput,
      );
      summary = summarized.summary;
      usage = summarized.usage;
    } else {
      summary = middle
        .map((m) => `[${m.role}] ${messageText(m).slice(0, 160)}`)
        .join("\n")
        .slice(0, 12_000);
    }
  } catch {
    // Summarization failed (provider hiccup) — degrade to truncation so the
    // run still gets its context back under budget.
    summary = middle
      .map((m) => `[${m.role}] ${messageText(m).slice(0, 160)}`)
      .join("\n")
      .slice(0, 12_000);
    usage = {
      inputTokens: estimatedSummaryInput,
      outputTokens: 0,
      totalTokens: estimatedSummaryInput,
      estimated: true,
    };
  }

  if (ledgerSnapshot) {
    summary = `${summary}\n\n<durable-task-ledger-preserved-verbatim>\n${ledgerSnapshot}\n</durable-task-ledger-preserved-verbatim>`;
  }

  const compacted: ModelMessage[] = [
    ...head,
    {
      role: "user",
      content: `<compacted-history>\nThe transcript so far was compacted. Summary of earlier work:\n\n${summary}\n</compacted-history>`,
    },
    ...recent,
  ];
  return {
    messages: compacted,
    droppedMessages: messages.length - compacted.length,
    summaryChars: summary.length,
    usage,
  };
};
