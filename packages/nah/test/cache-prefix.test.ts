import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as nodePath from "node:path";
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { simulateReadableStream } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import type { LanguageModelV4StreamPart } from "@ai-sdk/provider";

import { composeTurnRequest, runTurn, type SessionState } from "../src/session.js";
import type { SessionTaskLedger } from "@astracollab/not-another-harness";
import { createCodingTools } from "@astracollab/not-another-harness";
import { createNodeEnvironment } from "@astracollab/not-another-harness/node";
import { finishReason, v4Usage } from "./helpers/ai.js";

const ledger = (goal: string, status: SessionTaskLedger["status"] = "in_progress"): SessionTaskLedger => ({
  version: 2,
  goal,
  status,
  steps: [{ id: "1", title: `do ${goal}`, status: "pending" }],
  checks: [],
  updatedAt: new Date(0).toISOString(),
});

const baseState = (over: Partial<SessionState> = {}): SessionState =>
  ({
    messages: [],
    system: "you are a coding agent",
    cwd: ".",
    tools: {},
    workspace: createNodeEnvironment("."),
    activeFileChanges: null,
    activeShellCommands: null,
    undoHistory: [],
    sessionBasePath: null,
    taskLedger: null,
    discoveredChecks: [],
    store: null,
    model: null,
    providerStatus: null,
    totalUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    contextUsedTokens: 0,
    contextUsageEstimated: false,
    lastOutputTokens: 0,
    turns: 0,
    permissions: "yolo",
    ...over,
  }) as unknown as SessionState;

describe("the system prompt is cache-stable", () => {
  it("does not change when the task ledger does", () => {
    // The system prompt is the first thing in the request and the anchor for
    // prefix caching, so one changed byte in it re-reads the whole transcript at
    // full price. A ledger that moves every step is the most likely thing to move
    // it, and this is the invariant that keeps that from costing ~10x.
    const before = composeTurnRequest(
      baseState({ taskLedger: ledger("port the design system") }),
      "next step",
      "",
    );
    const after = composeTurnRequest(
      baseState({ taskLedger: ledger("port the design system", "blocked") }),
      "next step",
      "",
    );
    expect(after.system).toBe(before.system);
  });

  it("does not change when the memory injection does", () => {
    const before = composeTurnRequest(baseState(), "hi", "memory: alpha");
    const after = composeTurnRequest(baseState(), "hi", "memory: beta");
    expect(after.system).toBe(before.system);
  });

  it("still tells the model what the ledger says", () => {
    // Stable does not mean absent. The point of moving it is that it belongs at
    // the tail; dropping it would trade a cache miss for a worse agent.
    const { prompt } = composeTurnRequest(baseState({ taskLedger: ledger("port the design system") }), "next step", "");
    expect(prompt).toContain("Current durable task ledger");
    expect(prompt).toContain("port the design system");
    expect(prompt).toContain("next step");
  });

  it("keeps the user's ask last, where it has the most weight", () => {
    const { prompt } = composeTurnRequest(baseState({ taskLedger: ledger("x") }), "the actual request", "");
    expect(prompt.trimEnd().endsWith("the actual request")).toBe(true);
  });

  it("omits a completed ledger rather than reporting a finished plan as current", () => {
    const { prompt } = composeTurnRequest(
      baseState({ taskLedger: ledger("done already", "completed") }),
      "next step",
      "",
    );
    expect(prompt).not.toContain("Current durable task ledger");
  });

  it("passes the prompt through untouched when there is no dynamic state", () => {
    // Otherwise every turn pays for a preamble separator it does not need.
    const { prompt } = composeTurnRequest(baseState(), "just do it", "");
    expect(prompt).toBe("just do it");
  });
});

describe("end to end, through the real model call", () => {
  let dir: string;
  const systems: string[] = [];
  const prompts: string[] = [];

  beforeEach(async () => {
    dir = await mkdtemp(nodePath.join(tmpdir(), "nah-cache-"));
    systems.length = 0;
    prompts.length = 0;
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("sends byte-identical system prompts on two turns with different ledgers", async () => {
    // The unit tests above pin the composition; this one proves the SDK actually
    // receives it, because the whole claim is about what the cache sees on the
    // wire rather than about what a function returns.
    /**
     * The system text as it reaches the provider.
     *
     * v7 has no `system` field on a model call: the prompt is folded into
     * `prompt` as a leading system-role message. Reading that is not a workaround
     * — it is the more direct assertion, because this leading message *is* the
     * cached prefix, so if it moves the cache misses no matter what the harness
     * thought it was sending.
     */
    const systemOf = (prompt: unknown): string => {
      const messages = prompt as Array<{ role: string; content: unknown }>;
      const first = messages?.[0];
      return first?.role === "system" ? JSON.stringify(first.content) : "";
    };

    const model = new MockLanguageModelV4({
      doStream: async (options: never) => {
        const opts = options as { prompt?: unknown };
        systems.push(systemOf(opts.prompt));
        prompts.push(JSON.stringify(opts.prompt ?? ""));
        return {
          stream: simulateReadableStream<LanguageModelV4StreamPart>({
            chunkDelayInMs: 0,
            chunks: [
              { type: "text-start", id: "t" },
              { type: "text-delta", id: "t", delta: "ok" },
              { type: "text-end", id: "t" },
              { type: "finish", finishReason: finishReason("stop"), usage: v4Usage({ input: 10, output: 2 }) },
            ],
          }),
        };
      },
    });

    const state = baseState({
      cwd: dir,
      model: { model, spec: "test:model" } as SessionState["model"],
      tools: createCodingTools(createNodeEnvironment(dir)) as Record<string, unknown>,
      workspace: createNodeEnvironment(dir),
    });

    state.taskLedger = ledger("first goal");
    await runTurn(state, "do the first thing").done;

    state.taskLedger = ledger("a completely different goal");
    await runTurn(state, "do the second thing").done;

    expect(systems).toHaveLength(2);
    // Identical is the point: any difference here invalidates the cached prefix
    // for the whole transcript behind it.
    expect(systems[1]).toBe(systems[0]);
    expect(systems[1]).toContain("you are a coding agent");
    expect(systems[0]).not.toBe("");
    // And the difference is carried by the request, where it costs one message.
    expect(prompts[1]).toContain("a completely different goal");
    expect(prompts[1]).toContain("do the second thing");
  });
});