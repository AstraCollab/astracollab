import { describe, expect, it } from "vitest";

import { fromMastra, toMastra, type MastraMessage, type MastraPart } from "./index.js";

/**
 * The round-trip gate.
 *
 * One rule: `Mastra → ModelMessage → Mastra` returns the parts it was given, in
 * order, with reasoning text, provider metadata and tool arguments intact. This
 * is the property a store adapter depends on — a row rewritten on every turn
 * must not drift — and the only way to know it holds is to assert it against
 * every part type rather than the three a given codebase happens to use.
 *
 * Where a round trip is deliberately *not* identical, the test says which and
 * why, rather than loosening the assertion until it passes.
 */

type Fixture = {
  name: string;
  parts: MastraPart[];
  /** Part types expected back, in order. Defaults to the input types. */
  expectTypes?: string[];
  note?: string;
};

const SIGNATURE = { anthropic: { signature: "SIG-ABC123" } };

const FIXTURES: Fixture[] = [
  {
    name: "text",
    parts: [{ type: "text", text: "here is what I found" }],
  },
  {
    name: "reasoning with a provider signature",
    parts: [
      {
        type: "reasoning",
        reasoning: "the user wants a summary, so read before answering",
        details: [{ type: "text", text: "the user wants a summary, so read before answering" }],
        providerMetadata: SIGNATURE,
      },
    ],
  },
  {
    name: "a synthetic placeholder",
    note: "must survive marked — this is provenance, not content",
    parts: [{ type: "reasoning", reasoning: " ", details: [{ type: "text", text: " " }], synthetic: true }],
  },
  {
    name: "tool call and result",
    parts: [
      {
        type: "tool-invocation",
        toolCallId: "t1",
        toolName: "read",
        toolInvocation: { toolCallId: "t1", toolName: "read", args: { path: "src/a.ts" }, result: "export const a = 1" },
      },
    ],
  },
  {
    name: "two tool calls in one message",
    parts: [
      {
        type: "tool-invocation",
        toolCallId: "t1",
        toolName: "read",
        toolInvocation: { toolCallId: "t1", toolName: "read", args: { path: "a" }, result: "A" },
      },
      {
        type: "tool-invocation",
        toolCallId: "t2",
        toolName: "grep",
        toolInvocation: { toolCallId: "t2", toolName: "grep", args: { pattern: "export" }, result: "a:1" },
      },
    ],
  },
  {
    name: "reasoning, text and a call together",
    parts: [
      { type: "reasoning", reasoning: "read first", details: [{ type: "text", text: "read first" }] },
      { type: "text", text: "reading the file" },
      {
        type: "tool-invocation",
        toolCallId: "t1",
        toolName: "read",
        toolInvocation: { toolCallId: "t1", toolName: "read", args: { path: "a.ts" }, result: "contents" },
      },
    ],
  },
  {
    name: "step-start",
    note: "no AI SDK equivalent, so preserved rather than dropped",
    parts: [{ type: "step-start", model: "openrouter/deepseek-chat" }, { type: "text", text: "working" }],
  },
  {
    name: "error",
    parts: [{ type: "error", errorText: "the tool crashed" }, { type: "text", text: "recovered" }],
  },
  {
    name: "source-url",
    parts: [
      { type: "source-url", sourceId: "u1", url: "https://example.com/spec", title: "Spec" },
      { type: "text", text: "read the spec" },
    ],
  },
  {
    name: "source-document",
    parts: [
      { type: "source-document", sourceId: "d1", mediaType: "text/plain", title: "notes" },
      { type: "text", text: "read the notes" },
    ],
  },
  {
    name: "a data part",
    parts: [{ type: "data-weather", data: { tempC: 14, city: "Lisbon" } }, { type: "text", text: "it is 14" }],
  },
];

const assistant = (parts: MastraPart[]): MastraMessage => ({
  id: "m1",
  role: "assistant",
  content: { format: 2, parts },
});

const typesOf = (message: MastraMessage): string[] =>
  ((message.content as { parts?: MastraPart[] }).parts ?? []).map((part) => part.type);

