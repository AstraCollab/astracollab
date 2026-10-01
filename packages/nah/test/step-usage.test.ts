import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import * as nodePath from "node:path";
import { tmpdir } from "node:os";
import { simulateReadableStream } from "ai";
import { MockLanguageModelV2 } from "ai/test";
import type { LanguageModelV2StreamPart } from "@ai-sdk/provider";
import { createJsonlSessionStore, createCodingTools } from "@astracollab/not-another-harness";
import { createNodeEnvironment } from "@astracollab/not-another-harness/node";

import { runTurn, type SessionState } from "../src/session.js";

const USAGE = { inputTokens: 40_000, outputTokens: 300, totalTokens: 40_300 };

/** One tool round, then a final answer: two steps in a single turn. */
let calls = 0;
const model = new MockLanguageModelV2({
  doStream: async () => {
    const done = calls++ > 0;
    const chunks: LanguageModelV2StreamPart[] = done
      ? [
          { type: "text-start", id: "t" },
          { type: "text-delta", id: "t", delta: "all done" },
          { type: "text-end", id: "t" },
        ]
      : [{ type: "tool-call", toolCallId: "c1", toolName: "list", input: JSON.stringify({ path: "." }) }];
    return {
      stream: simulateReadableStream({
        chunkDelayInMs: 0,
        chunks: [...chunks, { type: "finish", finishReason: done ? "stop" : "tool-calls", usage: USAGE }],
      }),
    };
  },
});

describe("per-step usage is persisted", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(nodePath.join(tmpdir(), "nah-stepusage-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const state = (store: SessionState["store"]): SessionState =>
    ({
      messages: [],
      system: "you are a coding agent",
      cwd: dir,
      tools: createCodingTools(createNodeEnvironment(dir)),
      workspace: createNodeEnvironment(dir),
      activeFileChanges: null,
      activeShellCommands: null,
      undoHistory: [],
      sessionBasePath: null,
      taskLedger: null,
      discoveredChecks: [],
      store,
      model: { model, spec: "test:model", provider: "openrouter", modelId: "test/model" } as SessionState["model"],
      providerStatus: null,
      totalUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      contextUsedTokens: 0,
      contextUsageEstimated: false,
      lastOutputTokens: 0,
      turns: 0,
      permissions: "yolo",
    }) as unknown as SessionState;

  it("writes one record per model request, with its request size", async () => {
    calls = 0;
    const store = createJsonlSessionStore(nodePath.join(dir, "s.jsonl"));
    const live = state(store);
    const turn = runTurn(live, "list the files");
    for await (const _ of turn.events) {
      // Drain so every step runs.
    }
    await turn.done;

    const steps = await store.loadStepUsage();
    expect(steps.length).toBeGreaterThanOrEqual(2);
    expect(steps.map((s) => s.step)).toEqual(steps.map((_, i) => i + 1));
    for (const step of steps) {
      expect(step.turn).toBe(1);
      // The figure that reconciles a total against a provider's per-request log.
      expect(step.requestTokens).toBeGreaterThan(0);
      expect(step.totalTokens).toBeGreaterThan(0);
    }
    // Totals accumulate; a single request is far smaller than their sum, which
    // is exactly the shape that made a 550k turn look like a bug.
    expect(steps.at(-1)!.totalTokens).toBeGreaterThan(steps.at(-1)!.requestTokens);
  });

  it("writes nothing when the session has no store", async () => {
    calls = 0;
    const live = state(null);
    const turn = runTurn(live, "just answer");
    for await (const _ of turn.events) {
      // Drain.
    }
    // Must not throw on the missing store.
    await expect(turn.done).resolves.toBeDefined();
  });
});