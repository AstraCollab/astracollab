import { mkdtemp, rm, readFile as fsReadFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as nodePath from "node:path";
import { simulateReadableStream } from "ai";
import { MockLanguageModelV2 } from "ai/test";
import type { LanguageModelV2StreamPart } from "@ai-sdk/provider";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runAgent } from "../src/agent.js";
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
      compaction: "truncate",
      compactAtTokens: 10_000, // crossed after step 1's 8.2k usage (history keeps pressure on)
      compactKeepRecent: 4,
    });
    const events = await collectEvents(run.events);
    const result = await run.result;
    expect(events.some((e) => e.type === "compacted")).toBe(true);
    expect(result.compactions).toBe(1);
    expect(result.text).toBe("post-compaction");
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
});