const roundTrip = (parts: MastraPart[]): MastraPart[] => {
  const back = toMastra(fromMastra([assistant(parts)], { onUnknownPart: "preserve" }));
  return (back[0]!.content as { parts: MastraPart[] }).parts;
};

describe("round trip: every part type survives", () => {
  it.each(FIXTURES)("$name", ({ parts, expectTypes }) => {
    expect(typesOf({ id: "x", role: "assistant", content: { parts: roundTrip(parts) } })).toEqual(
      expectTypes ?? parts.map((part) => part.type),
    );
  });
});

describe("round trip: content is preserved, not just types", () => {
  it("keeps reasoning text verbatim", () => {
    const original = "the user wants a summary, so read before answering";
    const [back] = roundTrip([{ type: "reasoning", reasoning: original, details: [{ type: "text", text: original }] }]);
    expect(back!.reasoning).toBe(original);
    expect((back!.details as Array<{ text: string }>)[0]!.text).toBe(original);
  });

  it("keeps providerMetadata, which is where a thinking signature lives", () => {
    const [back] = roundTrip([
      { type: "reasoning", reasoning: "thinking", details: [{ type: "text", text: "thinking" }], providerMetadata: SIGNATURE },
    ]);
    expect(back!.providerMetadata).toEqual(SIGNATURE);
  });

  it("keeps a synthetic placeholder marked", () => {
    // The whole point of the marker: indistinguishable by value, so provenance
    // has to be a field or it is gone.
    const [back] = roundTrip([{ type: "reasoning", reasoning: " ", details: [{ type: "text", text: " " }], synthetic: true }]);
    expect(back!.synthetic).toBe(true);
    expect(back!.reasoning).toBe(" ");
  });

  it("does not mark real reasoning", () => {
    const [back] = roundTrip([{ type: "reasoning", reasoning: "genuinely thought", details: [{ type: "text", text: "genuinely thought" }] }]);
    expect(back!.synthetic).toBeUndefined();
  });

  it("keeps tool arguments and results", () => {
    const [back] = roundTrip([
      {
        type: "tool-invocation",
        toolCallId: "t7",
        toolName: "read",
        toolInvocation: { toolCallId: "t7", toolName: "read", args: { path: "deep/nested/a.ts", limit: 20 }, result: "body" },
      },
    ]);
    const invocation = back!.toolInvocation as { args: unknown; result: unknown };
    expect(invocation.args).toEqual({ path: "deep/nested/a.ts", limit: 20 });
    expect(invocation.result).toBe("body");
    expect(back!.toolCallId).toBe("t7");
  });

  it("keeps unmapped part payloads intact", () => {
    const [back] = roundTrip([
      { type: "source-document", sourceId: "d1", mediaType: "text/plain", title: "notes" },
      { type: "text", text: "read the notes" },
    ]);
    expect(back).toMatchObject({ type: "source-document", sourceId: "d1", mediaType: "text/plain", title: "notes" });
  });
});

describe("round trip: a whole conversation", () => {
  const conversation: MastraMessage[] = [
    { id: "m0", role: "user", content: { format: 2, parts: [{ type: "text", text: "read a.ts and summarise" }] } },
    {
      id: "m1",
      role: "assistant",
      content: {
        format: 2,
        parts: [
          { type: "reasoning", reasoning: "they want a summary, so read first", details: [{ type: "text", text: "they want a summary, so read first" }] },
          { type: "text", text: "reading" },
          {
            type: "tool-invocation",
            toolCallId: "t1",
            toolName: "read",
            toolInvocation: { toolCallId: "t1", toolName: "read", args: { path: "a.ts" }, result: "export const a = 1" },
          },
        ],
      },
    },
    { id: "m2", role: "assistant", content: { format: 2, parts: [{ type: "text", text: "It exports one constant." }] } },
  ];

  it("preserves roles and order", () => {
    const back = toMastra(fromMastra(conversation, { onUnknownPart: "preserve" }));
    expect(back.map((message) => message.role)).toEqual(["user", "assistant", "assistant"]);
    expect(typesOf(back[1]!)).toEqual(["reasoning", "text", "tool-invocation"]);
  });

  it("is idempotent, so a store that rewrites rows does not drift", () => {
    const once = toMastra(fromMastra(conversation, { onUnknownPart: "preserve" }));
    const twice = toMastra(fromMastra(once, { onUnknownPart: "preserve" }));
    expect(twice).toEqual(once);
  });
});

