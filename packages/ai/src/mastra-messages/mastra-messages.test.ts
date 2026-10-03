import { describe, expect, it } from "vitest";

import {
  fromMastra,
  toMastra,
  UnmappablePartError,
  type MastraMessage,
  type MastraPart,
} from "./index.js";

/**
 * Mastra ↔ AI SDK message translation.
 *
 * The round-trip tests are the point of this file. A mapper can look correct on
 * every case you thought of and still lose a part type nobody uses today and
 * everybody uses in six months — so the suite asserts both directions, and the
 * fixtures cover all seven of Mastra's part types rather than the three the
 * client happens to touch.
 */

const assistant = (parts: MastraPart[], extra: Record<string, unknown> = {}): MastraMessage => ({
  id: "m1",
  role: "assistant",
  createdAt: new Date("2026-01-01T00:00:00Z"),
  content: { format: 2, parts },
  ...extra,
});

const user = (parts: MastraPart[]): MastraMessage => ({
  id: "m0",
  role: "user",
  content: { format: 2, parts },
});

const reasoningPart = (text: string, providerMetadata?: Record<string, unknown>, synthetic?: boolean): MastraPart => ({
  type: "reasoning",
  reasoning: text,
  details: [{ type: "text", text }],
  ...(providerMetadata === undefined ? {} : { providerMetadata }),
  ...(synthetic === true ? { synthetic: true } : {}),
});

const toolPart = (id: string, name: string, args: unknown, result: unknown): MastraPart => ({
  type: "tool-invocation",
  toolCallId: id,
  toolName: name,
  toolInvocation: { toolCallId: id, toolName: name, args, result },
});

/** The round trip that matters: whatever goes in comes back out. */
const roundTrip = (messages: MastraMessage[]) => toMastra(fromMastra(messages, { onUnknownPart: "preserve" }));

