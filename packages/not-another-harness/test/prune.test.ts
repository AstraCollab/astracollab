import { describe, expect, it } from "vitest";
import type { ModelMessage } from "ai";

import { pruneOldToolResults, transcriptHasReasoning } from "../src/prune.js";

const toolRound = (id: string, payload: string): ModelMessage[] => [
  {
    role: "assistant",
    content: [{ type: "tool-call", toolCallId: id, toolName: "read", input: {} }],
  } as unknown as ModelMessage,
  {
    role: "tool",
    content: [
      {
        type: "tool-result",
        toolCallId: id,
        toolName: "read",
        output: { type: "text", value: payload },
      },
    ],
  } as unknown as ModelMessage,
];

const big = (n: number) => `line\n`.repeat(n);

const outputOf = (message: ModelMessage): string => {
  const part = (message.content as Array<Record<string, unknown>>)[0]!;
  const output = part.output;
  if (typeof output === "string") return output;
  return String((output as { value?: string } | undefined)?.value ?? "");
};

describe("transcriptHasReasoning", () => {
  it("detects reasoning anywhere in the transcript", () => {
    const withReasoning = [
      {
        role: "assistant",
        content: [{ type: "reasoning", text: "thinking" }],
      } as unknown as ModelMessage,
    ];
    expect(transcriptHasReasoning(withReasoning)).toBe(true);
    expect(transcriptHasReasoning(toolRound("a", "x"))).toBe(false);
  });
});

