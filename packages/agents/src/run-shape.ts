/**
 * Reading a finished run.
 *
 * ## Why most of this file used to be 400 lines
 *
 * `coding-agent.ts` carried four large functions whose only job was digging
 * information back out of a Mastra `generate` result: which tools ran, which
 * commands were executed, and what the agent finally said. Each one probed for
 * the same value across half a dozen shapes, because the result is loosely typed
 * and its shape varies with the model — `pickCodingAgentSummaryFromGenerateRun`
 * is ~107 lines whose first fallback exists because, as its own comment says,
 * "Mastra `generate` may leave top-level `text` empty while steps/messages/parts
 * hold content".
 *
 * None of that is needed here. `HarnessRunResult` carries `text` already
 * resolved, and `messages` is a typed array whose tool calls are structured
 * parts. So this is not a port of those functions; it is their replacement, and
 * it is an order of magnitude smaller.
 *
 * The dedupe-and-cap logic that went with the summary picker **was** real product
 * behaviour, so it is kept verbatim in substance: models repeat themselves, and a
 * PR body built from a raw completion looks broken.
 */
import type { HarnessRunResult } from "not-another-harness";
import type { ModelMessage } from "ai";

const CODING_AGENT_SUMMARY_MAX_CHARS = 500;

type ToolCall = { toolCallId: string; toolName: string; input: unknown };

/** Every tool call in the run, in call order. */
export const toolCallsIn = (result: Pick<HarnessRunResult, "messages">): ToolCall[] => {
  const calls: ToolCall[] = [];
  for (const message of result.messages as unknown as ModelMessage[]) {
    if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
    for (const part of message.content as unknown as Array<Record<string, unknown>>) {
      if (part.type !== "tool-call") continue;
      calls.push({
        toolCallId: String(part.toolCallId ?? ""),
        toolName: String(part.toolName ?? ""),
        input: part.input,
      });
    }
  }
  return calls;
};

/** Distinct tool names, in first-seen order. */
export const toolNamesFrom = (
  result: Pick<HarnessRunResult, "messages">,
  options: { limit?: number } = {},
): string[] => {
  const limit = options.limit ?? Number.POSITIVE_INFINITY;
  const seen = new Set<string>();
  const names: string[] = [];
  for (const call of toolCallsIn(result)) {
    if (!call.toolName || seen.has(call.toolName)) continue;
    seen.add(call.toolName);
    names.push(call.toolName);
    if (names.length >= limit) break;
  }
  return names;
};

/** The names of calls to one tool, for a gate that checks a specific one ran. */
export const calledTool = (
  result: Pick<HarnessRunResult, "messages">,
  toolName: string,
): boolean => toolNamesFrom(result).includes(toolName);

/**
 * Shell commands the agent ran, in order.
 *
 * A completion gate needs the commands and not just the count: an agent that ran
 * `git status` has not verified anything, and a gate that only counted tool calls
 * would pass it.
 */
export const executeCommandsFrom = (
  result: Pick<HarnessRunResult, "messages">,
  tools: readonly string[] = ["bash", "execute_command"],
): string[] => {
  const commands: string[] = [];
  for (const call of toolCallsIn(result)) {
    if (!tools.includes(call.toolName)) continue;
    const input = call.input as { command?: unknown } | null;
    const command = typeof input?.command === "string" ? input.command.trim() : "";
    if (command) commands.push(command);
  }
  return commands;
};

/**
 * Calls the run recorded no successful result for.
 *
 * A `tool-call` part says the model *asked*; the paired `tool` message says what
 * happened. Ignoring the second is how a completion gate ends up asserting that a
 * run changed files when every `edit` it attempted failed on a stale path — the
 * transcript says both things, in order, and a reader that stops at the call sees
 * only the flattering half.
 *
 * A call with **no** result message counts as unsuccessful, which is the honest
 * reading: the SDK always writes one for a tool it executed, so its absence means
 * the run was cut off before the tool settled.
 *
 * Success is `text` or `json` output. Everything else the SDK can write —
 * `error-text`, `error-json`, `execution-denied`, `output-denied` — means the tool
 * did not do the thing that was asked of it.
 */
const callsWithoutSuccess = (result: Pick<HarnessRunResult, "messages">): Set<string> => {
  const succeeded = new Set<string>();
  const failed = new Set<string>();
  for (const message of result.messages as unknown as ModelMessage[]) {
    if (message.role !== "tool" || !Array.isArray(message.content)) continue;
    for (const part of message.content as unknown as Array<Record<string, unknown>>) {
      if (part.type !== "tool-result") continue;
      const id = String(part.toolCallId ?? "");
      const outputType = (part.output as { type?: string } | undefined)?.type;
      if (outputType === "text" || outputType === "json") succeeded.add(id);
      else failed.add(id);
    }
  }
  const unsuccessful = new Set(failed);
  for (const call of toolCallsIn(result)) {
    if (!succeeded.has(call.toolCallId)) unsuccessful.add(call.toolCallId);
  }
  return unsuccessful;
};