describe("Mastra → AI SDK", () => {
  it("maps text and user messages", () => {
    const out = fromMastra([user([{ type: "text", text: "read a.ts" }]), assistant([{ type: "text", text: "done" }])]);
    expect(out.map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(out[0]).toMatchObject({ role: "user", content: [{ type: "text", text: "read a.ts" }] });
    expect(out[1]).toMatchObject({ role: "assistant", content: [{ type: "text", text: "done" }] });
  });

  it("maps reasoning onto the AI SDK's text field", () => {
    const out = fromMastra([assistant([reasoningPart("thinking hard")])]);
    expect(out[0]).toMatchObject({ role: "assistant", content: [{ type: "reasoning", text: "thinking hard" }] });
  });

  it("reads reasoning text out of details when `reasoning` is absent", () => {
    // Mastra has more than one place to put it depending on who wrote the row.
    const out = fromMastra([assistant([{ type: "reasoning", details: [{ type: "text", text: "from details" }] }])]);
    expect((out[0] as { content: Array<{ text?: string }> }).content[0]!.text).toBe("from details");
  });

  it("carries providerMetadata through as providerOptions", () => {
    // This is the Anthropic thinking signature path. It is the whole reason the
    // mapping exists rather than a field-by-field rewrite.
    const out = fromMastra([
      assistant([reasoningPart("thinking", { anthropic: { signature: "SIG-XYZ" } })]),
    ]);
    const part = (out[0] as { content: Array<{ providerOptions?: unknown }> }).content[0]!;
    expect(part.providerOptions).toMatchObject({ anthropic: { signature: "SIG-XYZ" } });
  });

  it("splits one tool-invocation part into an assistant message and a tool message", () => {
    // The structural difference that makes message counts change.
    const out = fromMastra([
      assistant([{ type: "text", text: "reading" }, toolPart("t1", "read", { path: "a.ts" }, "contents")]),
    ]);
    expect(out.map((message) => message.role)).toEqual(["assistant", "tool"]);
    expect((out[0] as { content: Array<Record<string, unknown>> }).content).toEqual([
      { type: "text", text: "reading" },
      { type: "tool-call", toolCallId: "t1", toolName: "read", input: { path: "a.ts" } },
    ]);
    expect((out[1] as { content: Array<Record<string, unknown>> }).content[0]).toMatchObject({
      type: "tool-result",
      toolCallId: "t1",
      output: "contents",
    });
  });

  it("puts several tool calls in one assistant message and one tool message", () => {
    const out = fromMastra([
      assistant([toolPart("t1", "read", { path: "a" }, "A"), toolPart("t2", "grep", { pattern: "x" }, "B")]),
    ]);
    expect(out).toHaveLength(2);
    expect((out[0] as { content: unknown[] }).content).toHaveLength(2);
    expect((out[1] as { content: unknown[] }).content).toHaveLength(2);
  });

  it("starts a new assistant message when text follows a tool result", () => {
    const messages = [
      assistant([toolPart("t1", "read", {}, "A"), { type: "text", text: "now the second half" }]),
    ];
    const out = fromMastra(messages);
    // Reordering would change what the model reads, so the order is preserved by
    // splitting rather than merging.
    expect(out.map((message) => message.role)).toEqual(["assistant", "tool", "assistant"]);
  });

  it("joins a system message's text parts", () => {
    const out = fromMastra([
      { id: "s", role: "system", content: { format: 2, parts: [{ type: "text", text: "one" }, { type: "text", text: "two" }] } },
    ]);
    expect(out[0]).toEqual({ role: "system", content: "one\ntwo" });
  });

  it("passes a pre-format:2 string body through", () => {
    const out = fromMastra([{ id: "m", role: "user", content: "plain string" }]);
    expect(out[0]).toEqual({ role: "user", content: "plain string" });
  });

  it("reads a legacy row that has content and reasoning but no parts", () => {
    // These are in their database: MastraMessageContentV2 still carries the
    // UIMessageV4 fields beside `parts`, so a mapper that only reads `parts`
    // returns an empty transcript for these and looks like data loss.
    const out = fromMastra([
      {
        id: "legacy",
        role: "assistant",
        content: { reasoning: "old thinking", content: "old answer" } as never,
      },
    ]);
    expect((out[0] as { content: Array<Record<string, unknown>> }).content).toEqual([
      { type: "reasoning", text: "old thinking" },
      { type: "text", text: "old answer" },
    ]);
  });
});

describe("unknown parts", () => {
  it("throws by default, naming the part", () => {
    // A silently dropped part produces a transcript that looks fine and behaves
    // worse every turn. Nothing downstream can tell.
    expect(() =>
      fromMastra([assistant([{ type: "source-document", sourceId: "s1", mediaType: "text/plain" }])]),
    ).toThrow(UnmappablePartError);
    try {
      fromMastra([assistant([{ type: "source-document", sourceId: "s1" }])]);
    } catch (error) {
      expect((error as Error).message).toContain("source-document");
      expect((error as Error).message).toContain('"preserve"');
    }
  });

  it.each(["step-start", "error", "source-url", "source-document"])(
    "preserves %s verbatim when asked",
    (type) => {
      const part = { type, marker: `keep-${type}` };
      const out = fromMastra([assistant([{ type: "text", text: "hi" }, part])], { onUnknownPart: "preserve" });
      const first = (out[0] as { content: Array<{ providerOptions?: Record<string, unknown> }> }).content[0]!;
      const stored = (first.providerOptions?.astracollab as { unmappedParts?: Array<{ part: unknown }> })?.unmappedParts;
      expect(stored?.[0]?.part).toEqual(part);
    },
  );

  it("round-trips an unmapped part back to its original position", () => {
    const messages = [
      assistant([
        { type: "text", text: "before" },
        { type: "source-url", sourceId: "u1", url: "https://example.com" },
        { type: "text", text: "after" },
      ]),
    ];
    const back = roundTrip(messages);
    const parts = (back[0]!.content as { parts: MastraPart[] }).parts;
    expect(parts.map((part) => part.type)).toEqual(["text", "source-url", "text"]);
    expect(parts[1]).toMatchObject({ sourceId: "u1", url: "https://example.com" });
  });
});

describe("synthetic reasoning", () => {
  it("marks an injected placeholder and keeps it distinguishable", () => {
    // This is the whole reason for the synthetic flag: `reasoning: " "` and real
    // reasoning are byte-identical once persisted, so provenance has to be
    // recorded deliberately.
    const out = fromMastra([assistant([reasoningPart(" ", undefined, true)])], { onUnknownPart: "preserve" });
    const part = (out[0] as { content: Array<{ providerOptions?: { astracollab?: { synthetic?: boolean } } }> }).content[0]!;
    expect(part.providerOptions?.astracollab?.synthetic).toBe(true);
  });

  it("leaves real reasoning unmarked", () => {
    const out = fromMastra([assistant([reasoningPart("genuinely thought")])]);
    const part = (out[0] as { content: Array<{ providerOptions?: unknown }> }).content[0]!;
    expect(part.providerOptions?.astracollab).toBeUndefined();
  });

  it("survives the round trip with its marker intact", () => {
    const back = roundTrip([assistant([reasoningPart(" ", undefined, true)])]);
    const part = (back[0]!.content as { parts: MastraPart[] }).parts[0]!;
    expect(part.synthetic).toBe(true);
    expect(part.reasoning).toBe(" ");
  });

  it("keeps a real signature and a synthetic marker apart", () => {
    // The two cases must not be conflated: one is the model's thinking, the other
    // is a blank we invented to satisfy a gateway.
    const back = roundTrip([assistant([reasoningPart("thought", { anthropic: { signature: "S" } })])]);
    const part = (back[0]!.content as { parts: MastraPart[] }).parts[0]!;
    expect(part.synthetic).toBeUndefined();
    expect(part.providerMetadata).toMatchObject({ anthropic: { signature: "S" } });
  });
});

describe("AI SDK → Mastra", () => {
  it("folds tool results back into the call that made them", () => {
    const messages = fromMastra([assistant([toolPart("t1", "read", { path: "a.ts" }, "contents")])]);
    const back = toMastra(messages);
    expect(back).toHaveLength(1);
    const parts = (back[0]!.content as { parts: MastraPart[] }).parts;
    expect(parts).toHaveLength(1);
    expect(parts[0]).toMatchObject({
      type: "tool-invocation",
      toolCallId: "t1",
      toolName: "read",
      toolInvocation: { args: { path: "a.ts" }, result: "contents" },
    });
  });

  it("keeps reasoning and text ahead of the tool call", () => {
    const messages = fromMastra([
      assistant([reasoningPart("thinking"), { type: "text", text: "reading" }, toolPart("t1", "read", {}, "A")]),
    ]);
    const parts = (toMastra(messages)[0]!.content as { parts: MastraPart[] }).parts;
    expect(parts.map((part) => part.type)).toEqual(["reasoning", "text", "tool-invocation"]);
  });

  it("round-trips a realistic turn", () => {
    const original: MastraMessage[] = [
      user([{ type: "text", text: "read a.ts then summarise" }]),
      assistant([
        reasoningPart("the user wants a summary, so read first"),
        { type: "text", text: "reading the file" },
        toolPart("t1", "read", { path: "a.ts" }, "export const a = 1"),
        toolPart("t2", "grep", { pattern: "export" }, "a.ts:1"),
      ]),
      assistant([{ type: "text", text: "It exports a single constant." }]),
    ];
    const back = roundTrip(original);
    expect(back.map((message) => message.role)).toEqual(original.map((message) => message.role));
    expect((back[1]!.content as { parts: MastraPart[] }).parts.map((part) => part.type)).toEqual([
      "reasoning",
      "text",
      "tool-invocation",
      "tool-invocation",
    ]);
    const restored = (back[1]!.content as { parts: MastraPart[] }).parts[2] as { toolInvocation: { result: string } };
    expect(restored.toolInvocation.result).toBe("export const a = 1");
  });

  it("is idempotent, so writing twice changes nothing", () => {
    // A store that rewrites rows on every turn must not drift.
    const once = roundTrip([
      assistant([reasoningPart("thinking"), toolPart("t1", "read", {}, "A")]),
    ]);
    const twice = roundTrip(once);
    expect(twice).toEqual(once);
  });
});