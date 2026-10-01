import { describe, expect, it } from "vitest";
import { MockLanguageModelV2 } from "ai/test";
import { simulateReadableStream } from "ai";
import type { LanguageModelV2StreamPart } from "@ai-sdk/provider";

import { runAgent } from "../src/agent.js";

const USAGE = { inputTokens: 100, outputTokens: 10, totalTokens: 110 };

const modelReturning = (finishReason: "stop" | "length" | "tool-calls", chunks: LanguageModelV2StreamPart[]) =>
  new MockLanguageModelV2({
    doStream: async () => ({
      stream: simulateReadableStream<LanguageModelV2StreamPart>({
        chunkDelayInMs: 0,
        chunks: [...chunks, { type: "finish", finishReason, usage: USAGE }],
      }),
    }),
  });

const runTo = async (model: MockLanguageModelV2): Promise<{ reason: string; wrapUp: boolean }> => {
  const run = runAgent({
    model: Object.assign(model, {
      modelId: "test/model",
      provider: "openrouter",
      specificationVersion: "v2",
    }) as never,
    system: "s",
    prompt: "go",
    tools: {},
  });
  let reason = "";
  let wrapUp = false;
  for await (const event of run.events) {
    if (event.type === "finish") reason = event.reason;
    if (event.type === "wrap-up") wrapUp = true;
  }
  await run.result;
  return { reason, wrapUp };
};

const textChunks: LanguageModelV2StreamPart[] = [
  { type: "text-start", id: "t" },
  { type: "text-delta", id: "t", delta: "an answer" },
  { type: "text-end", id: "t" },
];

describe("output-cap stop is named for what it is", () => {
  it("reports max-output when the reply is cut off by the output cap", async () => {
    const { reason } = await runTo(modelReturning("length", textChunks));
    // Reported as `max-tokens` this reads as an input or spend ceiling, and the
    // reader tunes context - the one knob that cannot help, when the limit was
    // on how much the model wrote. Thinking tokens come out of the same
    // allowance, so a reasoning model trips it easily.
    expect(reason).toBe("max-output");
  });

  it("still reports max-tokens for a genuine spend or token ceiling", async () => {
    const { reason } = await runTo(modelReturning("length", textChunks));
    expect(reason).not.toBe("max-tokens");

    const spend = runAgent({
      model: Object.assign(modelReturning("tool-calls", [{ type: "tool-call", toolCallId: "c", toolName: "x", input: "{}" }]), {
        modelId: "test/model",
        provider: "openrouter",
        specificationVersion: "v2",
      }) as never,
      system: "s",
      prompt: "go",
      tools: {},
      maxSpendUsd: 0.0000001,
      rates: { input: 3, output: 15 },
    });
    let spendReason = "";
    for await (const event of spend.events) if (event.type === "finish") spendReason = event.reason;
    await spend.result;
    expect(spendReason).toBe("max-tokens");
  });

  it("reports completed for a normal finish", async () => {
    const { reason } = await runTo(modelReturning("stop", textChunks));
    expect(reason).toBe("completed");
  });

  it("gives a reasoning model room to finish a step by default", async () => {
    // 8k starved a reasoning model: thinking is drawn from the same allowance,
    // so one verbose step ended as truncated rather than done.
    let seen = 0;
    const probe = new MockLanguageModelV2({
      doStream: async (options: { maxOutputTokens?: number }) => {
        seen = options.maxOutputTokens ?? 0;
        return {
          stream: simulateReadableStream<LanguageModelV2StreamPart>({
            chunkDelayInMs: 0,
            chunks: [...textChunks, { type: "finish", finishReason: "stop", usage: USAGE }],
          }),
        };
      },
    });
    await runTo(probe);
    expect(seen).toBeGreaterThanOrEqual(16_384);
  });
});