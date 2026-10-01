import { describe, expect, it } from "vitest";
import { simulateReadableStream } from "ai";import { MockLanguageModelV2 } from "ai/test";
import { tool, type ModelMessage } from "ai";
import { z } from "zod";
import type { LanguageModelV2StreamPart } from "@ai-sdk/provider";

import { runAgent } from "../src/agent.js";
import type { HarnessEvent } from "../src/types.js";

/** Sonnet's published figures, so the dollar arithmetic is checkable by eye. */
const RATES = { input: 3, output: 15 };

const probeTool = () => ({ probe: tool({ inputSchema: z.object({}), execute: async () => "ok" }) });

const toolCallStream = (id: string, usage: Record<string, number>) =>
  simulateReadableStream<LanguageModelV2StreamPart>({
    chunkDelayInMs: 0,
    chunks: [
      { type: "tool-call", toolCallId: id, toolName: "probe", input: "{}" },
      { type: "finish", finishReason: "tool-calls", usage },
    ],
  });

const textStream = (text: string, usage: Record<string, number> = { inputTokens: 10, outputTokens: 5, totalTokens: 15 }) =>
  simulateReadableStream<LanguageModelV2StreamPart>({
    chunkDelayInMs: 0,
    chunks: [
      { type: "text-start", id: "t" },
      { type: "text-delta", id: "t", delta: text },
      { type: "text-end", id: "t" },
      { type: "finish", finishReason: "stop", usage },
    ],
  });

const drain = async (run: { events: AsyncIterable<HarnessEvent> }) => {
  const events: HarnessEvent[] = [];
  for await (const e of run.events) events.push(e);
  return events;
};