describe("legacy rows", () => {
  it("reads a row that has content, reasoning and toolInvocations but no parts", () => {
    // These are in their database. `MastraMessageContentV2` still carries the
    // UIMessageV4 fields beside `parts`, and a mapper that only reads `parts`
    // returns an empty transcript for these — which looks like data loss rather
    // than a missing format branch.
    const messages = fromMastra([
      {
        id: "legacy",
        role: "assistant",
        content: {
          reasoning: "old thinking",
          content: "old answer",
          toolInvocations: [{ toolCallId: "t9", toolName: "read", args: { path: "b.ts" }, result: "B" }],
        } as never,
      },
    ]);
    expect(messages.map((message) => message.role)).toEqual(["assistant", "tool"]);
    const assistantParts = (messages[0] as { content: Array<Record<string, unknown>> }).content;
    expect(assistantParts.map((part) => part.type)).toEqual(["reasoning", "text", "tool-call"]);
    // The result is the easy half to lose, and losing it writes an empty answer
    // back into the database.
    const toolResult = (messages[1] as { content: Array<Record<string, unknown>> }).content[0]!;
    expect(toolResult).toMatchObject({ type: "tool-result", toolCallId: "t9", output: "B" });
  });

  it("reads a legacy body that is an array of parts, not a string", () => {
    const out = fromMastra([
      { id: "legacy", role: "assistant", content: { content: [{ type: "text", text: "from the array" }] } as never },
    ]);
    expect((out[0] as { content: Array<Record<string, unknown>> }).content[0]).toMatchObject({
      type: "text",
      text: "from the array",
    });
  });

  it("carries content-level providerMetadata onto the reasoning part", () => {
    const out = fromMastra([
      {
        id: "legacy",
        role: "assistant",
        content: { reasoning: "old thinking", content: "answer", providerMetadata: SIGNATURE } as never,
      },
    ]);
    const part = (out[0] as { content: Array<{ providerOptions?: unknown }> }).content[0]!;
    expect(part.providerOptions).toMatchObject(SIGNATURE);
  });

  it("upgrades a legacy row to format 2 rather than keeping two shapes alive", () => {
    // Deliberate: a migration that preserves the old shape means every future
    // reader keeps two code paths correct forever.
    const back = toMastra(fromMastra([{ id: "legacy", role: "assistant", content: { content: "hi" } as never }]));
    expect((back[0]!.content as { format?: number }).format).toBe(2);
    expect(typesOf(back[0]!)).toEqual(["text"]);
  });

  it("preserves the legacy row's content through the upgrade", () => {
    const back = toMastra(
      fromMastra([
        { id: "legacy", role: "assistant", content: { reasoning: "thought", content: "answer" } as never },
      ]),
    );
    const parts = (back[0]!.content as { parts: MastraPart[] }).parts;
    expect(parts.map((part) => part.type)).toEqual(["reasoning", "text"]);
    expect(parts[1]!.text).toBe("answer");
  });
});

describe("rows that cannot be mapped are loud", () => {
  it("throws on an empty assistant row rather than dropping it", () => {
    // A row that produces nothing is either a format nobody handled or a bug.
    // Silently skipping it loses a turn and leaves no trace.
    expect(() => fromMastra([{ id: "m", role: "assistant", content: { parts: [] } }])).toThrow(/empty content/);
  });

  it("names every unmappable part type it can see", () => {
    expect(() =>
      fromMastra([assistant([{ type: "source-document", sourceId: "d1" }])]),
    ).toThrow(/source-document/);
  });
});