/** Did the run actually change anything? */
export const wroteFiles = (
  result: Pick<HarnessRunResult, "messages">,
  tools: readonly string[] = ["write", "write_file", "edit", "edit_file", "apply_patch"],
): boolean => {
  const unsuccessful = callsWithoutSuccess(result);
  return toolCallsIn(result).some(
    (call) => tools.includes(call.toolName) && !unsuccessful.has(call.toolCallId),
  );
};

const normalizeParagraph = (text: string): string => text.replace(/\s+/g, " ").trim().toLowerCase();

const splitChunks = (text: string): string[] => {
  if (text.includes("\n\n")) {
    return text
      .split(/\n{2,}/)
      .map((part) => part.trim())
      .filter((part) => part.length > 0);
  }
  const withBoundaries = text.replace(/([.!?])([A-Z"'])/g, "$1 $2");
  const sentenceCount = (withBoundaries.match(/[.!?](?:\s|$)/g) ?? []).length;
  if (sentenceCount < 2 && text.length < 200) return [text];
  return withBoundaries
    .split(/(?<=[.!?])\s+/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
};

/**
 * The first five words, with trailing punctuation stripped from the last one.
 *
 * The original built this key from the first five words verbatim, so
 * `"The change is in src/a.ts."` keyed differently from any restatement of it —
 * a sentence-ending period was enough to defeat every duplicate check, because
 * none of the fallbacks fire on a pair that differs by one character at the end.
 * Observed while porting, not invented.
 *
 * Stripping punctuation can only make this key match more often, never less, so
 * the risk is collapsing two sentences that share a five-word opening and differ
 * only in punctuation — which is a duplicate by any reasonable reading.
 */
const coreKey = (text: string): string =>
  normalizeParagraph(text)
    .split(/\s+/)
    .slice(0, 5)
    .join(" ")
    .replace(/[.,;:!?]+$/, "");

const nearDuplicates = (a: string, b: string): boolean => {
  const na = normalizeParagraph(a);
  const nb = normalizeParagraph(b);
  if (na === nb) return true;
  if (coreKey(a) === coreKey(b)) return true;
  if (na.length < 24 || nb.length < 24) return false;
  const prefix = Math.min(80, na.length, nb.length);
  if (na.slice(0, prefix) === nb.slice(0, prefix)) return true;
  return na.includes(nb.slice(0, 48)) || nb.includes(na.slice(0, 48));
};

/**
 * Collapse repeated completion spam and cap the length.
 *
 * Models restate the same sentence when a tool result repeats, and a PR body
 * built from that reads as though the agent is confused. The near-duplicate check
 * is deliberately loose — a false positive costs one sentence of a summary, while
 * a false negative ships visible repetition to a customer's pull request.
 */
export const dedupeAndCapSummary = (
  text: string,
  maxChars = CODING_AGENT_SUMMARY_MAX_CHARS,
): string => {
  const trimmed = text.trim();
  if (trimmed.length === 0) return "";
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const chunk of splitChunks(trimmed)) {
    const key = normalizeParagraph(chunk);
    if (key.length < 12) {
      unique.push(chunk);
      continue;
    }
    if (seen.has(key)) continue;
    const core = coreKey(chunk);
    if (core.length >= 12 && seen.has(`core:${core}`)) continue;
    if (unique.some((prior) => nearDuplicates(prior, chunk))) continue;
    seen.add(key);
    if (core.length >= 12) seen.add(`core:${core}`);
    unique.push(chunk);
  }
  const joined = (unique.length > 0 ? unique : [trimmed]).join(" ");
  return joined.length > maxChars ? `${joined.slice(0, maxChars - 1)}…` : joined;
};

/**
 * What the agent said, deduped and capped.
 *
 * One line, where the Mastra version was 107. `result.text` is already the last
 * assistant message's text, so there is nothing to fall back to.
 */
export const summaryFrom = (result: Pick<HarnessRunResult, "text">, maxChars?: number): string =>
  dedupeAndCapSummary(result.text ?? "", maxChars);

/** Token and step accounting, for the structured log line a turn emits. */
export const usageSummary = (result: Pick<HarnessRunResult, "usage" | "steps" | "reason">) => ({
  steps: result.steps,
  inputTokens: result.usage.inputTokens,
  outputTokens: result.usage.outputTokens,
  cachedInputTokens: result.usage.cachedInputTokens ?? 0,
  spendUsd: result.usage.spendUsd,
  reason: result.reason,
});