describe("spend budget", () => {
  it("stops on the dollar rail rather than on a token count", async () => {
    // Every step bills 1M input + 1M output = $18. A $40 rail allows two steps.
    // The deprecated token rail is switched off so this exercises the dollar one.
    const model = new MockLanguageModelV2({
      doStream: async () => ({
        stream: toolCallStream("c", {
          inputTokens: 1_000_000,
          outputTokens: 1_000_000,
          totalTokens: 2_000_000,
        }),
      }),
    });
    const run = runAgent({
      model,
      system: "s",
      prompt: "go",
      tools: probeTool(),
      maxSteps: 50,
      maxTokens: 0,
      rates: RATES,
      maxSpendUsd: 40,
      compaction: "off",
      wrapUpOnLimit: false,
    });
    const eventsPromise = drain(run);
    const result = await run.result;
    await eventsPromise;

    // Each step costs $18, so the run completes two steps ($36) and refuses the
    // third because only $4 would remain. The rail *prevents* overspending rather
    // than allowing it and stopping afterwards, which is the whole point of
    // budgeting in dollars.
    expect(result.reason).toBe("max-tokens");
    expect(result.steps).toBe(2);
    expect(result.usage.spendUsd).toBeCloseTo(36, 6);
    expect(result.usage.spendUsd).toBeLessThanOrEqual(40);
  });

  it("lets a well-cached run go far longer on the same dollar rail", async () => {
    // The behaviour that makes long runs affordable. Both runs send the same
    // ~100k tokens of input per step; one reads its prefix back from cache and
    // one does not. A token budget cannot tell them apart — it charges both
    // 100k. A dollar budget can, and the cached one is ~7x cheaper per step.
    const makeModel = (cached: boolean) =>
      new MockLanguageModelV2({
        doStream: async () => ({
          stream: toolCallStream("c", {
            inputTokens: cached ? 1_000 : 100_000,
            outputTokens: 500,
            totalTokens: (cached ? 1_000 : 100_000) + 500,
            ...(cached ? { cachedInputTokens: 99_000 } : {}),
          }),
        }),
      });

    const runOne = async (cached: boolean, maxSpendUsd: number) => {
      const run = runAgent({
        model: makeModel(cached),
        system: "s",
        prompt: "go",
        tools: probeTool(),
        maxSteps: 100,
        maxTokens: 0,
        rates: RATES,
        maxSpendUsd,
        compaction: "off",
        wrapUpOnLimit: false,
      });
      const eventsPromise = drain(run);
      const result = await run.result;
      await eventsPromise;
      return result;
    };

    // ~$0.31/step uncached against ~$0.04/step cached, so $3 buys very different
    // numbers of steps for identical work.
    const uncached = await runOne(false, 3);
    const cached = await runOne(true, 3);

    expect(uncached.reason).toBe("max-tokens");
    expect(cached.reason).toBe("max-tokens");
    // Both were stopped by money, not by the step cap, so the comparison is real.
    expect(uncached.steps).toBeLessThan(100);
    expect(cached.steps).toBeGreaterThan(uncached.steps * 2);
    expect(cached.usage.cachedInputTokens).toBeGreaterThan(0);
  });

  it("reports cumulative cached tokens separately from fresh input", async () => {
    // Anthropic excludes cache reads from `inputTokens`, so a harness that reads
    // only that field cannot tell how large the request actually was.
    const model = new MockLanguageModelV2({
      doStream: async () => ({
        stream: textStream("done", {
          inputTokens: 10,
          outputTokens: 5,
          totalTokens: 15,
          cachedInputTokens: 90_000,
        }),
      }),
    });
    const run = runAgent({ model, system: "s", prompt: "hi", tools: {} });
    await run.result;
    const result = await run.result;
    expect(result.usage.cachedInputTokens).toBe(90_000);
    expect(result.usage.inputTokens).toBe(10);
  });

  it("charges the deprecated token rail too, so the two ceilings compose", async () => {
    const model = new MockLanguageModelV2({
      doStream: async () => ({
        stream: toolCallStream("c", { inputTokens: 1000, outputTokens: 100, totalTokens: 1100 }),
      }),
    });
    const run = runAgent({
      model,
      system: "s",
      prompt: "go",
      tools: probeTool(),
      maxSteps: 50,
      maxTokens: 2500,
      compaction: "off",
      wrapUpOnLimit: false,
    });
    const eventsPromise = drain(run);
    const result = await run.result;
    await eventsPromise;
    expect(result.reason).toBe("max-tokens");
  });

  it("counts cache writes from provider metadata, not just cache reads", async () => {
    // Anthropic puts a cache *write* in `input_tokens` but a cache *read* in
    // `cache_read_input_tokens`, and the SDK's usage type only carries the read
    // side. The write arrives in provider metadata — which `streamText` exposes as
    // a promise, so reading it synchronously would silently contribute nothing.
    const model = new MockLanguageModelV2({
      doStream: async () => ({
        stream: simulateReadableStream<LanguageModelV2StreamPart>({
          chunkDelayInMs: 0,
          chunks: [
            { type: "text-start", id: "t" },
            { type: "text-delta", id: "t", delta: "ok" },
            { type: "text-end", id: "t" },
            {
              type: "finish",
              finishReason: "stop",
              usage: { inputTokens: 5_000, outputTokens: 100, totalTokens: 5_100 },
              providerMetadata: { anthropic: { cacheCreationInputTokens: 40_000 } },
            },
          ],
        }),
      }),
    });
    const run = runAgent({ model, system: "s", prompt: "hi", tools: {}, rates: RATES });
    const eventsPromise = drain(run);
    const result = await run.result;
    await eventsPromise;

    expect(result.usage.cacheCreationInputTokens).toBe(40_000);
    // Priced as a cache write (1.25x default on a $3/M input rate), not as a
    // fresh token — otherwise a large cache write looks cheap.
    expect(result.usage.spendUsd).toBeCloseTo(
      (5_000 / 1e6) * 3 + (40_000 / 1e6) * 3.75 + (100 / 1e6) * 15,
      10,
    );
  });
});

