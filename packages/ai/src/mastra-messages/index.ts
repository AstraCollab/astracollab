/**
 * Message translation between Mastra's stored shape and the AI SDK's.
 *
 * ## Not the UI converter
 *
 * `@mastra/ai-sdk` already ships `toAISdkMessages`, and a codebase migrating off
 * Mastra usually has both converters in it. They are not interchangeable:
 *
 * - **`toAISdkMessages` → `UIMessage[]`** is the right tool for hydrating a chat
 *   pane. It is a display projection and is lossy by design — a screen never
 *   renders everything — so parts like an Anthropic thinking signature,
 *   `source-document` or data parts are simply not there.
 * - **This module → `ModelMessage[]`** is the right tool when messages are going
 *   *into* an agent or a store. It round-trips, and it refuses to drop a part
 *   type it does not recognise.
 *
 * Feeding an agent from `UIMessage[]` is the mistake worth naming: the turn runs
 * with degraded reasoning and nothing reports it. Rendering from `ModelMessage[]`
 * means hand-maintaining a `toAISdkMessages` equivalent Mastra already keeps
 * current.
 *
 * In `@astracollab/client`, this module's counterpart is
 * `lib/ai/workspace-ai-mastra-messages.ts`, which is the UI and import path.
 *
 * ## Migration is the reason this exists
 *
 * An agent loop written against `@mastra/core` reads `ModelMessage[]`, and a
 * store written against Mastra persists `content.parts`. Without a translation
 * one side has to be rewritten, and the part that gets lost in the rewrite is
 * always the one nobody was looking at.
 *
 * Two facts about the formats shape everything here.
 *
 * **A tool call is one part in Mastra and two messages in the AI SDK.** Mastra
 * stores `{type:'tool-invocation', toolInvocation:{args, result}}` on the
 * assistant message. The AI SDK puts `tool-call` on the assistant message and a
 * separate `{role:'tool'}` message carrying the result. So the mapping is not
 * one-to-one in either direction, and the *message count changes* — which is why
 * anything doing `messages.slice(before)` needs `sessionUpdate` instead.
 *
 * **Mastra has seven part types and the AI SDK has equivalents for about three.**
 * `step-start`, `error`, `source-url`, `source-document` and data parts have no
 * home in a `ModelMessage`. Dropping them silently produces a transcript that
 * looks fine and behaves worse every turn, so by default they are an error. The
 * escape hatch preserves them verbatim under `providerOptions` and restores them
 * on the way back.
 *
 * Provider-specific data rides in `providerMetadata` on Mastra's side and
 * `providerOptions` on the AI SDK's, and those map one-to-one — which is how an
 * Anthropic thinking signature survives the trip.
 */
import type { ModelMessage } from "ai";

/** Where this package keeps its own annotations, out of the provider's namespace. */
const ANNOTATION_KEY = "astracollab";
const UNMAPPED_KEY = "unmappedParts";

/**
 * A Mastra part, described structurally.
 *
 * Not imported from `@mastra/core` on purpose: the point of this package is to
 * help people leave Mastra, and typing against a dependency you are migrating off
 * makes every version bump a breaking change here. Only the fields actually read
 * are named.
 */
export type MastraPart = {
  type: string;
  [key: string]: unknown;
};

export type MastraContent = {
  /** Absent on rows written before `format: 2`. */
  format?: 2;
  parts?: MastraPart[];
  /** Legacy `UIMessageV4` fields, still present alongside `parts`. */
  content?: unknown;
  reasoning?: unknown;
  toolInvocations?: unknown;
  providerMetadata?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  [key: string]: unknown;
};

export type MastraMessage = {
  id?: string;
  role: string;
  content: MastraContent | string;
  createdAt?: Date;
  threadId?: string;
  resourceId?: string;
  type?: string;
};

type UnmappedPart = { index: number; part: MastraPart };

type Annotations = {
  /** True when this reasoning part was injected to satisfy a provider, not produced. */
  synthetic?: boolean;
  /** Parts with no AI SDK equivalent, kept with their original index. */
  unmappedParts?: UnmappedPart[];
};

