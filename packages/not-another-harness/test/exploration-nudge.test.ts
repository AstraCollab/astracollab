import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as nodePath from "node:path";
import { simulateReadableStream } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import type { LanguageModelV4StreamPart } from "@ai-sdk/provider";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runAgent } from "../src/agent.js";
import { createNodeEnvironment } from "../src/node.js";
import { createCodingTools } from "../src/tools.js";
import type { ModelMessage } from "ai";
import type { HarnessEvent } from "../src/types.js";
import { finishReason, v4Usage } from "./helpers/ai.js";

const USAGE = v4Usage({ input: 100, output: 20 });

const grepStep = (pattern: string): ReturnType<typeof simulateReadableStream<LanguageModelV4StreamPart>> =>
  simulateReadableStream<LanguageModelV4StreamPart>({
    chunkDelayInMs: 0,
    chunks: [
      {
        type: "tool-call",
        toolCallId: `c-${pattern}`,
        toolName: "grep",
        input: JSON.stringify({ pattern }),
      },
      { type: "finish", finishReason: finishReason("tool-calls"), usage: USAGE },
    ],
  });

const editStep = (): ReturnType<typeof simulateReadableStream<LanguageModelV4StreamPart>> =>
  simulateReadableStream<LanguageModelV4StreamPart>({
    chunkDelayInMs: 0,
    chunks: [
      {
        type: "tool-call",
        toolCallId: "c-edit",
        toolName: "edit",
        input: JSON.stringify({ path: "a.ts", old_string: "a", new_string: "b" }),
      },
      { type: "finish", finishReason: finishReason("tool-calls"), usage: USAGE },
    ],
  });

const doneStep = (): ReturnType<typeof simulateReadableStream<LanguageModelV4StreamPart>> =>
  simulateReadableStream<LanguageModelV4StreamPart>({
    chunkDelayInMs: 0,
    chunks: [
      { type: "text-start", id: "t" },
      { type: "text-delta", id: "t", delta: "done" },
      { type: "text-end", id: "t" },
      { type: "finish", finishReason: finishReason("stop"), usage: USAGE },
    ],
  });

const scriptedModel = (
  streams: Array<() => ReturnType<typeof simulateReadableStream<LanguageModelV4StreamPart>>>
) => {
  let call = 0;
  return new MockLanguageModelV4({
    doStream: async () => {
      const make = streams[Math.min(call, streams.length - 1)];
      call += 1;
      if (!make) throw new Error("script empty");
      return { stream: make() };
    },
  });
};

/**
 * Distinct nudge messages across every transcript snapshot.
 *
 * `onStepFinish` hands over the whole transcript each step, so a single nudge
 * is visible in every snapshot after the one that produced it. Counting
 * occurrences would report the nudge once per remaining step.
 */
const nudgesIn = (snapshots: ModelMessage[][]): string[] => [
  ...new Set(
    snapshots
      .flat()
      .filter((m) => m.role === "user" && /steps so far/.test(String(m.content)))
      .map((m) => String(m.content)),
  ),
];

const collect = async (events: AsyncIterable<HarnessEvent>): Promise<HarnessEvent[]> => {
  const out: HarnessEvent[] = [];
  for await (const e of events) out.push(e);
  return out;
};

/**
 * The shape of the run that prompted all of this: eight turns, half a million
 * tokens, a seven-step plan, and a diff that only appeared at the very end.
 * Every individual grep was reasonable; the ratio was not.
 */
const EXPLORING_STEPS = 9;

describe("the exploration nudge", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(nodePath.join(tmpdir(), "nah-nudge-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const runAndCapture = async (
  streams: Array<() => ReturnType<typeof simulateReadableStream<LanguageModelV4StreamPart>>>
) => {
    const tools = createCodingTools(createNodeEnvironment(dir)) as Record<string, unknown>;
    const seen: ModelMessage[][] = [];
    const run = runAgent({
      model: scriptedModel(streams),
      system: "test",
      prompt: "fix the blank lines",
      tools,
      maxSteps: EXPLORING_STEPS,
      onStepFinish: (_step, messages) => {
        seen.push(messages);
      },
    });
    await collect(run.events);
    const result = await run.result;
    return { result, seen };
  };

  it("tells a run that has changed nothing that it has changed nothing", async () => {
    const { seen } = await runAndCapture([
      () => grepStep("useState"),
      () => grepStep("Dashboard"),
      () => grepStep("blank"),
      () => grepStep("template"),
      () => grepStep("collapse"),
      () => grepStep("whitespace"),
      () => grepStep("reformat"),
      () => grepStep("newline"),
      () => doneStep(),
    ]);
    // Each snapshot is the whole transcript, so one nudge appears in every later
    // snapshot. Count distinct nudges, not occurrences.
    expect(nudgesIn(seen)).toHaveLength(1);
  });

  it("states the token cost, which is the part the model cannot see", async () => {
    const { seen } = await runAndCapture([
      () => grepStep("a"),
      () => grepStep("b"),
      () => grepStep("c"),
      () => grepStep("d"),
      () => grepStep("e"),
      () => grepStep("f"),
      () => grepStep("g"),
      () => doneStep(),
    ]);
    const nudge = seen
      .flat()
      .find((m) => m.role === "user" && /steps so far/.test(String(m.content)));
    expect(String(nudge?.content)).toMatch(/re-sent this whole transcript/);
    expect(String(nudge?.content)).toMatch(/cheaper than another search/);
  });

  it("says it once, because a repeated nudge is nagging", async () => {
    const { seen } = await runAndCapture(
      Array.from({ length: EXPLORING_STEPS - 1 }, () => () => grepStep("x")).concat([
        () => grepStep("y"),
      ]),
    );
    expect(nudgesIn(seen)).toHaveLength(1);
  });

  it("stays silent once the run has actually changed something", async () => {
    const { seen } = await runAndCapture([
      () => editStep(),
      () => grepStep("a"),
      () => grepStep("b"),
      () => grepStep("c"),
      () => grepStep("d"),
      () => grepStep("e"),
      () => grepStep("f"),
      () => grepStep("g"),
      () => doneStep(),
    ]);
    // The whole point is the ratio, and one edit already broke it.
    expect(nudgesIn(seen)).toHaveLength(0);
  });

  it("does not change the stop reason or the step count", async () => {
    const { result, seen } = await runAndCapture([
      () => grepStep("a"),
      () => grepStep("b"),
      () => grepStep("c"),
      () => grepStep("d"),
      () => grepStep("e"),
      () => grepStep("f"),
      () => grepStep("g"),
      () => doneStep(),
    ]);
    expect(result.reason).toBe("completed");
    expect(result.text).toBe("done");
    // The nudge is a message in the transcript, not a behaviour change.
    expect(seen.length).toBe(EXPLORING_STEPS - 1);
  });
});