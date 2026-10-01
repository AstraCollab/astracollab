/**
 * Client-side pruning of superseded tool results, made safe.
 *
 * Server-side context editing (`clear_tool_uses_20250919`) exists only on
 * Anthropic; no other provider exposes an equivalent. That leaves client-side
 * pruning as the only way to bound transcript growth everywhere.
 *
 * The blocker is that rewriting an earlier `tool_result` invalidates the
 * thinking-block signatures Anthropic binds to that prefix. So the safety
 * condition is not the provider name — it is whether the transcript actually
 * contains reasoning parts. With none present there are no signatures to
 * invalidate and pruning is safe on any provider. With reasoning present we skip
 * entirely and let server-side editing or compaction handle it.
 *
 * Two properties keep this cheap rather than pathological:
 *
 * - **Monotone.** A result is pruned once it falls outside the window and stays
 *   pruned. Re-deciding by similarity every turn would rewrite the prefix on every
 *   request, which restarts the prompt cache and invalidates signatures each time.
 * - **Whole tool rounds.** The window boundary is aligned so no `tool_result` is
 *   ever separated from the `tool_call` that produced it.
 */
import type { ModelMessage } from "ai";

export type PruneStats = {
  /** Tool results whose content was replaced. */
  pruned: number;
  /** Approximate tokens reclaimed. */
  savedTokens: number;
  /** True when pruning was skipped because reasoning blocks are present. */
  skippedForReasoning: boolean;
};

const PLACEHOLDER_PREFIX = "[output elided";

const isReasoningPart = (part: unknown): boolean =>
  typeof part === "object" && part !== null && (part as { type?: string }).type === "reasoning";

/** Reasoning anywhere in the transcript means signatures we must not disturb. */
export const transcriptHasReasoning = (messages: readonly ModelMessage[]): boolean =>
  messages.some((message) => Array.isArray(message.content) && message.content.some(isReasoningPart));

const textOf = (output: unknown): string => {
  if (typeof output === "string") return output;
  if (output && typeof output === "object" && "value" in output) {
    const value = (output as { value: unknown }).value;
    return typeof value === "string" ? value : "";
  }
  return "";
};

const elidedNote = (text: string): string => {
  const lines = text.split("\n").length;
  const chars = text.length;
  return `${PLACEHOLDER_PREFIX}: ${lines} line${lines === 1 ? "" : "s"}, ~${chars} chars removed. Re-run the tool if you need it again.]`;
};

/**
 * Replace the content of tool results older than the retained window.
 *
 * Only the `output` of a `tool-result` part changes. The block, its
 * `toolCallId`, its position, and the owning assistant `tool-call` all stay put,
 * so the tool_use/tool_result pairing the provider validates is untouched.
 */
export const pruneOldToolResults = (
  messages: readonly ModelMessage[],
  keepRecentToolCalls = 6,
): { messages: ModelMessage[]; stats: PruneStats } => {
  // At least one round always survives: eliding every result leaves the model
  // unable to see anything it has done.
  const keep = Math.max(1, Math.floor(keepRecentToolCalls));
  if (transcriptHasReasoning(messages)) {
    return {
      messages: [...messages],
      stats: { pruned: 0, savedTokens: 0, skippedForReasoning: true },
    };
  }

  // The kept window starts at the assistant message that issued the
  // keepRecent-th most recent tool call, so that call and its results all survive.
  // Walking back over tool-result messages matters: the previous version stopped
  // on the last message whatever it was, which pruned nothing at keepRecent 0.
  let seen = 0;
  let cutoffIndex = messages.length;

  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i]!;
    if (!Array.isArray(message.content)) continue;
    const calls = message.content.filter((p) => (p as { type?: string }).type === "tool-call").length;
    if (calls === 0) continue;
    seen += calls;
    if (seen >= Math.max(0, Math.floor(keepRecentToolCalls))) {
      cutoffIndex = i;
      break;
    }
  }

  let pruned = 0;
  let savedTokens = 0;
  const out: ModelMessage[] = messages.map((message, index) => {
    if (index >= cutoffIndex || !Array.isArray(message.content)) return message;
    let changed = false;
    const content = message.content.map((part) => {
      const p = part as { type?: string; output?: unknown };
      if (p.type !== "tool-result") return part;
      const text = textOf(p.output);
      if (text.length < 400) return part;
      const note = elidedNote(text);
      savedTokens += Math.ceil((text.length - note.length) / 4);
      pruned += 1;
      changed = true;
      // The SDK schema requires `output` to be an object for a tool-result part;
      // a bare string is rejected with AI_InvalidPromptError before the request is
      // ever sent. Only the text payload inside is replaced.
      return {
        ...p,
        output:
          p.output && typeof p.output === "object"
            ? { ...(p.output as Record<string, unknown>), value: note }
            : { type: "text", value: note },
      };
    });
    return changed ? ({ ...message, content } as ModelMessage) : message;
  });

  return { messages: out, stats: { pruned, savedTokens, skippedForReasoning: false } };
};