const annotationsOf = (value: unknown): Annotations | undefined => {
  if (typeof value !== "object" || value === null) return undefined;
  const candidate = (value as { [ANNOTATION_KEY]?: unknown })[ANNOTATION_KEY];
  return typeof candidate === "object" && candidate !== null ? (candidate as Annotations) : undefined;
};

const withAnnotations = (base: Record<string, unknown> | undefined, annotations: Annotations): Record<string, unknown> | undefined => {
  const existing = (base ?? {}) as Record<string, unknown>;
  if (annotations.synthetic === undefined && annotations.unmappedParts === undefined) return existing;
  return { ...existing, [ANNOTATION_KEY]: annotations };
};

/** Part types with a direct AI SDK equivalent. Everything else is unmapped. */
const MAPPED_PART_TYPES = new Set(["text", "reasoning", "tool-invocation", "step-start"]);

export type FromMastraOptions = {
  /**
   * What to do with a part the AI SDK cannot express.
   *
   * `throw` by default. The alternative is not a detail: a silently dropped
   * `source-document` or data part produces a transcript that reads correctly
   * and is quietly wrong, and nothing downstream can tell.
   */
  onUnknownPart?: "throw" | "preserve";
};

export class UnmappablePartError extends Error {
  constructor(
    readonly partType: string,
    readonly role: string,
  ) {
    super(
      `cannot represent a Mastra "${partType}" part on a ${role} message. ` +
        `Pass { onUnknownPart: "preserve" } to keep it under providerOptions instead.`,
    );
    this.name = "UnmappablePartError";
  }
}

const reasoningText = (part: MastraPart): string => {
  if (typeof part.reasoning === "string") return part.reasoning;
  const details = part.details;
  if (Array.isArray(details)) {
    const first = details.find((detail) => typeof (detail as { text?: unknown })?.text === "string");
    if (first) return String((first as { text: string }).text);
  }
  if (typeof part.text === "string") return part.text;
  return "";
};

const isSynthetic = (part: MastraPart): boolean =>
  part.synthetic === true ||
  (typeof part.providerMetadata === "object" &&
    part.providerMetadata !== null &&
    (part.providerMetadata as { synthetic?: unknown }).synthetic === true);

/**
 * Mastra message list → AI SDK `ModelMessage[]`.
 *
 * Legacy rows are **upgraded, not preserved**: they come back as
 * `format: 2` with their content expressed as parts, because keeping the old
 * shape alive through a migration means every reader has to keep two code paths
 * correct forever. {@link toMastra} always writes `format: 2`.
 *
 * @throws UnmappablePartError on a part with no equivalent, unless
 * `onUnknownPart: "preserve"`.
 */
