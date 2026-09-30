import { generateText, type LanguageModel, type ModelMessage } from "ai";

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
        const output = part.output as { type?: string; value?: unknown } | undefined;
        const value = output?.value;
        const text = typeof value === "string" ? value : JSON.stringify(value ?? "");
        return `[tool result: ${text.slice(0, 280)}]`;
      }
      return "";
    })
    .filter(Boolean)
    .join("\n");
};

const SUMMARIZE_INSTRUCTION = `Summarize this coding-agent transcript prefix for a future model that will continue the task.
Keep: the task, decisions made, files read/edited (with paths), commands run and their outcomes, anything still unresolved.
Be terse — bullet points, no prose.`;

const summarizeWithModel = async (
  model: LanguageModel,
  system: string,
  chunk: ModelMessage[],
): Promise<string> => {
  const transcript = chunk
    .map((m) => `<${m.role}>\n${messageText(m).slice(0, 4000)}\n</${m.role}>`)
    .join("\n");
  const { text } = await generateText({
    model,
    system,
    prompt: `${SUMMARIZE_INSTRUCTION}\n\n---\n\n${transcript}`,
  });
  return text.trim();
};

export type CompactionOutcome = {
  messages: ModelMessage[];
  droppedMessages: number;
  summaryChars: number;
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
}): Promise<CompactionOutcome | null> => {
  const { messages, keepRecent } = opts;
  // [task, ...middle..., ...recent]
  if (messages.length <= keepRecent + 2) {
    return null;
  }
  const head = messages.slice(0, 1);
  const recent = messages.slice(-keepRecent);
  const middle = messages.slice(1, messages.length - keepRecent);
  if (middle.length === 0) {
    return null;
  }

  let summary: string;
  try {
    summary =
      opts.mode === "model"
        ? await summarizeWithModel(opts.model, opts.system, middle)
        : middle
            .map((m) => `[${m.role}] ${messageText(m).slice(0, 160)}`)
            .join("\n")
            .slice(0, 12_000);
  } catch {
    // Summarization failed (provider hiccup) — degrade to truncation so the
    // run still gets its context back under budget.
    summary = middle
      .map((m) => `[${m.role}] ${messageText(m).slice(0, 160)}`)
      .join("\n")
      .slice(0, 12_000);
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
  };
};
