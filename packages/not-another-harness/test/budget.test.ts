import { describe, expect, it } from "vitest";
import { simulateReadableStream } from "ai";import { MockLanguageModelV4 } from "ai/test";
import { tool, type ModelMessage } from "ai";
import { z } from "zod";
import type { LanguageModelV4FinishReason, LanguageModelV4Usage } from "@ai-sdk/provider";
import type { LanguageModelV4StreamPart } from "@ai-sdk/provider";

import { runAgent } from "../src/agent.js";
import type { HarnessEvent } from "../src/types.js";
import { finishReason, v4Usage } from "./helpers/ai.js";

/** Sonnet's published figures, so the dollar arithmetic is checkable by eye. */
const RATES = { input: 3, output: 15 };

const probeTool = () => ({ probe: tool({ inputSchema: z.object({}), execute: async () => "ok" }) });

const toolCallStream = (id: string, usage: LanguageModelV4Usage) =>
  simulateReadableStream<LanguageModelV4StreamPart>({
    chunkDelayInMs: 0,
    chunks: [
      { type: "tool-call", toolCallId: id, toolName: "probe", input: "{}" },
      { type: "finish", finishReason: finishReason("tool-calls"), usage },
    ],
  });

const textStream = (text: string, usage: LanguageModelV4Usage = v4Usage({ input: 10, output: 5 })) =>
  simulateReadableStream<LanguageModelV4StreamPart>({
    chunkDelayInMs: 0,
    chunks: [
      { type: "text-start", id: "t" },
      { type: "text-delta", id: "t", delta: text },
      { type: "text-end", id: "t" },
      { type: "finish", finishReason: finishReason("stop"), usage },
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
    const model = new MockLanguageModelV4({
      doStream: async () => ({
        stream: toolCallStream("c", v4Usage({ input: 1_000_000, output: 1_000_000 })),
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

  it(
    "lets a well-cached run go far longer on the same dollar rail",
    // The point of the test is that a cached run gets *further* on the same
    // money, so it does correspondingly more steps. Five seconds is no longer a
    // bound on the behaviour; it was a bound on the work.
    async () => {
    // The behaviour that makes long runs affordable. Both runs send the same
    // ~100k tokens of input per step; one reads its prefix back from cache and
    // one does not. A token budget cannot tell them apart — it charges both
    // 100k. A dollar budget can, and the cached one is ~7x cheaper per step.
    const makeModel = (cached: boolean) =>
      new MockLanguageModelV4({
        doStream: async () => ({
          stream: toolCallStream(
            "c",
            cached
              ? v4Usage({ input: 100_000, output: 500, cacheRead: 99_000 })
              : v4Usage({ input: 100_000, output: 500 })
          ),
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
    },
    30_000,
  );

  it("reports cumulative cached tokens separately from fresh input", async () => {
    // On AI SDK v7 `inputTokens` is the total, cache included, with the cached
    // share broken out alongside it — so a harness that reads only `inputTokens`
    // still cannot tell a cached request from a large fresh one.
    const model = new MockLanguageModelV4({
      doStream: async () => ({
        stream: textStream("done", v4Usage({ input: 90_010, output: 5, cacheRead: 90_000 })),
      }),
    });
    const run = runAgent({ model, system: "s", prompt: "hi", tools: {} });
    await run.result;
    const result = await run.result;
    expect(result.usage.cachedInputTokens).toBe(90_000);
    // The harness reports `inputTokens` as the *fresh* portion and the cache
    // beside it, which is the contract callers read; the provider's own total is
    // the sum of the two.
    expect(result.usage.inputTokens).toBe(10);
    expect(result.usage.totalTokens).toBe(15);
  });

  it("charges the deprecated token rail too, so the two ceilings compose", async () => {
    const model = new MockLanguageModelV4({
      doStream: async () => ({
        stream: toolCallStream("c", v4Usage({ input: 1000, output: 100 })),
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
    const model = new MockLanguageModelV4({
      doStream: async () => ({
        stream: simulateReadableStream<LanguageModelV4StreamPart>({
          chunkDelayInMs: 0,
          chunks: [
            { type: "text-start", id: "t" },
            { type: "text-delta", id: "t", delta: "ok" },
            { type: "text-end", id: "t" },
            {
              type: "finish",
              finishReason: finishReason("stop"),
              usage: v4Usage({ input: 5_000, output: 100 }),
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
    const model = new MockLanguageModelV4({
      doStream: async () => ({
        stream: toolCallStream("c", v4Usage({ input: 60_000, output: 500 })),
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
    const model = new MockLanguageModelV4({
      doStream: async () => ({
        stream: toolCallStream("c", v4Usage({ input: 60_000, output: 500 })),
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
    const model = new MockLanguageModelV4({
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
    const model = new MockLanguageModelV4({
      doStream: async () => ({
        stream: toolCallStream("c", v4Usage({ input: 100_000, output: 500, cacheRead: 99_000 })),
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

  it("reports the prompt once, never adding the cached portion on top", async () => {
    // The failure this guards against is arithmetic, not convention: a 10,000
    // token prompt of which 9,900 came from cache must be reported as 10,000. An
    // earlier version summed `inputTokens + cachedInputTokens`, which reported
    // 19,900 and then let compaction and the spend rail chase a context that was
    // twice the real size.
    //
    // This used to be a pair of tests, one per provider convention, because v5
    // reported the cached prefix inside `input_tokens` on some providers and
    // beside it on others, so "the total" was ambiguous and the harness had to
    // pick a formula. v7 reports `inputTokens` as the whole prompt and the
    // composition in `inputTokenDetails`, so the ambiguity is gone and there is
    // one correct answer for every provider. Both old tests collapsed into this.
    const model = new MockLanguageModelV4({
      doStream: async () => ({
        stream: textStream("done", v4Usage({ input: 10_000, output: 10, cacheRead: 9_900 })),
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
    expect(step?.request.totalInputTokens).toBe(10_000);
    // The uncached remainder, which is what the provider actually billed in full.
    expect(step?.request.freshInputTokens).toBe(100);
    expect(step?.request.hitRate).toBeCloseTo(0.99, 2);
    // And the billed input is the fresh part, so a 99%-cached step is not charged
    // as though the whole prompt arrived cold.
    expect(result.usage.inputTokens).toBe(100);
    expect(result.usage.cachedInputTokens).toBe(9_900);
  });

  it("does not fire when the real request is small, however much was billed in total", async () => {
    // Cumulative usage is not context pressure — the same tokens are re-sent
    // every step. Compacting on that signal threw away working memory for
    // nothing.
    let call = 0;
    const model = new MockLanguageModelV4({
      doStream: async () => {
        call += 1;
        return call < 6
          ? { stream: toolCallStream(`c${call}`, v4Usage({ input: 5_000, output: 500 })) }
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

describe("no ceiling unless one is asked for", () => {
  const loopingModel = (steps: number, usage: LanguageModelV4Usage) => {
    let call = 0;
    return new MockLanguageModelV4({
      doStream: async () => {
        call += 1;
        return { stream: call <= steps ? toolCallStream(`c${call}`, usage) : textStream("finished") };
      },
    });
  };

  const drainRun = async (options: Parameters<typeof runAgent>[0]) => {
    const run = runAgent(options);
    // Drained alongside the result rather than after it: the event stream only
    // finishes once the run does, so awaiting one before touching the other
    // deadlocks.
    const eventsPromise = drain(run);
    const result = await run.result;
    return { events: await eventsPromise, result };
  };

  /**
   * 100k in + 5k out is $0.375 at Sonnet rates, so eight steps is $3.00 — well
   * past the $2 rail that used to end every real turn, and it still finishes.
   */
  const PRICEY_STEP = v4Usage({ input: 100_000, output: 5_000 });

  it("runs a turn well past the old $2 default", async () => {
    const { events, result } = await drainRun({
      model: loopingModel(8, PRICEY_STEP),
      system: "test",
      prompt: "do the work",
      tools: probeTool(),
      rates: RATES,
      maxSteps: 12,
    });
    expect(result.reason).toBe("completed");
    expect(result.text).toBe("finished");
    // $3.00 of spend, which the removed default would have refused to pay.
    expect(result.usage.spendUsd).toBeGreaterThan(3);
    // No wrap-up: nothing tried to hand off, because nothing ran out.
    expect(events.some((e) => e.type === "wrap-up")).toBe(false);
  });

  it("still stops at a ceiling when one is set", async () => {
    // Opt-in, not removed. Anyone who wants a bound still gets one, and it stops
    // the turn rather than merely reporting the number.
    const { result } = await drainRun({
      model: loopingModel(20, PRICEY_STEP),
      system: "test",
      prompt: "do the work",
      tools: probeTool(),
      rates: RATES,
      maxSpendUsd: 1,
      maxSteps: 20,
    });
    expect(result.reason).toBe("max-tokens");
    // Two steps at $0.375 each, then the third would not fit.
    expect(result.steps).toBeLessThanOrEqual(3);
    expect(result.usage.spendUsd).toBeLessThanOrEqual(1);
  });

  it("declines a wrap-up it cannot pay for, rather than emitting one", async () => {
    // The rail fires when the remaining money is below the cost of a step, and a
    // wrap-up step is a step. Announcing a handoff and then not delivering one
    // is worse than staying quiet, so the harness spends the last affordable
    // request instead — which here means none is left.
    const { events, result } = await drainRun({
      model: loopingModel(20, PRICEY_STEP),
      system: "test",
      prompt: "do the work",
      tools: probeTool(),
      rates: RATES,
      maxSpendUsd: 0.5,
      maxSteps: 20,
    });
    expect(result.reason).toBe("max-tokens");
    expect(events.some((e) => e.type === "wrap-up")).toBe(false);
  });

  it("does not stop a run that has rates but no budget", async () => {
    // `rates` without `maxSpendUsd` is the normal configuration now: spend is
    // reported, nothing is enforced.
    const { result } = await drainRun({
      model: loopingModel(6, PRICEY_STEP),
      system: "test",
      prompt: "do the work",
      tools: probeTool(),
      rates: RATES,
      maxSpendUsd: 0,
      maxSteps: 10,
    });
    expect(result.reason).toBe("completed");
    expect(result.usage.spendUsd).toBeGreaterThan(2);
  });

  it("is bounded by maxSteps, so removing the ceiling is not unbounded", async () => {
    // The step limit is what a turn without a dollar ceiling still runs into,
    // and it stays finite. A steer grants a fresh window, which is the intended
    // way to keep going.
    const { result } = await drainRun({
      model: loopingModel(50, PRICEY_STEP),
      system: "test",
      prompt: "do the work",
      tools: probeTool(),
      rates: RATES,
      maxSteps: 6,
    });
    expect(result.reason).toBe("max-steps");
    expect(result.steps).toBeLessThanOrEqual(7);
  });
});
