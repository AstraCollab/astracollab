import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as nodePath from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { simulateReadableStream } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import type { LanguageModelV4StreamPart } from "@ai-sdk/provider";

import { runTurn, type SessionState } from "../src/session.js";
import { openLedgerWork } from "../src/auto-continue.js";
import { createCodingTools, createJsonlSessionStore, type SessionTaskLedger } from "not-another-harness";
import { createNodeEnvironment } from "not-another-harness/node";
import { finishReason, v4Usage } from "./helpers/ai.js";

/**
 * Auto-continue: a run that stops with the plan still open.
 *
 * A step that ends with no tool calls is a final answer, and the harness reports
 * it as one. That is the ordinary way a long task dies here — the model narrates
 * its next move, emits no call for it, and the turn ends over work that is
 * visibly half done, with "please continue" as the only way forward. These
 * tests cover the ledger check that makes the run carry on by itself, and the
 * rule that lets it stop when it is genuinely done.
 */

const USAGE = v4Usage({ input: 100, output: 20 });

const textStream = (text: string) =>
  simulateReadableStream<LanguageModelV4StreamPart>({
    chunkDelayInMs: 0,
    chunks: [
      { type: "text-start", id: "t1" },
      { type: "text-delta", id: "t1", delta: text },
      { type: "text-end", id: "t1" },
      { type: "finish", finishReason: finishReason("stop"), usage: USAGE },
    ],
  });

const toolCallStream = (id: string) =>
  simulateReadableStream<LanguageModelV4StreamPart>({
    chunkDelayInMs: 0,
    chunks: [
      { type: "tool-call", toolCallId: id, toolName: "glob", input: JSON.stringify({ pattern: "*.ts" }) },
      { type: "finish", finishReason: finishReason("tool-calls"), usage: USAGE },
    ],
  });

const openLedger = (): SessionTaskLedger => ({
  version: 2,
  goal: "add api keys",
  status: "in_progress",
  steps: [
    { id: "step-1", title: "build the component", status: "completed" },
    { id: "step-2", title: "wire the route", status: "in_progress" },
  ],
  checks: [{ id: "check-1", description: "typecheck", command: "pnpm typecheck", status: "pending", attempts: [] }],
  updatedAt: new Date().toISOString(),
});