export const fromMastra = (
  messages: readonly MastraMessage[],
  options: FromMastraOptions = {},
): ModelMessage[] => {
  const onUnknown = options.onUnknownPart ?? "throw";
  const out: ModelMessage[] = [];

  for (const message of messages) {
    // A string body is the pre-`format: 2` shape, and is already what the AI
    // SDK wants for a system message.
    if (typeof message.content === "string") {
      out.push({ role: message.role as ModelMessage["role"], content: message.content } as ModelMessage);
      continue;
    }

    const content = message.content;
    // Legacy rows: `format: 2` never happened, so `parts` is absent and the
    // UIMessageV4 fields carry the transcript instead. Normalising them into
    // parts first means one mapper, not two — and the second one is where the
    // holes were.
    const before = out.length;
    const parts = Array.isArray(content.parts) ? content.parts : legacyParts(content);
    const emittedFrom = (): void => {
      if (out.length > before) return;
      if (onUnknown === "throw") throw new UnmappablePartError("<empty content>", message.role);
    };

    if (message.role === "system") {
      if (!textOf(parts)) {
        emittedFrom();
        continue;
      }
      out.push({ role: "system", content: textOf(parts) });
      continue;
    }
    if (message.role === "user") {
      const mapped = userParts(parts, message.role, onUnknown);
      if (mapped.length === 0) {
        emittedFrom();
        continue;
      }
      out.push({ role: "user", content: mapped as never });
      continue;
    }

    // Assistant: text, reasoning and tool calls belong on one message; the
    // results go on a `tool` message that follows it. Anything after a tool call
    // starts a fresh assistant message rather than reordering the transcript.
    let assistantParts: Array<Record<string, unknown>> = [];
    let toolParts: Array<Record<string, unknown>> = [];
    const annotations: Annotations = {};

    const flush = (): void => {
      if (assistantParts.length > 0) {
        out.push({ role: "assistant", content: assistantParts } as unknown as ModelMessage);
        assistantParts = [];
      }
      if (toolParts.length > 0) {
        out.push({ role: "tool", content: toolParts } as unknown as ModelMessage);
        toolParts = [];
      }
    };

    parts.forEach((part, index) => {
      if (part.type === "text") {
        // A text part after a tool result belongs to a new assistant message.
        if (toolParts.length > 0) flush();
        assistantParts.push({ type: "text", text: String(part.text ?? "") });
        return;
      }
      if (part.type === "reasoning") {
        if (toolParts.length > 0) flush();
        const partAnnotations: Annotations = isSynthetic(part) ? { synthetic: true } : {};
        Object.assign(annotations, partAnnotations);
        assistantParts.push({
          type: "reasoning",
          text: reasoningText(part),
          ...(providerOptionsOf(part) === undefined ? {} : { providerOptions: providerOptionsOf(part) }),
        });
        return;
      }
      if (part.type === "tool-invocation") {
        const invocation = (part.toolInvocation ?? {}) as { args?: unknown; result?: unknown; toolCallId?: unknown };
        assistantParts.push({
          type: "tool-call",
          toolCallId: String(part.toolCallId ?? invocation.toolCallId ?? ""),
          toolName: String(part.toolName ?? ""),
          input: invocation.args ?? {},
        });
        toolParts.push({
          type: "tool-result",
          toolCallId: String(part.toolCallId ?? invocation.toolCallId ?? ""),
          toolName: String(part.toolName ?? ""),
          output: invocation.result ?? "",
          ...(part.isError === true ? { isError: true } : {}),
        });
        return;
      }
      if (MAPPED_PART_TYPES.has(part.type)) {
        // `step-start` has no AI SDK equivalent but is load-bearing metadata for
        // their own code, so it is preserved rather than dropped.
        annotations.unmappedParts = [...(annotations.unmappedParts ?? []), { index, part }];
        return;
      }
      if (onUnknown === "throw") throw new UnmappablePartError(part.type, message.role);
      annotations.unmappedParts = [...(annotations.unmappedParts ?? []), { index, part }];
    });

    flush();
    emittedFrom();
    if (annotations.synthetic !== undefined || annotations.unmappedParts !== undefined) {
      // Annotations ride on the first assistant message of the group.
      const last = out[out.length - 1];
      if (last && last.role === "assistant" && Array.isArray(last.content) && last.content.length > 0) {
        const target = last.content[0] as unknown as Record<string, unknown>;
        target.providerOptions = withAnnotations(
          target.providerOptions as Record<string, unknown> | undefined,
          annotations,
        );
      }
    }
  }

  return out;
};

const providerOptionsOf = (part: MastraPart): Record<string, unknown> | undefined => {
  if (!isSynthetic(part) && typeof part.providerMetadata !== "object") return undefined;
  const metadata = (part.providerMetadata ?? {}) as Record<string, unknown>;
  const base = isSynthetic(part) ? metadata : { ...metadata };
  return withAnnotations(base, isSynthetic(part) ? { synthetic: true } : {});
};

const textOf = (parts: MastraPart[]): string =>
  parts
    .filter((part) => part.type === "text")
    .map((part) => String(part.text ?? ""))
    .join("\n");

const userParts = (
  parts: MastraPart[],
  role: string,
  onUnknown: "throw" | "preserve",
): Array<Record<string, unknown>> => {
  const mapped: Array<Record<string, unknown>> = [];
  const annotations: Annotations = {};
  parts.forEach((part, index) => {
    if (part.type === "text") {
      mapped.push({ type: "text", text: String(part.text ?? "") });
      return;
    }
    if (onUnknown === "throw") throw new UnmappablePartError(part.type, role);
    annotations.unmappedParts = [...(annotations.unmappedParts ?? []), { index, part }];
  });
  if (annotations.unmappedParts) {
    const target = mapped[0];
    if (target) target.providerOptions = withAnnotations(target.providerOptions as never, annotations);
    else return [{ type: "text", text: "", providerOptions: withAnnotations(undefined, annotations) }];
  }
  return mapped;
};

