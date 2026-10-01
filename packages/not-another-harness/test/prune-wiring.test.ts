import { describe, expect, it } from "vitest";
import { simulateReadableStream } from "ai";
import { MockLanguageModelV2 } from "ai/test";
import { tool } from "ai";
import { z } from "zod";
import type { LanguageModelV2StreamPart } from "@ai-sdk/provider";
import type { ModelMessage } from "ai";

import { runAgent } from "../src/agent.js";

const USAGE = { inputTokens: 100, outputTokens: 10, totalTokens: 110 };

/**
 * A model that calls a tool for `steps` rounds, then answers.
 *
 * Every request is captured as plain text so a test can assert on how much of
 * the transcript the provider was actually asked to read.
 */
const probingModel = (steps: number, captured: string[]) =>
  new MockLanguageModelV2({
    doStream: async (options) => {
      // Tool results carry their text under `output.value`, not `text`, so a
      // capture that only reads `text` silently ignores every result - which is
      // exactly the content these assertions are about.
      const flat: string[] = [];
      const push = (value: unknown): void => {
        if (typeof value === "string") flat.push(value);
      };
      for (const part of (options.prompt ?? []) as Array<{ content?: unknown }>) {
        push(part.content);
        if (Array.isArray(part.content)) {
          for (const piece of part.content as Array<{
            text?: string;
            output?: { value?: unknown } | string;
          }>) {
            push(piece.text);
            if (typeof piece.output === "string") push(piece.output);
            else push(piece.output?.value);
          }
        }
      }
      captured.push(flat.join("\n"));
      const n = captured.length - 1;
      const last = n >= steps;
      const chunks: LanguageModelV2StreamPart[] = last
        ? [
            { type: "text-start", id: "t" },
            { type: "text-delta", id: "t", delta: "done" },
            { type: "text-end", id: "t" },
          ]
        : [{ type: "tool-call", toolCallId: `c${n}`, toolName: "probe", input: "{}" }];
      return {
        stream: simulateReadableStream({
          chunkDelayInMs: 0,
          chunks: [...chunks, { type: "finish", finishReason: last ? "stop" : "tool-calls", usage: USAGE }],
        }),
      };
    },
  });

const bigResult = (id: string): string => `result-${id}-${"x".repeat(4000)}`;

/** A transcript that already contains reasoning, so the guard has something to see. */
const seededReasoning: ModelMessage[] = [
  {
    role: "assistant",
    content: [
      { type: "reasoning", text: "thinking about the approach", providerOptions: {} },
      { type: "text", text: "looking around" },
    ],
  } as unknown as ModelMessage,
];

const run = async (modelId: string, provider: string): Promise<string[]> => {
  const captured: string[] = [];
  const result = runAgent({
    model: Object.assign(probingModel(4, captured), { modelId, provider, specificationVersion: "v2" }),
    system: "s",
    prompt: "go",
    messages: seededReasoning,
    // The CLI passes the resolved provider here, and it is the same value the
    // prune guard consults.
    cacheProvider: provider as never,
    tools: {
      probe: tool({
        inputSchema: z.object({}),
        execute: async () => bigResult("payload"),
      }),
    },
    pruneToolResults: { keepRecentToolCalls: 1 },
  });
  for await (const _ of result.events) {
    // Drain, so every step runs.
  }
  await result.result;
  return captured;
};

describe("pruning reaches the provider", () => {
  it("elides old results for a reasoning model on a provider without signature checks", async () => {
    const requests = await run("stealth/space-bunny-alpha", "openrouter");
    const last = requests.at(-1) ?? "";
    // The unit test proves the predicate; this proves the wiring, which is what
    // was actually broken - the call site passed no provider at all.
    expect(last).toContain("[output elided");
  });

  it("leaves an Anthropic model's transcript intact", async () => {
    const requests = await run("anthropic/claude-sonnet-4.5", "openrouter");
    expect(requests.at(-1) ?? "").not.toContain("[output elided");
  });
});