describe("pruneOldToolResults", () => {
  it("replaces old results but keeps the recent window verbatim", () => {
    const messages: ModelMessage[] = [
      { role: "user", content: "go" } as ModelMessage,
      ...toolRound("old1", big(200)),
      ...toolRound("old2", big(200)),
      ...toolRound("new1", big(200)),
      ...toolRound("new2", big(200)),
    ];

    const { messages: out, stats } = pruneOldToolResults(messages, 2);
    expect(stats.pruned).toBeGreaterThan(0);
    expect(stats.savedTokens).toBeGreaterThan(0);

    // Indices: 0 user, 1/2 old1, 3/4 old2, 5/6 new1, 7/8 new2.
    // The two most recent results survive untouched.
    expect(outputOf(out[6]!)).toContain("line");
    expect(outputOf(out[8]!)).toContain("line");
    // The older ones became placeholders that say how much was removed.
    expect(outputOf(out[2]!)).toContain("elided");
    expect(outputOf(out[2]!)).toMatch(/\d+ lines?/);
  });

  it("never separates a tool result from its tool call", () => {
    const messages: ModelMessage[] = [
      { role: "user", content: "go" } as ModelMessage,
      ...toolRound("a", big(200)),
      ...toolRound("b", big(200)),
      ...toolRound("c", big(200)),
    ];
    const { messages: out } = pruneOldToolResults(messages, 1);

    const ids = new Set<string>();
    for (const message of out) {
      if (!Array.isArray(message.content)) continue;
      for (const part of message.content as Array<Record<string, unknown>>) {
        if (part.type === "tool-call") ids.add(String(part.toolCallId));
        if (part.type === "tool-result") {
          // Every result still resolves to a call present in the transcript.
          expect(ids.has(String(part.toolCallId))).toBe(true);
        }
      }
    }
  });

  it("refuses to touch a transcript containing reasoning", () => {
    const messages: ModelMessage[] = [
      ...toolRound("a", big(200)),
      ...toolRound("b", big(200)),
      {
        role: "assistant",
        content: [{ type: "reasoning", text: "I should check the file" }],
      } as unknown as ModelMessage,
    ];
    const { messages: out, stats } = pruneOldToolResults(messages, 1);
    expect(stats.skippedForReasoning).toBe(true);
    expect(stats.pruned).toBe(0);
    // Byte-for-byte unchanged.
    expect(out).toEqual(messages);
  });

  it("prunes a reasoning transcript for a provider with no signature check", () => {
    const messages: ModelMessage[] = [
      ...toolRound("a", big(400)),
      ...toolRound("b", big(400)),
      {
        role: "assistant",
        content: [{ type: "reasoning", text: "I should check the file" }],
      } as unknown as ModelMessage,
    ];
    const { messages: out, stats } = pruneOldToolResults(messages, 1, {
      provider: "openrouter",
      modelId: "stealth/space-bunny-alpha",
    });
    // Reasoning is not Anthropic's signature problem everywhere. Gating on the
    // mere presence of a reasoning part left every reasoning model on every
    // provider with no client-side bound at all.
    expect(stats.skippedForReasoning).toBe(false);
    expect(stats.pruned).toBeGreaterThan(0);
    expect(JSON.stringify(out).length).toBeLessThan(JSON.stringify(messages).length);
  });

  it("still refuses for an Anthropic model reached through OpenRouter", () => {
    // `openrouter` alone is not the signal: OpenRouter fronts Anthropic models,
    // and treating one as prunable would break the signatures the guard exists
    // to protect.
    const messages: ModelMessage[] = [
      ...toolRound("a", big(400)),
      ...toolRound("b", big(400)),
      { role: "assistant", content: [{ type: "reasoning", text: "hmm" }] } as unknown as ModelMessage,
    ];
    const { messages: out, stats } = pruneOldToolResults(messages, 1, {
      provider: "openrouter",
      modelId: "anthropic/claude-sonnet-4.5",
    });
    expect(stats.skippedForReasoning).toBe(true);
    expect(out).toEqual(messages);
  });

  it("keeps tool-result output an object, which the SDK schema requires", () => {
    const messages = [...toolRound("a", big(200)), ...toolRound("b", big(200))];
    const { messages: out } = pruneOldToolResults(messages, 1);
    for (const message of out) {
      if (!Array.isArray(message.content)) continue;
      for (const part of message.content as Array<Record<string, unknown>>) {
        if (part.type === "tool-result") {
          // A bare string here is rejected with AI_InvalidPromptError.
          expect(typeof part.output).toBe("object");
        }
      }
    }
  });

  it("leaves small results alone rather than eliding everything", () => {
    const messages: ModelMessage[] = toolRound("a", "tiny");
    const { messages: out, stats } = pruneOldToolResults(messages, 1);
    expect(stats.pruned).toBe(0);
    expect(outputOf(out[1]!)).toBe("tiny");
  });

  it("is idempotent, so the prefix does not churn every turn", () => {
    const messages: ModelMessage[] = [...toolRound("a", big(200)), ...toolRound("b", big(200))];
    const first = pruneOldToolResults(messages, 1);
    const second = pruneOldToolResults(first.messages, 1);
    // Pruning an already-pruned transcript changes nothing further.
    expect(second.messages).toEqual(first.messages);
  });

  it("preserves message order and role", () => {
    const messages: ModelMessage[] = [
      { role: "user", content: "go" } as ModelMessage,
      ...toolRound("a", big(200)),
      ...toolRound("b", big(200)),
    ];
    const { messages: out } = pruneOldToolResults(messages, 1);
    expect(out.map((m) => m.role)).toEqual(["user", "assistant", "tool", "assistant", "tool"]);
  });

  it("always keeps at least one round, so the model is not left blind", () => {
    const messages = [...toolRound("a", big(200)), ...toolRound("b", big(200))];
    const { messages: out, stats } = pruneOldToolResults(messages, 0);
    // Clamped to 1: the newest round is still verbatim.
    expect(outputOf(out[3]!)).toContain("line");
    expect(stats.pruned).toBe(1);
  });

  it("handles string results as well as structured ones", () => {
    const messages = [
      {
        role: "assistant",
        content: [{ type: "tool-call", toolCallId: "s", toolName: "bash", input: {} }],
      },
      {
        role: "tool",
        content: [{ type: "tool-result", toolCallId: "s", toolName: "bash", output: big(200) }],
      },
      ...toolRound("x", big(200)),
    ] as unknown as ModelMessage[];
    // Only the LAST round is kept, so the earlier string result is elided.
    const { messages: out, stats } = pruneOldToolResults(messages, 1);
    expect(stats.pruned).toBe(1);
    // The SDK requires output to stay an object; only the inner text changes.
    const output = (out[1]!.content as Array<Record<string, unknown>>)[0]!.output;
    expect(typeof output).toBe("object");
    expect(String((output as { value: string }).value)).toContain("elided");
  });
});