/**
 * A pre-`format: 2` row, expressed in parts.
 *
 * `MastraMessageContentV2` still carries the `UIMessageV4` fields beside
 * `parts`, so rows written before `format: 2` exist and are read on every
 * migration. Three things about them are easy to get wrong, and all three fail
 * silently:
 *
 * - **`content` is not always a string.** It can be an array of parts. Treating
 *   it as text alone returns an empty transcript for those rows, which looks
 *   like data loss rather than a missing format branch.
 * - **`toolInvocations` carry results.** Dropping `result` loses the entire tool
 *   half of the turn and writes `result: ""` back on the way out.
 * - **`providerMetadata` is at the content level**, and that is where an
 *   Anthropic thinking signature lives. It is dropped unless it is carried onto
 *   the reasoning part.
 *
 * Normalising here rather than in a second code path is what closes all three:
 * everything downstream only ever sees parts.
 *
 * @returns `format: 2` on write, which is a deliberate upgrade — see {@link fromMastra}.
 */
const legacyParts = (content: MastraContent): MastraPart[] => {
  const parts: MastraPart[] = [];
  const metadata =
    typeof content.providerMetadata === "object" && content.providerMetadata !== null
      ? (content.providerMetadata as Record<string, unknown>)
      : undefined;

  if (typeof content.reasoning === "string" && content.reasoning.trim()) {
    parts.push({
      type: "reasoning",
      reasoning: content.reasoning,
      details: [{ type: "text", text: content.reasoning }],
      ...(metadata === undefined ? {} : { providerMetadata: metadata }),
    });
  }

  const body = content.content;
  if (typeof body === "string") {
    if (body) parts.push({ type: "text", text: body });
  } else if (Array.isArray(body)) {
    // The array form, carried through untouched so anything unrecognised reaches
    // the strict check rather than disappearing here.
    for (const part of body as MastraPart[]) parts.push(part);
  }

  if (Array.isArray(content.toolInvocations)) {
    for (const invocation of content.toolInvocations as Array<Record<string, unknown>>) {
      const callId = String(invocation.toolCallId ?? "");
      const name = String(invocation.toolName ?? "");
      parts.push({
        type: "tool-invocation",
        toolCallId: callId,
        toolName: name,
        toolInvocation: {
          toolCallId: callId,
          toolName: name,
          args: invocation.args ?? {},
          // `result` is the part that is easy to leave behind, and a tool call
          // without one is a call the model will be asked about again.
          result: invocation.result ?? "",
        },
        ...(typeof invocation.state === "string" && invocation.state !== "output-available"
          ? { state: invocation.state }
          : {}),
      });
    }
  }

  return parts;
};

/**
 * AI SDK `ModelMessage[]` → Mastra message list.
 *
 * The inverse of the message-count change: tool results are folded back into the
 * assistant message that made the call, because that is where Mastra keeps them.
 */
export const toMastra = (
  messages: readonly ModelMessage[],
  options: { id?: (index: number) => string } = {},
): MastraMessage[] => {
  const out: MastraMessage[] = [];
  const idFor = (index: number): string => options.id?.(index) ?? `m-${index}`;

  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index]!;

    if (message.role === "system") {
      out.push({
        id: idFor(index),
        role: "system",
        content: { format: 2, parts: [{ type: "text", text: String(message.content) }] },
      });
      continue;
    }

    if (message.role === "user") {
      const source = Array.isArray(message.content)
        ? (message.content as unknown as Array<Record<string, unknown>>)
        : [{ type: "text", text: String(message.content) }];
      out.push({ id: idFor(index), role: "user", content: { format: 2, parts: partsOf(source) } });
      continue;
    }

    if (message.role === "tool") {
      // A tool message with no call to fold into would be dropped by Mastra
      // anyway, so it is kept as a user message holding its parts verbatim
      // rather than dropped or reshaped into something invented.
      const source = Array.isArray(message.content)
        ? (message.content as unknown as Array<Record<string, unknown>>)
        : [];
      out.push({ id: idFor(index), role: "user", content: { format: 2, parts: partsOf(source) } });
      continue;
    }

    // Assistant. Tool calls are held apart because they are folded with the
    // following tool message; an assistant turn that is *only* a tool call still
    // has to produce a message, or the fold has nothing to attach to.
    const calls: Array<Record<string, unknown>> = [];
    const others: MastraPart[] = [];
    for (const part of message.content as unknown as Array<Record<string, unknown>>) {
      if (part.type === "tool-call") calls.push(part);
      else others.push(toMastraPart(part));
    }

    const next = messages[index + 1];
    const results =
      next && next.role === "tool" && Array.isArray(next.content)
        ? (next.content as unknown as Array<Record<string, unknown>>)
        : undefined;

    const folded = calls.map((call) => toolInvocationPart(call, results));
    const parts = [...others, ...folded];
    if (parts.length > 0) {
      out.push({ id: idFor(index), role: "assistant", content: { format: 2, parts: withUnmapped(parts, others) } });
    }
    if (results) index += 1;
  }

  return out;
};

