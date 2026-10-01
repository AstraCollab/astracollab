import { mkdtemp, rm, readFile as fsReadFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as nodePath from "node:path";
import { simulateReadableStream } from "ai";
import { MockLanguageModelV2 } from "ai/test";
import type { LanguageModelV2StreamPart } from "@ai-sdk/provider";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runAgent } from "../src/agent.js";
import { tool } from "ai";
import { z } from "zod";
import type { ModelMessage } from "ai";
import { buildSystemPrompt } from "../src/prompt.js";
import { createJsonlSessionStore } from "../src/session.js";
import { createNodeEnvironment } from "../src/node.js";
import { createCodingTools } from "../src/tools.js";
import type { HarnessEvent, HarnessUsage } from "../src/types.js";

const USAGE = { inputTokens: 100, outputTokens: 20, totalTokens: 120 };

const textStream = (text: string, finishReason: "stop" | "tool-calls" = "stop") =>
  simulateReadableStream<LanguageModelV2StreamPart>({
    chunkDelayInMs: 0,
    chunks: [
      { type: "text-start", id: "t1" },
      { type: "text-delta", id: "t1", delta: text },
      { type: "text-end", id: "t1" },
      { type: "finish", finishReason, usage: USAGE },
    ],
  });

const toolCallStream = (
  toolName: string,
  input: unknown,
  toolCallId = "call-1",
  thenText?: string,
  usage = USAGE,
) => {
  const chunks: LanguageModelV2StreamPart[] = [
    { type: "tool-call", toolCallId, toolName, input: JSON.stringify(input) },
  ];
  if (thenText) {
    chunks.push({ type: "text-start", id: "t2" });
    chunks.push({ type: "text-delta", id: "t2", delta: thenText });
    chunks.push({ type: "text-end", id: "t2" });
  }
  chunks.push({ type: "finish", finishReason: "tool-calls", usage });
  return simulateReadableStream<LanguageModelV2StreamPart>({
    chunkDelayInMs: 0,
    chunks,
  });
};

type StreamFactory = () => ReturnType<typeof textStream>;

const scriptedModel = (streams: StreamFactory[]): MockLanguageModelV2 => {
  let call = 0;
  return new MockLanguageModelV2({
    doStream: async () => {
      const make = streams[Math.min(call, streams.length - 1)];
      call += 1;
      if (!make) {
        throw new Error("script empty");
      }
      return { stream: make() };
    },
  });
};

const collectEvents = async (
  events: AsyncIterable<HarnessEvent>,
): Promise<HarnessEvent[]> => {
  const out: HarnessEvent[] = [];
  for await (const e of events) {
    out.push(e);
  }
  return out;
};

