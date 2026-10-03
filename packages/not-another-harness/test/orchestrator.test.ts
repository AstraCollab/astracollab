import { describe, expect, it } from "vitest";
import { simulateReadableStream, tool } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import type { LanguageModelV4StreamPart } from "@ai-sdk/provider";
import { z } from "zod";

import {
  createGitWorktreeIsolation,
  formatSubtaskReport,
  Orchestrator,
  OrchestratorBusyError,
  orchestratorPrompt,
  type IsolationHandle,
  type SubtaskIsolation,
} from "../src/orchestrator.js";
import { finishReason, v4Usage } from "./helpers/ai.js";

const tools = () => ({
  read: tool({ inputSchema: z.object({ path: z.string() }), execute: async () => "contents" }),
});

/** One step that calls a tool, then one that answers. */
const scriptedModel = () => {
  let call = 0;
  return new MockLanguageModelV4({
    doStream: async () => {
      const call0 = call++;
      if (call0 === 0) {
        return {
          stream: simulateReadableStream<LanguageModelV4StreamPart>({
            chunkDelayInMs: 0,
            chunks: [
              { type: "tool-call", toolCallId: "c1", toolName: "read", input: JSON.stringify({ path: "a.ts" }) },
              { type: "finish", finishReason: finishReason("tool-calls"), usage: v4Usage({ input: 100, output: 10 }) },
            ],
          }),
        };
      }
      return {
        stream: simulateReadableStream<LanguageModelV4StreamPart>({
          chunkDelayInMs: 0,
          chunks: [
            { type: "text-start", id: "t" },
            { type: "text-delta", id: "t", delta: "child done" },
            { type: "text-end", id: "t" },
            { type: "finish", finishReason: finishReason("stop"), usage: v4Usage({ input: 50, output: 5 }) },
          ],
        }),
      };
    },
  });
};

/** A model that only ever answers in prose. */
const proseModel = () =>
  new MockLanguageModelV4({
    doStream: async () => ({
      stream: simulateReadableStream<LanguageModelV4StreamPart>({
        chunkDelayInMs: 0,
        chunks: [
          { type: "text-start", id: "t" },
          { type: "text-delta", id: "t", delta: "nothing to do" },
          { type: "text-end", id: "t" },
          { type: "finish", finishReason: finishReason("stop"), usage: v4Usage({ input: 10, output: 2 }) },
        ],
      }),
    }),
  });

/** Isolation that records what it was asked to do instead of touching Git. */
const recordingIsolation = (log: string[], opts: { diff?: string } = {}): SubtaskIsolation => ({
  description: "recording",
  prepare: async ({ title }): Promise<IsolationHandle> => {
    log.push(`prepare:${title}`);
    return {
      cwd: `/tmp/${title}`,
      boundaryNotes: ["- isolated"],
      collect: async () => {
        log.push(`collect:${title}`);
        return { baseRevision: "abc123", changedPaths: ["a.ts"], diff: opts.diff ?? "diff --git a/a.ts" };
      },
      cleanup: async ({ retain }) => {
        log.push(`cleanup:${title}:${retain}`);
      },
    };
  },
});

