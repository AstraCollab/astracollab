import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as nodePath from "node:path";
import { promisify } from "node:util";
import type { LanguageModelV4StreamPart } from "@ai-sdk/provider";
import { simulateReadableStream } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { OrchestratorEvent } from "not-another-harness";

import { childEventLine } from "../src/child-events.js";
import { createDelegationTools, createSessionOrchestrator } from "../src/delegation.js";
import { finishReason, v4Usage } from "./helpers/ai.js";

const execFileAsync = promisify(execFile);
const USAGE = v4Usage({ input: 50, output: 10 });

const stream = (chunks: LanguageModelV4StreamPart[]) =>
  simulateReadableStream<LanguageModelV4StreamPart>({ chunkDelayInMs: 0, chunks });

/** One response: a tool call, and nothing after — the run then asks again. */
const callsTool = (toolName: string, input: unknown, toolCallId: string) =>
  stream([
    { type: "tool-call", toolCallId, toolName, input: JSON.stringify(input) },
    { type: "finish", finishReason: finishReason("tool-calls"), usage: USAGE },
  ]);

/** One response: prose and a clean stop, so the child is done. */
const answersWith = (text: string) =>
  stream([
    { type: "text-start", id: "t1" },
    { type: "text-delta", id: "t1", delta: text },
    { type: "text-end", id: "t1" },
    { type: "finish", finishReason: finishReason("stop"), usage: USAGE },
  ]);

/**
 * Answers in order, then keeps answering with the last one.
 *
 * Order matters only for a single child. Several children share one model, and
 * which of them lands on which response is not something a test should pin down.
 */
const scriptedModel = (responses: Array<() => ReturnType<typeof stream>>) => {
  let call = 0;
  return new MockLanguageModelV4({
    doStream: async () => ({ stream: responses[Math.min(call++, responses.length - 1)]!() }),
  });
};

/** The same model for every call, for assertions that do not care who answered. */
const repeatingModel = (response: () => ReturnType<typeof stream>) =>
  new MockLanguageModelV4({ doStream: async () => ({ stream: response() }) });

type Recorded = Extract<OrchestratorEvent, { type: "subtask-event" }>;

const runTool = async (tool: unknown, input: unknown): Promise<string> =>
  String(
    await (tool as { execute: (input: unknown, options: unknown) => Promise<unknown> }).execute(input, {}),
  );