describe("runAgent", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(nodePath.join(tmpdir(), "nah-agent-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("completes a text-only run in one step", async () => {
    const model = scriptedModel([() => textStream("All done.")]);
    const run = runAgent({
      model,
      system: "test",
      prompt: "say hi",
      tools: {},
    });
    const events = await collectEvents(run.events);
    const result = await run.result;
    expect(result.reason).toBe("completed");
    expect(result.text).toBe("All done.");
    expect(events.map((e) => e.type)).toEqual([
      "run-start",
      "step-start",
      "text-delta",
      "step-finish",
      "finish",
    ]);
  });

  it("executes a tool call, loops, and applies the edit on disk", async () => {
    const model = scriptedModel([
      () => toolCallStream("write", { path: "out.txt", content: "hello from nah\n" }),
      () => toolCallStream("read", { path: "out.txt" }, "call-2"),
      () => textStream("Created out.txt."),
    ]);
    const env = createNodeEnvironment(dir);
    const run = runAgent({
      model,
      system: buildSystemPrompt({ cwdLabel: dir }),
      prompt: "create out.txt",
      tools: createCodingTools(env),
    });
    const result = await run.result;
    expect(result.reason).toBe("completed");
    expect(result.text).toContain("Created out.txt");
    const content = await fsReadFile(nodePath.join(dir, "out.txt"), "utf8");
    expect(content).toBe("hello from nah\n");
  });

  it("stops at maxSteps while the model keeps calling tools; budgets stream as events", async () => {
    const model = scriptedModel([() => toolCallStream("read", { path: "x" })]);
    const env = createNodeEnvironment(dir);
    const usageEvents: HarnessUsage[] = [];
    const run = runAgent({
      model,
      system: "test",
      prompt: "loop forever",
      tools: createCodingTools(env),
      maxSteps: 3,
    });
    const eventsPromise = (async () => {
      for await (const e of run.events) {
        if (e.type === "step-finish") {
          usageEvents.push(e.usage);
        }
      }
    })();
    const result = await run.result;
    await eventsPromise;
    expect(result.reason).toBe("max-steps");
    expect(usageEvents.length).toBe(3);
    expect(usageEvents[2]?.totalTokens).toBe(USAGE.totalTokens * 3);
  });

  it("hard-stops on the token budget even with steps remaining", async () => {
    const model = scriptedModel([() => toolCallStream("read", { path: "x" })]);
    const env = createNodeEnvironment(dir);
    const run = runAgent({
      model,
      system: "test",
      prompt: "loop",
      tools: createCodingTools(env),
      maxSteps: 50,
      maxTokens: 200,
      compaction: "off",
    });
    const result = await run.result;
    expect(result.reason).toBe("max-tokens");
  });

  it("aborts via AbortSignal", async () => {
    const abort = new AbortController();
    abort.abort();
    const model = scriptedModel([() => textStream("nope")]);
    const run = runAgent({
      model,
      system: "test",
      prompt: "hi",
      tools: {},
      abortSignal: abort.signal,
    });
    const result = await run.result;
    expect(result.reason).toBe("aborted");
  });

  it("compacts long transcripts (truncate mode) between steps", async () => {
    const longHistory = Array.from({ length: 12 }, (_, i) => ({
      role: (i % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
      content: `msg-${i} ${"x".repeat(500)}`,
    }));
    const model = scriptedModel([
      // big step-1 usage crosses the 10k compaction floor immediately
      () =>
        toolCallStream("read", { path: "x" }, "call-1", undefined, {
          inputTokens: 11_000,
          outputTokens: 500,
          totalTokens: 11_500,
        }),
      () => textStream("post-compaction"),
    ]);
    const env = createNodeEnvironment(dir);
    const run = runAgent({
      model,
      system: "test",
      prompt: "continue",
      messages: longHistory,
      tools: createCodingTools(env),
      compactAtTokens: 10_000,
      // Crossed after step 1's usage; the long history keeps pressure on.
      compactKeepRecent: 4,
    });
    const events = await collectEvents(run.events);
    const result = await run.result;
    expect(events.some((e) => e.type === "compacted")).toBe(true);
    expect(result.compactions).toBe(1);
    expect(result.text).toBe("post-compaction");
  });

  it("does not compact a small transcript just because cumulative usage is high", async () => {
    // Every step re-sends the transcript, so *cumulative* usage climbs fast even
    // when the real context is tiny. Triggering compaction off that number threw
    // away the agent's working memory mid-task and left it unable to finish.
    let call = 0;
    const model = new MockLanguageModelV2({
      doStream: async () => {
        const index = call;
        call += 1;
        return {
          stream:
            index < 8
              ? toolCallStream("read", { path: "x" }, `call-${index}`, undefined, {
                  inputTokens: 20_000,
                  outputTokens: 500,
                  totalTokens: 20_500,
                })
              : textStream("done"),
        };
      },
    });
    const env = createNodeEnvironment(dir);
    const run = runAgent({
      model,
      system: "you are a coding agent",
      prompt: "do a small task",
      tools: createCodingTools(env),
      compaction: "truncate",
    });
    const eventsPromise = (async () => {
      for await (const _ of run.events) {
        // drain
      }
    })();
    const result = await run.result;
    await eventsPromise;
    expect(result.steps).toBe(9);
    // ~180k cumulative tokens, but each individual request was only ~20k.
    expect(result.usage.totalTokens).toBeGreaterThan(120_000);
    expect(result.compactions).toBe(0);
  });

  it("compacts once a single request genuinely approaches the threshold", async () => {
    let call = 0;
    const model = new MockLanguageModelV2({
      doStream: async () => {
        const index = call;
        call += 1;
        return {
          stream:
            index < 4
              ? toolCallStream("read", { path: "x" }, `call-${index}`, undefined, {
                  // each request really is ~40k tokens on its own
                  inputTokens: 40_000,
                  outputTokens: 500,
                  totalTokens: 40_500,
                })
              : textStream("done"),
        };
      },
    });
    const env = createNodeEnvironment(dir);
    const run = runAgent({
      model,
      system: "you are a coding agent",
      prompt: "do a small task",
      tools: createCodingTools(env),
      compaction: "truncate",
      compactAtTokens: 30_000,
    });
    const eventsPromise = (async () => {
      for await (const _ of run.events) {
        // drain
      }
    })();
    const result = await run.result;
    await eventsPromise;
    expect(result.compactions).toBeGreaterThan(0);
  });

});