describe("Orchestrator", () => {
  it("runs a child in its own transcript and returns its work", async () => {
    const log: string[] = [];
    const orchestrator = new Orchestrator({
      model: scriptedModel(),
      system: "parent system",
      createTools: tools,
      isolation: recordingIsolation(log),
    });

    const result = await orchestrator.run({ title: "extract helper", task: "Move the helper out of the file." });

    expect(result.status).toBe("completed");
    expect(result.steps).toBe(2);
    expect(result.toolCalls).toBe(1);
    expect(result.text).toContain("child done");
    expect(result.artifact?.changedPaths).toEqual(["a.ts"]);
    expect(log).toEqual(["prepare:extract helper", "collect:extract helper", "cleanup:extract helper:false"]);
  });

  it("hands the child tool factory the isolated root, not the parent's", async () => {
    const roots: string[] = [];
    const orchestrator = new Orchestrator({
      model: proseModel(),
      system: "parent system",
      createTools: (cwd) => {
        roots.push(cwd);
        return tools();
      },
      isolation: {
        description: "test",
        prepare: async () => ({ cwd: "/tmp/child", boundaryNotes: ["- parent has uncommitted work"], cleanup: async () => {} }),
      },
    });

    await orchestrator.run({ title: "probe", task: "Look around." });

    expect(roots).toEqual(["/tmp/child"]);
  });

  it("sums usage across children", async () => {
    const seen: number[] = [];
    const orchestrator = new Orchestrator({
      model: proseModel(),
      system: "s",
      createTools: tools,
      onUsage: (usage) => seen.push(usage.totalTokens),
    });

    await orchestrator.runAll([
      { title: "one", task: "First independent task." },
      { title: "two", task: "Second independent task." },
    ]);

    expect(seen).toEqual([12, 12]);
    expect(orchestrator.totalUsage.totalTokens).toBe(24);
    expect(orchestrator.active).toBe(0);
  });

  it("runs a plan larger than the cap in waves rather than refusing it", async () => {
    let inFlight = 0;
    let peak = 0;
    // Slow enough that overlap is observable, so the cap is measured and not asserted.
    const slowModel = new MockLanguageModelV4({
      doStream: async () => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 5));
        inFlight -= 1;
        return {
          stream: simulateReadableStream<LanguageModelV4StreamPart>({
            chunkDelayInMs: 0,
            chunks: [
              { type: "text-start", id: "t" },
              { type: "text-delta", id: "t", delta: "ok" },
              { type: "text-end", id: "t" },
              { type: "finish", finishReason: finishReason("stop"), usage: v4Usage({ input: 10, output: 1 }) },
            ],
          }),
        };
      },
    });
    const orchestrator = new Orchestrator({ model: slowModel, system: "s", createTools: tools, maxConcurrency: 2 });

    const results = await orchestrator.runAll([
      { title: "one", task: "First independent task." },
      { title: "two", task: "Second independent task." },
      { title: "three", task: "Third independent task." },
      { title: "four", task: "Fourth independent task." },
      { title: "five", task: "Fifth independent task." },
    ]);

    expect(results.map((r) => r.title)).toEqual(["one", "two", "three", "four", "five"]);
    expect(peak).toBe(2);
  });

  it("refuses a task above the concurrency cap rather than queueing it", async () => {
    const orchestrator = new Orchestrator({
      model: proseModel(),
      system: "s",
      createTools: tools,
      maxConcurrency: 1,
    });

    const first = orchestrator.run({ title: "one", task: "First independent task." });
    await expect(orchestrator.run({ title: "two", task: "Second independent task." })).rejects.toBeInstanceOf(
      OrchestratorBusyError,
    );
    await first;
  });

  it("retains the workspace when the diff is too big to inline", async () => {
    const orchestrator = new Orchestrator({
      model: proseModel(),
      system: "s",
      createTools: tools,
      isolation: recordingIsolation([], { diff: "x".repeat(5_000) }),
      maxDiffChars: 1_000,
    });

    const result = await orchestrator.run({ title: "big", task: "Change a lot of files." });

    expect(result.workspace).toBe("/tmp/big");
    expect(result.artifact?.diff).toContain("diff truncated at 1000 characters");
  });

  it("cleans up and reports the failure when the run throws", async () => {
    const log: string[] = [];
    const orchestrator = new Orchestrator({
      model: new MockLanguageModelV4({
        doStream: async () => {
          throw new Error("provider is down");
        },
      }),
      system: "s",
      createTools: tools,
      isolation: recordingIsolation(log),
    });

    const result = await orchestrator.run({ title: "broken", task: "This should fail." });

    expect(result.status).toBe("error");
    expect(result.error).toContain("provider is down");
    expect(log).toContain("cleanup:broken:false");
  });
});

describe("orchestratorPrompt", () => {
  it("states the two constraints a parent cannot discover", () => {
    const prompt = orchestratorPrompt({ concurrency: 3, isolation: "temporary Git worktree" });
    expect(prompt).toContain("cannot see uncommitted parent work");
    expect(prompt).toContain("never merged automatically");
    expect(prompt).toContain("At most 3 children");
  });
});

describe("formatSubtaskReport", () => {
  it("renders identity, metrics, paths and diff in a fixed order", () => {
    const report = formatSubtaskReport(
      {
        id: "1",
        title: "extract helper",
        status: "completed",
        steps: 4,
        toolCalls: 2,
        usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 },
        text: "moved the helper",
        durationMs: 1234,
        artifact: { baseRevision: "abc123", changedPaths: ["a.ts"], diff: "diff --git a/a.ts" },
      },
      { maxReportChars: 20 },
    );
    expect(report).toContain("Delegated task: extract helper");
    expect(report).toContain("Base revision: abc123");
    expect(report).toContain("tokens: 100 in / 20 out / 120 total");
    expect(report).toContain("Changed paths: a.ts");
    expect(report).toContain("Review this diff before applying any of it:");
    expect(report).toContain("moved the helper");
  });
});

describe("createGitWorktreeIsolation", () => {
  it("names its strategy", () => {
    expect(createGitWorktreeIsolation({ cwd: "." }).description).toBe("temporary Git worktree");
  });
});