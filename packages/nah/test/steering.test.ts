import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as nodePath from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { simulateReadableStream } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import type { LanguageModelV4StreamPart } from "@ai-sdk/provider";

import { runTurn, type SessionState } from "../src/session.js";
import { createCodingTools, createJsonlSessionStore } from "not-another-harness";
import { createNodeEnvironment } from "not-another-harness/node";
import { finishReason, v4Usage } from "./helpers/ai.js";

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

describe("runTurn steering", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(nodePath.join(tmpdir(), "nah-steer-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const makeState = (model: unknown, store: SessionState["store"]): SessionState =>
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
      model: { model, spec: "test:model" } as SessionState["model"],
      providerStatus: null,
      totalUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      contextUsedTokens: 0,
      contextUsageEstimated: false,
      lastOutputTokens: 0,
      turns: 0,
      permissions: "yolo",
    }) as unknown as SessionState;

  it("delivers mid-turn input to the model and persists it in the session", async () => {
    const prompts: string[] = [];
    let call = 0;
    const model = new MockLanguageModelV4({
      doStream: async ({ prompt }) => {
        prompts.push(JSON.stringify(prompt));
        const index = call;
        call += 1;
        return { stream: index < 2 ? toolCallStream(`c${index}`) : textStream("finished") };
      },
    });
    const store = createJsonlSessionStore(nodePath.join(dir, "s.jsonl"));
    const state = makeState(model, store);

    const turn = runTurn(state, "add a docs section");

    // The user types while step 1 is still streaming.
    expect(turn.steer("actually register it in the nav too")).toBe(true);
    expect(turn.pending().steer).toEqual(["actually register it in the nav too"]);

    // Drain events so the renderer can consume them, as the REPL does.
    const consumer = (async () => {
      for await (const _ of turn.events) {
        // discard
      }
    })();
    const result = await turn.done;
    await consumer;

    expect(result.reason).toBe("completed");
    expect(result.text).toBe("finished");
    expect(prompts[0]).not.toContain("register it in the nav");
    expect(prompts[2]).toContain("register it in the nav");

    // Folded into session state and appended to the JSONL store.
    const userTexts = state.messages
      .filter((m) => m.role === "user" && typeof m.content === "string")
      .map((m) => m.content as string);
    expect(userTexts).toContain("actually register it in the nav too");

    const reloaded = await createJsonlSessionStore(nodePath.join(dir, "s.jsonl")).load();
    expect(
      reloaded.filter((m) => m.role === "user" && typeof m.content === "string").map((m) => m.content as string),
    ).toContain("actually register it in the nav too");
  });

  it("keeps a follow-up from being dropped when the model gives a final answer", async () => {
    let call = 0;
    const model = new MockLanguageModelV4({
      doStream: async () => {
        const index = call;
        call += 1;
        return { stream: index === 0 ? toolCallStream("c0") : textStream(`answer ${index}`) };
      },
    });
    const state = makeState(model, null);

    const turn = runTurn(state, "do the thing");
    turn.followUp("and update the changelog");

    const consumer = (async () => {
      for await (const _ of turn.events) {
        // discard
      }
    })();
    const result = await turn.done;
    await consumer;

    // Turn 1 ends with "answer 1", but the follow-up keeps the run alive for turn 2.
    expect(result.steps).toBeGreaterThan(1);
    expect(result.text).toBe("answer 2");
    expect(
      state.messages
        .filter((m) => m.role === "user" && typeof m.content === "string")
        .map((m) => m.content as string),
    ).toContain("and update the changelog");
  });
});