describe("jsonl session store", () => {
  it("round-trips the active branch", async () => {
    const dir = await mkdtemp(nodePath.join(tmpdir(), "nah-session-"));
    try {
      const file = nodePath.join(dir, "s.jsonl");
      const store = createJsonlSessionStore(file);
      await store.append([{ role: "user", content: "task one" }]);
      await store.append([{ role: "assistant", content: "done" }]);
      const fresh = createJsonlSessionStore(file);
      expect(await fresh.load()).toEqual([
        { role: "user", content: "task one" },
        { role: "assistant", content: "done" },
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("forks the loaded transcript into an independent session file", async () => {
    const dir = await mkdtemp(nodePath.join(tmpdir(), "nah-session-fork-"));
    try {
      const parent = createJsonlSessionStore(nodePath.join(dir, "main.jsonl"));
      await parent.append([{ role: "user", content: "original task" }]);
      const ledger = {
        version: 2 as const,
        goal: "ship a focused change",
        status: "in_progress" as const,
        steps: [{ id: "1", title: "inspect", status: "completed" as const }],
        checks: [{ id: "1", description: "tests pass", command: "pnpm test", status: "pending" as const, attempts: [] }],
        updatedAt: new Date().toISOString(),
      };
      await parent.saveTaskLedger(ledger);
      const fork = await parent.fork(nodePath.join(dir, "experiment.jsonl"));
      await fork.append([{ role: "user", content: "alternate direction" }]);
      expect(await parent.load()).toEqual([{ role: "user", content: "original task" }]);
      expect(await fork.load()).toEqual([
        { role: "user", content: "original task" },
        { role: "user", content: "alternate direction" },
      ]);
      expect(await fork.loadTaskLedger()).toEqual(ledger);
      expect(await parent.loadTaskLedger()).toEqual(ledger);
      await parent.reset();
      expect(await parent.loadTaskLedger()).toBeNull();
      expect(await fork.loadTaskLedger()).toEqual(ledger);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

});

describe("budget triage", () => {
  it("compacts to keep going instead of stopping when the next step no longer fits", async () => {
    // A big history that costs a lot to replay, then a tool call every step so
    // cumulative spend climbs toward the cap.
    const history: ModelMessage[] = Array.from({ length: 150 }, (_, i) => ({
      role: i % 2 === 0 ? "user" : "assistant",
      content: `${"filler ".repeat(80)} message ${i}`,
    }));

    let call = 0;
    const model = new MockLanguageModelV2({
      doStream: async (options) => {
        const step = call++;
        // Bill what the prompt actually costs, so the budget behaves like a real
        // run rather than a flat per-step fiction.
        const inputTokens = Math.ceil(JSON.stringify(options?.prompt ?? options?.messages ?? []).length / 4);
        if (step < 14) {
          return {
            stream: simulateReadableStream<LanguageModelV2StreamPart>({
              chunkDelayInMs: 0,
              chunks: [
                { type: "tool-call", toolCallId: `c${step}`, toolName: "probe", input: "{}" },
                {
                  type: "finish",
                  finishReason: "tool-calls",
                  usage: { inputTokens, outputTokens: 200, totalTokens: inputTokens + 200 },
                },
              ],
            }),
          };
        }
        return { stream: textStream("all done") };
      },
    });

    const events: HarnessEvent[] = [];
    const handle = runAgent({
      model,
      system: "s",
      prompt: "do a long task",
      messages: history,
      tools: { probe: tool({ inputSchema: z.object({}), execute: async () => "ok" }) },
      // Not enough to replay an ever-growing transcript, but enough once it is
      // compacted. Without triage this run dies part-way through.
      maxTokens: 120_000,
      maxOutputTokens: 2_000,
      // Above any single request, so only budget pressure can trigger compaction.
      compactAtTokens: 200_000,
      compaction: "truncate",
    });
    const consumer = (async () => {
      for await (const event of handle.events) events.push(event);
    })();
    const result = await handle.result;
    await consumer;

    const compactions = events.filter((e) => e.type === "compacted").length;
    console.log(
      `      reason=${result.reason} steps=${result.steps} compactions=${result.compactions} total=${result.usage.totalTokens}`,
    );

    // The budget was genuinely tight: it finished while using most of it.
    expect(result.usage.totalTokens).toBeGreaterThan(60_000);
    expect(result.usage.totalTokens).toBeLessThan(120_000);
    expect(compactions).toBeGreaterThan(0);
    // The point: it finished rather than dying part-way.
    expect(result.reason).toBe("completed");
    expect(result.steps).toBe(15);
  });

  it("still stops when even a compacted request cannot be afforded", async () => {
    let call = 0;
    const model = new MockLanguageModelV2({
      doStream: async () => {
        const step = call++;
        return {
          stream: simulateReadableStream<LanguageModelV2StreamPart>({
            chunkDelayInMs: 0,
            chunks: [
              ...(step < 2
                ? [{ type: "tool-call" as const, toolCallId: `c${step}`, toolName: "probe", input: "{}" }]
                : []),
              {
                type: "finish" as const,
                finishReason: (step < 2 ? "tool-calls" : "stop") as "tool-calls" | "stop",
                usage: { inputTokens: 0, outputTokens: 0, totalTokens: 40_000 },
              },
            ],
          }),
        };
      },
    });

    const events: HarnessEvent[] = [];
    const handle = runAgent({
      model,
      system: "s",
      prompt: "go",
      tools: { probe: tool({ inputSchema: z.object({}), execute: async () => "ok" }) },
      maxTokens: 45_000,
      maxOutputTokens: 1_000,
      compaction: "truncate",
    });
    const consumer = (async () => {
      for await (const event of handle.events) events.push(event);
    })();
    const result = await handle.result;
    await consumer;

    // Below the compaction reserve, triage must not attempt it.
    expect(result.reason).toBe("max-tokens");
  });
});