/** Splices preserved parts back at the index they were taken from. */
const withUnmapped = (parts: MastraPart[], sources: MastraPart[]): MastraPart[] => {
  const held = sources
    .map((part) => annotationsOf(part.providerOptions as never)?.unmappedParts)
    .flatMap((entries) => entries ?? []);
  if (held.length === 0) return parts;
  const next = [...parts];
  for (const entry of [...held].sort((a, b) => a.index - b.index)) {
    next.splice(Math.min(entry.index, next.length), 0, entry.part);
  }
  return next;
};

/** Folds one tool call together with its result into Mastra's single part. */
const toolInvocationPart = (
  call: Record<string, unknown>,
  results: Array<Record<string, unknown>> | undefined,
): MastraPart => {
  const callId = String(call.toolCallId ?? "");
  const name = String(call.toolName ?? "");
  const result = results?.find((candidate) => String(candidate.toolCallId) === callId);
  return {
    type: "tool-invocation",
    toolCallId: callId,
    toolName: name,
    toolInvocation: { toolCallId: callId, toolName: name, args: call.input ?? {}, result: result?.output ?? "" },
    ...(result?.isError === true ? { isError: true } : {}),
  };
};

const partsOf = (source: Array<Record<string, unknown>>): MastraPart[] => source.map(toMastraPart);

const toMastraPart = (part: Record<string, unknown>): MastraPart => {
  if (part.type === "reasoning") {
    const options = part.providerOptions as Record<string, unknown> | undefined;
    const annotations = annotationsOf(options);
    const { [ANNOTATION_KEY]: _ignored, ...providerMetadata } = options ?? {};
    return {
      type: "reasoning",
      reasoning: String(part.text ?? ""),
      details: [{ type: "text", text: String(part.text ?? "") }],
      ...(Object.keys(providerMetadata).length > 0 ? { providerMetadata } : {}),
      ...(annotations?.synthetic === true ? { synthetic: true } : {}),
    };
  }
  if (part.type === "text") {
    // providerOptions carries this package's annotations, which have to reach the
    // next conversion — dropping them here silently loses preserved parts.
    const options = part.providerOptions as Record<string, unknown> | undefined;
    const annotations = annotationsOf(options);
    return {
      type: "text",
      text: String(part.text ?? ""),
      ...(annotations?.unmappedParts ? { providerOptions: options } : {}),
    };
  }
  if (part.type === "tool-result") {
    return {
      type: "tool-result",
      toolCallId: String(part.toolCallId ?? ""),
      toolName: String(part.toolName ?? ""),
      output: part.output,
      ...(part.isError === true ? { isError: true } : {}),
    };
  }
  return { ...part, type: String(part.type ?? "unknown") };
};

export type { ModelMessage };

/*
 * The store adapter and the row migration live beside this mapper rather than in
 * it: all three answer "how do messages get in and out of a Mastra-shaped
 * store", and splitting them would put the counting rule in one file and the code
 * that depends on it in another.
 */
export {
  createMastraSessionStore,
  sessionUpdateFor,
  type CreateMastraSessionStoreOptions,
  type MastraRowSource,
  type MastraSessionStore,
} from "./store.js";
export {
  planRowMigration,
  runRowMigration,
  type AiSdkRow,
  type PlanRowMigrationOptions,
  type RowMigrationPlan,
  type RowMigrationReport,
  type RunRowMigrationOptions,
} from "./migrate.js";