describe("context budget", () => {
  // 40 messages x 4000 chars ~= 40k tokens of history.
  const history: ModelMessage[] = Array.from({ length: 40 }, (_, i) => ({
    role: i % 2 === 0 ? ("user" as const) : ("assistant" as const),
    content: "x".repeat(4000),
  }));

  it("compacts to fit the window rather than stopping", async () => {
    // A full context window is fixable, so the response to one must be to make
    // the request smaller — never to end the run. The window here is tight
    // enough that the ~48k-token request does not fit, but a compacted one does.
    const model = new MockLanguageModelV2({
      doStream: async () => ({
        stream: toolCallStream("c", { inputTokens: 60_000, outputTokens: 500, totalTokens: 60_500 }),
      }),
    });
    const run = runAgent({
      model,
      system: "s",
      prompt: "long task",
      messages: history,
      tools: probeTool(),
      maxSteps: 6,
      maxContextTokens: 45_000,
      compactKeepRecent: 4,
      compaction: "truncate",
      wrapUpOnLimit: false,
    });
    const eventsPromise = drain(run);
    const result = await run.result;
    const events = await eventsPromise;

    expect(events.some((e) => e.type === "compacted")).toBe(true);
    expect(result.reason).not.toBe("max-context");
  });

  it("stops only when even a compacted request cannot fit", async () => {
    const model = new MockLanguageModelV2({
      doStream: async () => ({
        stream: toolCallStream("c", { inputTokens: 60_000, outputTokens: 500, totalTokens: 60_500 }),
      }),
    });
    const run = runAgent({
      model,
      system: "s",
      prompt: "long task",
      messages: history,
      tools: probeTool(),
      maxSteps: 10,
      // Below the retained tail plus the output allowance, so no amount of
      // compaction can make the request fit.
      maxContextTokens: 10_000,
      compaction: "truncate",
      wrapUpOnLimit: false,
    });
    const eventsPromise = drain(run);
    const result = await run.result;
    await eventsPromise;
    expect(result.reason).toBe("max-context");
  });

  it("reserves room for the model's own output when checking the window", async () => {
    // Output counts against the window, thinking included. A request that fits
    // exactly still fails mid-generation without headroom for the response, so a
    // generous output allowance must be clamped down to what the window has left.
    const model = new MockLanguageModelV2({
      doStream: async () => ({ stream: textStream("done") }),
    });
    const run = runAgent({
      model,
      system: "s",
      prompt: "hi",
      // ~42k tokens of history against a 52k window: the request fits, but only
      // ~10k of room is left for the answer.
      messages: history,
      tools: {},
      maxOutputTokens: 30_000,
      maxContextTokens: 52_000,
      compaction: "off",
    });
    const eventsPromise = drain(run);
    await run.result;
    await eventsPromise;
    // `doStreamCalls` rather than the callback argument: the mock exposes the
    // recorded options, which is where the clamp actually lands.
    const options = model.doStreamCalls[0] as { maxOutputTokens?: number };
    expect(options.maxOutputTokens).toBeLessThan(30_000);
    expect(options.maxOutputTokens).toBeGreaterThan(0);
  });
});