describe("auto-continue", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(nodePath.join(tmpdir(), "nah-continue-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const makeState = (model: unknown, taskLedger: SessionTaskLedger | null): SessionState =>
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
      taskLedger,
      discoveredChecks: [],
      store: null,
      model: { model, spec: "test:model" } as SessionState["model"],
      providerStatus: null,
      totalUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      contextUsedTokens: 0,
      contextUsageEstimated: false,
      lastOutputTokens: 0,
      turns: 0,
      permissions: "yolo",
    }) as unknown as SessionState;

  /** A model that plays a script: tool calls and text, in order, repeating the last. */
  const scripted = (script: Array<{ text?: string; tool?: boolean }>) => {
    let index = 0;
    return new MockLanguageModelV4({
      doStream: async () => {
        const entry = script[Math.min(index, script.length - 1)]!;
        index += 1;
        return { stream: entry.tool ? toolCallStream(`c${index}`) : textStream(entry.text ?? "done") };
      },
    });
  };

  const drain = async (turn: ReturnType<typeof runTurn>) => {
    const consumer = (async () => {
      for await (const _ of turn.events) {
        // discard
      }
    })();
    const result = await turn.done;
    await consumer;
    return result;
  };

  const userTexts = (state: SessionState): string[] =>
    state.messages
      .filter((m) => m.role === "user" && typeof m.content === "string")
      .map((m) => m.content as string);

  it("continues a run that stopped with the plan still open", async () => {
    // The model works, then stops mid-task — the exact failure this exists for.
    // Before, the turn ended here and only the human could restart it.
    const state = makeState(scripted([{ tool: true }, { text: "stopping here" }]), openLedger());

    const result = await drain(runTurn(state, "add the api keys page"));

    expect(result.continuations).toBe(1);
    // The run took a step past the model's own stop.
    expect(result.steps).toBe(3);
    expect(userTexts(state).join("\n")).toContain("the task is not finished");
  });

  it("says why it stopped when the model answers in prose instead of working", async () => {
    // Continued once, then the model answered in prose again without doing
    // anything. That is the run going in circles, so it is allowed to stop —
    // and the transcript says why, because a silent stop mid-plan looks like a
    // finished task.
    const state = makeState(scripted([{ tool: true }, { text: "stopping here" }]), openLedger());

    await drain(runTurn(state, "add the api keys page"));

    expect(state.stopNotice).toContain("plan unfinished");
    expect(state.stopNotice).toContain("step");
  });

  it("leaves a finished plan alone", async () => {
    // Everything the plan asked for is done, so the model's stop is an answer.
    const ledger = openLedger();
    ledger.status = "completed";
    ledger.steps = ledger.steps.map((step) => ({ ...step, status: "completed" as const }));
    ledger.checks = ledger.checks.map((check) => ({ ...check, status: "passed" as const }));
    const state = makeState(scripted([{ tool: true }, { text: "all done" }]), ledger);

    const result = await drain(runTurn(state, "add the api keys page"));

    expect(result.continuations).toBe(0);
    expect(result.steps).toBe(2);
    expect(state.stopNotice).toBeNull();
  });

  it("does not push a model that only answered", async () => {
    // No tool call at all: the model was answering, not working. A question
    // asked mid-plan deserves an answer, not a nudge back to the plan.
    const state = makeState(scripted([{ text: "the plan is at step 2 of 2" }]), openLedger());

    const result = await drain(runTurn(state, "how far along is the plan?"));

    expect(result.continuations).toBe(0);
    expect(result.steps).toBe(1);
    expect(state.stopNotice).toBeNull();
  });

  it("continues while the model keeps working", async () => {
    // Work, stop, work, stop: each stop is followed by more work, so the run
    // keeps going rather than ending on the model's say-so.
    const state = makeState(
      scripted([{ tool: true }, { text: "stopping here" }, { tool: true }, { text: "stopping again" }]),
      openLedger(),
    );

    const result = await drain(runTurn(state, "add the api keys page"));

    expect(result.continuations).toBe(2);
  });

  it("persists the continuation in the session transcript", async () => {
    // The session has to show what happened, or a resumed session looks like
    // the model stopped for no reason.
    const store = createJsonlSessionStore(nodePath.join(dir, "s.jsonl"));
    const state = { ...makeState(scripted([{ tool: true }, { text: "stopping here" }]), openLedger()), store };

    await drain(runTurn(state, "add the api keys page"));

    const reloaded = await createJsonlSessionStore(nodePath.join(dir, "s.jsonl")).load();
    const texts = reloaded
      .filter((m) => m.role === "user" && typeof m.content === "string")
      .map((m) => m.content as string);
    expect(texts.join("\n")).toContain("the task is not finished");
  });
});

describe("openLedgerWork", () => {
  it("counts the steps and checks a plan still holds", () => {
    const work = openLedgerWork(openLedger());
    expect(work?.steps).toBe(1);
    expect(work?.checks).toBe(1);
  });

  it("has nothing to say about a plan with no ledger", () => {
    expect(openLedgerWork(null)).toBeNull();
  });

  it("has nothing to say about a blocked plan", () => {
    // `blocked` is the model's own statement that it cannot proceed, and
    // talking it back into working would ignore that.
    const ledger = openLedger();
    ledger.status = "blocked";
    expect(openLedgerWork(ledger)).toBeNull();
  });

  it("has nothing to say about a finished plan", () => {
    const ledger = openLedger();
    ledger.status = "completed";
    ledger.steps = ledger.steps.map((step) => ({ ...step, status: "completed" as const }));
    ledger.checks = ledger.checks.map((check) => ({ ...check, status: "passed" as const }));
    expect(openLedgerWork(ledger)).toBeNull();
  });
});