describe("a delegated child actually runs, and is visible while it does", () => {
  let repo: string;

  beforeEach(async () => {
    repo = await mkdtemp(nodePath.join(tmpdir(), "nah-delegate-"));
    const git = (...args: string[]) =>
      execFileAsync("git", [
        "-C",
        repo,
        "-c",
        "user.email=child@example.test",
        "-c",
        "user.name=Child",
        "-c",
        "commit.gpgsign=false",
        ...args,
      ]);
    await git("init", "-q");
    await writeFile(nodePath.join(repo, "README.md"), "seed\n", "utf8");
    await git("add", "-A");
    await git("commit", "-q", "-m", "seed");
  });

  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  /**
   * The gap this closes.
   *
   * Every other delegation test asserts a prompt string or a transcript label,
   * so the suite stayed green with `runAll` reduced to a no-op — nothing had ever
   * asserted that a child is started, given a real workspace, handed a model, and
   * run to completion. The thing under test is the capability, not its wording.
   */
  it("runs the child to completion and reports progress as it happens", async () => {
    const model = scriptedModel([
      () => callsTool("write", { path: "child.txt", content: "written by the child" }, "call-1"),
      () => answersWith("child finished"),
    ]);
    const events: OrchestratorEvent[] = [];

    const orchestrator = createSessionOrchestrator({
      cwd: repo,
      system: "parent system",
      getModel: () => model as never,
      approve: async () => true,
      onChildUsage: () => undefined,
      onChildEvent: (event) => events.push(event),
    });
    const tools = createDelegationTools({ orchestrator, approve: async () => true });

    const output = await runTool(tools.delegate_task, {
      title: "write a file",
      task: "Write child.txt containing one line, then report what you did.",
    });

    // The child ran, and finished on its own terms rather than erroring.
    const finished = events.filter((e) => e.type === "subtask-finish");
    expect(finished).toHaveLength(1);
    expect(finished[0]!.result.status).not.toBe("error");
    expect(finished[0]!.result.steps).toBeGreaterThan(0);

    // It did work, in an isolated workspace, which is what makes it a child
    // agent rather than a second call on the parent.
    expect(finished[0]!.result.toolCalls).toBeGreaterThan(0);
    const started = events.filter((e) => e.type === "subtask-start");
    expect(started).toHaveLength(1);
    expect(started[0]!.title).toBe("write a file");

    // The progress the handler never used to receive is what makes this visible
    // in the UI, so its absence was the whole complaint.
    const writeCall = events.find(
      (e): e is Recorded => e.type === "subtask-event" && e.event.type === "tool-call",
    );
    expect(writeCall).toBeDefined();
    expect(writeCall!.event.type === "tool-call" && writeCall!.event.toolName).toBe("write");
    expect(writeCall!.event.type === "tool-call" && (writeCall!.event.input as { path: string }).path).toBe(
      "child.txt",
    );

    // And that event renders as a line a reader can follow.
    expect(childEventLine(writeCall!.title, writeCall!.event)).toContain("write child.txt");
    expect(output).toContain("write a file");
  });

  it("reports every child of a fan-out, tagged with its own title", async () => {
    const model = repeatingModel(() => answersWith("child finished"));
    const events: OrchestratorEvent[] = [];

    const orchestrator = createSessionOrchestrator({
      cwd: repo,
      system: "parent system",
      getModel: () => model as never,
      approve: async () => true,
      onChildUsage: () => undefined,
      onChildEvent: (event) => events.push(event),
    });
    const tools = createDelegationTools({ orchestrator, approve: async () => true });

    await runTool(tools.delegate_tasks, {
      tasks: [
        { title: "first subtask", task: "Do the first independent piece of work here." },
        { title: "second subtask", task: "Do the second independent piece of work here." },
        { title: "third subtask", task: "Do the third independent piece of work here." },
      ],
    });

    // Three children means three starts and three finishes. A count of one is
    // what a silently-serialised orchestrator would produce.
    expect(events.filter((e) => e.type === "subtask-start").map((e) => e.title)).toEqual([
      "first subtask",
      "second subtask",
      "third subtask",
    ]);
    const finished = events.filter((e) => e.type === "subtask-finish");
    expect(finished).toHaveLength(3);
    expect(finished.every((e) => e.type === "subtask-finish" && e.result.status !== "error")).toBe(true);
  });

  it("still delegates when no host installed a handler", async () => {
    // Studio builds an orchestrator with no `onChildEvent`, and a caller that
    // never subscribed must still get working delegation rather than a throw.
    const model = repeatingModel(() => answersWith("child finished"));
    const orchestrator = createSessionOrchestrator({
      cwd: repo,
      system: "parent system",
      getModel: () => model as never,
      approve: async () => true,
      onChildUsage: () => undefined,
    });
    const tools = createDelegationTools({ orchestrator, approve: async () => true });

    const output = await runTool(tools.delegate_task, {
      title: "unobserved subtask",
      task: "Do one bounded piece of work and then report on it.",
    });

    expect(output).toContain("unobserved subtask");
  });

  it("does not start a child when approval is denied", async () => {
    const model = repeatingModel(() => answersWith("child finished"));
    const events: OrchestratorEvent[] = [];
    const orchestrator = createSessionOrchestrator({
      cwd: repo,
      system: "parent system",
      getModel: () => model as never,
      approve: async () => true,
      onChildUsage: () => undefined,
      onChildEvent: (event) => events.push(event),
    });
    const tools = createDelegationTools({ orchestrator, approve: async () => false });

    const output = await runTool(tools.delegate_task, {
      title: "denied subtask",
      task: "This one should never be started, because the gate says no.",
    });

    expect(output).toContain("approval was denied");
    expect(events).toHaveLength(0);
  });
});

describe("a child's noise does not become the transcript", () => {
  it("renders the tool call and the step, and drops the prose", () => {
    const title = "extract the parser";
    expect(childEventLine(title, { type: "step-start", step: 2 })).toBe("  · extract the parser · step 2");
    expect(
      childEventLine(title, {
        type: "tool-call",
        step: 1,
        toolCallId: "c1",
        toolName: "edit",
        input: { path: "src/a.ts", old_string: "x", new_string: "y" },
      }),
    ).toContain("edit src/a.ts");
    // A child narrates constantly; printing it all buries the turn that asked
    // for the work, so text events are dropped rather than shown.
    expect(childEventLine(title, { type: "text-delta", step: 1, text: "Now let me look at…" })).toBeNull();
    expect(childEventLine(title, { type: "run-start", stepBudget: null, tokenBudget: 0 })).toBeNull();
  });

  it("keeps a long child title from wrapping its line", () => {
    const line = childEventLine("a".repeat(80), { type: "step-start", step: 1 });
    expect(line).toContain("…");
    expect(line!.length).toBeLessThan(60);
  });
});