describe("compaction trigger uses the whole request", () => {
  it("fires on cached tokens that inputTokens alone would hide", async () => {
    // Anthropic reports `input_tokens` as only the post-breakpoint portion, with
    // the cached prefix in `cache_read_input_tokens`. Reading `inputTokens`
    // alone made the trigger collapse toward the newest few blocks once caching
    // worked, so `compactAtTokens` silently stopped firing exactly when it
    // mattered. This run is ~100k real tokens but only 1k fresh ones.
    const model = new MockLanguageModelV2({
      doStream: async () => ({
        stream: toolCallStream("c", {
          inputTokens: 1_000,
          outputTokens: 500,
          totalTokens: 1_500,
          cachedInputTokens: 99_000,
        }),
      }),
    });
    // Enough history that there is a middle section to summarize. `compactMessages`
    // correctly declines when the retained tail leaves nothing to compress, so a
    // short transcript would pass this test for the wrong reason.
    const seeded: ModelMessage[] = Array.from({ length: 30 }, (_, i) => ({
      role: i % 2 === 0 ? ("user" as const) : ("assistant" as const),
      content: `seed-${i} ${"y".repeat(500)}`,
    }));
    const run = runAgent({
      model,
      system: "s",
      prompt: "go",
      messages: seeded,
      tools: probeTool(),
      maxSteps: 4,
      // Anthropic splits the accounting, so this is the case the trigger depends
      // on. Without saying so the harness assumes the OpenAI convention, where
      // `prompt_tokens` already contains the cached share.
      cacheProvider: "anthropic",
      compactAtTokens: 50_000,
      compactKeepRecent: 2,
      compaction: "truncate",
      wrapUpOnLimit: false,
    });
    const eventsPromise = drain(run);
    const result = await run.result;
    const events = await eventsPromise;

    expect(result.compactions).toBeGreaterThan(0);
    expect(events.some((e) => e.type === "compacted")).toBe(true);
  });

  it("does not double-count cached tokens on an inclusive provider", async () => {
    // OpenAI-compatible gateways report `prompt_tokens` *containing*
    // `cached_tokens`. Adding them reports ~10x the true context on a healthy run,
    // and then compaction and the spend rail both chase a number that was never
    // real. The request here is 1,000 tokens total, of which 990 were cached —
    // the split formula would call it 1,990.
    const model = new MockLanguageModelV2({
      doStream: async () => ({
        stream: textStream("done", {
          inputTokens: 1_000,
          outputTokens: 10,
          totalTokens: 1_010,
          cachedInputTokens: 990,
        }),
      }),
    });
    const run = runAgent({
      model,
      system: "s",
      prompt: "hi",
      tools: {},
      cacheProvider: "openrouter",
    });
    const eventsPromise = drain(run);
    const result = await run.result;
    const events = await eventsPromise;

    const step = events.find((e) => e.type === "step-finish");
    expect(step?.request.totalInputTokens).toBe(1_000);
    expect(step?.request.freshInputTokens).toBe(10);
    expect(step?.request.hitRate).toBeCloseTo(0.99, 2);
  });

  it("reports the same total under the Anthropic convention", async () => {
    // The same usage, declared as Anthropic: `input_tokens` excludes the cached
    // prefix, so the total is the sum and the fresh portion is `input_tokens`.
    const model = new MockLanguageModelV2({
      doStream: async () => ({
        stream: textStream("done", {
          inputTokens: 10,
          outputTokens: 10,
          totalTokens: 20,
          cachedInputTokens: 990,
        }),
      }),
    });
    const run = runAgent({
      model,
      system: "s",
      prompt: "hi",
      tools: {},
      cacheProvider: "anthropic",
    });
    const eventsPromise = drain(run);
    const result = await run.result;
    const events = await eventsPromise;

    const step = events.find((e) => e.type === "step-finish");
    expect(step?.request.totalInputTokens).toBe(1_000);
    expect(step?.request.freshInputTokens).toBe(10);
    expect(step?.request.hitRate).toBeCloseTo(0.99, 2);
  });

  it("does not fire when the real request is small, however much was billed in total", async () => {
    // Cumulative usage is not context pressure — the same tokens are re-sent
    // every step. Compacting on that signal threw away working memory for
    // nothing.
    let call = 0;
    const model = new MockLanguageModelV2({
      doStream: async () => {
        call += 1;
        return call < 6
          ? { stream: toolCallStream(`c${call}`, { inputTokens: 5_000, outputTokens: 500, totalTokens: 5_500 }) }
          : { stream: textStream("done") };
      },
    });
    const run = runAgent({
      model,
      system: "s",
      prompt: "small task",
      tools: probeTool(),
      compaction: "truncate",
    });
    const eventsPromise = drain(run);
    const result = await run.result;
    await eventsPromise;
    expect(result.compactions).toBe(0);
    expect(result.reason).toBe("completed");
  });
});
