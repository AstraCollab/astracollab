import { describe, expect, it } from "vitest";
import { simulateReadableStream } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import type { LanguageModelV4StreamPart } from "@ai-sdk/provider";
import type { Terminal } from "@earendil-works/pi-tui";

import { TurnOutput, stripMouseReportText } from "../src/tui/output.js";
import type { SessionState } from "../src/session.js";
import { finishReason, v4Usage } from "./helpers/ai.js";

const USAGE = v4Usage({ input: 10, output: 5 });

const strip = (s: string) => s.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "").replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, "");

const textStream = (text: string) =>
  simulateReadableStream<LanguageModelV4StreamPart>({
    chunkDelayInMs: 0,
    chunks: [
      { type: "text-start", id: "t" },
      { type: "text-delta", id: "t", delta: text },
      { type: "text-end", id: "t" },
      { type: "finish", finishReason: finishReason("stop"), usage: USAGE },
    ],
  });

const toolStream = (id: string) =>
  simulateReadableStream<LanguageModelV4StreamPart>({
    chunkDelayInMs: 0,
    chunks: [
      { type: "tool-call", toolCallId: id, toolName: "grep", input: JSON.stringify({ pattern: "needle" }) },
      { type: "finish", finishReason: finishReason("tool-calls"), usage: USAGE },
    ],
  });

/** Records everything the TUI paints, so tests can assert on real layout. */
class FakeTerminal implements Terminal {
  written = "";
  kittyProtocolActive = false;
  onInput: ((data: string) => void) | null = null;
  onResize: (() => void) | null = null;
  constructor(
    public columns = 60,
    public rows = 24,
  ) {}
  start(onInput: (data: string) => void, onResize: () => void): void {
    this.onInput = onInput;
    this.onResize = onResize;
  }
  stop(): void {}
  async drainInput(): Promise<void> {}
  write(data: string): void {
    this.written += data;
  }
  moveBy(): void {}
  hideCursor(): void {}
  showCursor(): void {}
  clearLine(): void {}
  clearFromCursor(): void {}
  clearScreen(): void {}
  setTitle(): void {}
  setProgress(): void {}
  /** Simulate the user pressing keys. */
  type(text: string): void {
    for (const char of text) this.onInput?.(char);
  }
  enter(): void {
    this.onInput?.("\r");
  }
}

const makeState = (model: unknown): SessionState =>
  ({
    messages: [],
    system: "s",
    cwd: "/tmp",
    tools: {},
    workspace: {},
    activeFileChanges: null,
    activeShellCommands: null,
    undoHistory: [],
    sessionBasePath: null,
    taskLedger: null,
    discoveredChecks: [],
    store: null,
    model: { model, spec: "test:model" },
    providerStatus: null,
    totalUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    contextUsedTokens: 0,
    contextUsageEstimated: false,
    lastOutputTokens: 0,
    turns: 0,
    permissions: "yolo",
  }) as unknown as SessionState;

describe("TurnOutput", () => {
  it("coalesces a stream of deltas into one wrapping block", () => {
    const output = new TurnOutput();
    output.appendStream("Hello ");
    output.appendStream("there, ");
    output.appendStream("world.");
    expect(output.blockCount).toBe(1);
    expect(strip(output.render(40).join("\n"))).toContain("Hello there, world.");
  });

  it("wraps long streamed text instead of overflowing", () => {
    const output = new TurnOutput();
    output.appendStream("word ".repeat(40));
    const lines = output.render(30).map(strip);
    expect(lines.length).toBeGreaterThan(3);
    for (const line of lines) expect(line.trimEnd().length).toBeLessThanOrEqual(30);
  });

  it("starts a new block when a tool call interrupts the stream", () => {
    const output = new TurnOutput();
    output.apply({ type: "text-delta", step: 1, text: "thinking" });
    output.apply({
      type: "tool-call",
      step: 1,
      toolCallId: "c1",
      toolName: "grep",
      input: { pattern: "needle" },
    });
    const text = strip(output.render(80).join("\n"));
    expect(text).toContain("thinking");
    expect(text).toContain("grep");
    expect(output.hasOpenStream).toBe(false);
  });

  it("stays quiet for a successful search but always shows errors", () => {
    // The call line already says what ran; echoing the body doubled the noise.
    const quiet = new TurnOutput();
    quiet.apply({ type: "tool-call", step: 1, toolCallId: "c1", toolName: "grep", input: { pattern: "needle" } });
    quiet.apply({
      type: "tool-result",
      step: 1,
      toolCallId: "c1",
      toolName: "grep",
      output: "3 matches for \"needle\":\na.ts:1: needle here",
      isError: false,
    });
    const quietText = strip(quiet.render(80).join("\n"));
    expect(quietText).toContain("grep needle");
    expect(quietText).not.toContain("a.ts:1");
    expect(quietText.split("\n").filter((l) => l.trim())).toHaveLength(1);

    const errored = new TurnOutput();
    errored.apply({ type: "tool-call", step: 1, toolCallId: "c2", toolName: "grep", input: { pattern: "x" } });
    errored.apply({
      type: "tool-result",
      step: 1,
      toolCallId: "c2",
      toolName: "grep",
      output: "Error: no such file",
      isError: true,
    });
    const errorText = strip(errored.render(80).join("\n"));
    expect(errorText).toContain("no such file");
    expect(errorText).toContain("\u2717");
  });

  it("collapses a run of identical tool calls into one line", () => {
    const output = new TurnOutput();
    // Identical repeated call, e.g. re-reading the same file.
    for (let i = 0; i < 6; i += 1) {
      output.apply({
        type: "tool-call",
        step: 1,
        toolCallId: `c${i}`,
        toolName: "read",
        input: { path: "src/app.ts" },
      });
      output.apply({
        type: "tool-result",
        step: 1,
        toolCallId: `c${i}`,
        toolName: "read",
        input: { path: "src/app.ts" },
        output: "1|export const a = 1;",
        isError: false,
      });
    }
    const lines = strip(output.render(90).join("\n")).split("\n").filter((l) => l.trim());
    // Six calls collapse to a single line carrying a tally.
    expect(lines.filter((l) => l.includes("\u25c6"))).toHaveLength(1);
    expect(lines[0]).toContain("read src/app.ts");
    expect(lines[0]).toContain("\u00d76");
  });

  it("marks a steer once it is delivered, not while it is still queued", () => {
    const output = new TurnOutput();
    output.apply({
      type: "user-message",
      text: "use TypeScript",
      delivery: "steer",
      phase: "queued",
    });
    expect(strip(output.render(80).join("\n"))).not.toContain("steering delivered");

    output.apply({
      type: "user-message",
      text: "use TypeScript",
      delivery: "steer",
      phase: "delivered",
    });
    expect(strip(output.render(80).join("\n"))).toContain("steering delivered");
  });

  it("summarises the finish reason and token usage", () => {
    const output = new TurnOutput();
    output.apply({
      type: "finish",
      reason: "completed",
      text: "done",
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15, estimated: true },
    });
    const text = strip(output.render(80).join("\n"));
    expect(text).toContain("completed");
    // Labelled as throughput, because this figure sums every request the run
    // sent; a provider's log shows one request, so "15 tokens" invited a
    // comparison that could never match.
    expect(text).toContain("15 processed");
    expect(text).toContain("estimated");
  });

  it("surfaces file changes recorded during a step", () => {
    const output = new TurnOutput(() => [
      { path: "src/a.ts", existed: false, after: "export const a = 1;\n" },
    ]);
    output.apply({ type: "step-finish", step: 1, usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } });
    expect(strip(output.render(100).join("\n"))).toContain("src/a.ts");
  });
});

describe("alternate-screen host layout", () => {
  /** Every pi-tui frame is wrapped in synchronized-output markers. */
  const lastFrame = (terminal: FakeTerminal): string => {
    const frames = terminal.written.split("\u001b[?2026h");
    return strip(frames[frames.length - 1] ?? "");
  };

  /**
   * Wait for a condition instead of guessing a sleep.
   *
   * These renders are driven by a streamed model response, so a fixed delay is
   * a coin flip: long enough and the test is slow, short enough and it reads a
   * half-painted frame and fails intermittently. Returns whether it settled, so
   * a genuine failure still fails on the assertion rather than hanging.
   */
  const waitFor = async (
    predicate: () => boolean,
    timeoutMs = 10_000
  ): Promise<boolean> => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (predicate()) return true;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return predicate();
  };

  it("keeps reporting file changes on later turns", () => {
    // `activeFileChanges` is replaced with a fresh array each turn. A counter
    // carried across turns would exceed the new array and silently stop.
    let changes: Array<{ path: string; existed: boolean; after: string }> = [
      { path: "src/one.ts", existed: false, after: "a" },
      { path: "src/two.ts", existed: false, after: "b" },
      { path: "src/three.ts", existed: false, after: "c" },
    ];
    const output = new TurnOutput(() => changes);
    const finish = () => output.apply({
      type: "step-finish",
      step: 1,
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    });

    finish();
    const first = strip(output.render(100).join("\n"));
    expect(first).toContain("src/one.ts");
    expect(first).toContain("src/three.ts");

    // Second turn: a *shorter* list. Without resetting, nothing would render.
    changes = [{ path: "src/later.ts", existed: false, after: "d" }];
    finish();
    const second = strip(output.render(100).join("\n"));
    expect(second).toContain("src/later.ts");
  });

  it("shows the transcript and the user's half-typed input in the same frame", async () => {
    const { startTuiHost } = await import("../src/tui/host.js");
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let step = 0;
    const model = new MockLanguageModelV4({
      doStream: async () => {
        // First step holds so we can type mid-turn; later steps finish quickly.
        if (step++ === 0) await gate;
        return { stream: step === 1 ? toolStream("c1") : textStream("all done") };
      },
    });
    const terminal = new FakeTerminal(60, 20);
    const state = makeState(model);

    const host = startTuiHost({ state, terminal });
    await waitFor(() => lastFrame(terminal).length > 0);

    terminal.type("find the bug");
    terminal.enter();
    // The turn has started and the model call is parked on the gate.
    await waitFor(() => strip(terminal.written).includes("find the bug"));

    // Type a correction but do NOT submit it — it must sit in the editor.
    terminal.type("actually use TypeScript");
    await waitFor(() => lastFrame(terminal).includes("actually use TypeScript"));

    release();
    // Wait for a frame satisfying every condition at once. Waiting for them in
    // sequence could latch onto an intermediate frame that had the summary but
    // not yet repainted the editor, which is what made this flaky.
    // The claim under test: one frame showing transcript output *and* the
    // un-submitted editor text. Only those two — the reply itself scrolls out of
    // a 20-row frame once the finish line lands, so it is asserted over the
    // whole stream rather than the final frame.
    const settled = await waitFor(() => {
      const current = lastFrame(terminal);
      return current.includes("completed") && current.includes("actually use TypeScript");
    });
    expect(settled, "no frame showed transcript output and half-typed input together").toBe(true);

    const frame = lastFrame(terminal);
    expect(frame).toContain("completed");
    expect(frame).toContain("actually use TypeScript");
    // Both were rendered at some point during the run.
    const stream = strip(terminal.written);
    expect(stream).toContain("all done");
    expect(stream).toContain("find the bug");

    terminal.onInput?.("\x03");
    await host;
  });

  it("exits on Ctrl-D with an empty editor and on Ctrl-C when idle", async () => {
    const { startTuiHost } = await import("../src/tui/host.js");
    const model = new MockLanguageModelV4({ doStream: async () => ({ stream: textStream("x") }) });
    const terminal = new FakeTerminal(60, 20);
    const state = makeState(model);

    let stopped = false;
    const host = startTuiHost({ state, terminal, onQuit: () => (stopped = true) });
    await new Promise((resolve) => setTimeout(resolve, 20));

    // Ctrl-D with an empty editor quits.
    terminal.onInput?.("\x04");
    await host;
    expect(stopped).toBe(true);
  });

  it("does not treat Ctrl-D as quit while the editor has text", async () => {
    const { startTuiHost } = await import("../src/tui/host.js");
    const model = new MockLanguageModelV4({ doStream: async () => ({ stream: textStream("x") }) });
    const terminal = new FakeTerminal(60, 20);
    const state = makeState(model);

    let stopped = false;
    const host = startTuiHost({ state, terminal, onQuit: () => (stopped = true) });
    await new Promise((resolve) => setTimeout(resolve, 20));

    terminal.type("half typed");
    terminal.onInput?.("\x04");
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(stopped).toBe(false);

    terminal.onInput?.("\x03");
    await host;
    expect(stopped).toBe(true);
  });

  it("opens the model list for a bare /model", async () => {
    const { startTuiHost } = await import("../src/tui/host.js");
    const model = new MockLanguageModelV4({ doStream: async () => ({ stream: textStream("x") }) });
    const terminal = new FakeTerminal(60, 20);
    const state = makeState(model);

    const host = startTuiHost({ state, terminal });
    await new Promise((resolve) => setTimeout(resolve, 20));

    // Regression: the picker lives in the REPL, not in handleSlashCommand, so a
    // bare `/model` used to print "current model: …" and never list anything.
    terminal.type("/model");
    terminal.enter();
    // getModelOptions() fetches models.dev with a short timeout.
    await new Promise((resolve) => setTimeout(resolve, 6000));

    const frame = strip(terminal.written);
    expect(frame).not.toContain("current model:");
    expect(frame).toContain("Loading model catalog");
    // No TTY here, so the picker bails out cleanly instead of hanging.
    expect(frame).toContain("cancelled");

    terminal.onInput?.("\x03");
    await host;
  }, 20000);

  it("dispatches /model <spec> as a direct switch", async () => {
    const { startTuiHost } = await import("../src/tui/host.js");
    const model = new MockLanguageModelV4({ doStream: async () => ({ stream: textStream("x") }) });
    const terminal = new FakeTerminal(60, 20);
    // No API key, so resolveModel fails deterministically — which proves the
    // command reached the model-switch path rather than being ignored.
    const state = makeState(model);

    const host = startTuiHost({ state, terminal });
    await new Promise((resolve) => setTimeout(resolve, 20));

    terminal.type("/model anthropic:claude-sonnet-4-5");
    terminal.enter();
    await new Promise((resolve) => setTimeout(resolve, 200));

    const frame = strip(terminal.written);
    expect(frame).not.toContain("unknown command");
    expect(frame).toMatch(/API_KEY|Unknown provider/i);

    terminal.onInput?.("\x03");
    await host;
  });

  it("refuses an exclusive command while a turn is streaming", async () => {
    const { startTuiHost } = await import("../src/tui/host.js");
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const model = new MockLanguageModelV4({
      doStream: async () => {
        await gate;
        return { stream: textStream("done") };
      },
    });
    const terminal = new FakeTerminal(60, 20);
    const state = makeState(model);

    const host = startTuiHost({ state, terminal });
    await new Promise((resolve) => setTimeout(resolve, 20));
    terminal.type("start work");
    terminal.enter();
    await new Promise((resolve) => setTimeout(resolve, 120));

    terminal.type("/model");
    terminal.enter();
    await new Promise((resolve) => setTimeout(resolve, 120));

    // It must be refused rather than stealing the terminal mid-turn.
    expect(strip(terminal.written)).toContain("needs the terminal to itself");
    expect(state.turns).toBe(0);

    release();
    await new Promise((resolve) => setTimeout(resolve, 150));
    terminal.onInput?.("\x03");
    await host;
  });

  it("steers a running turn instead of starting a second one", async () => {
    const { startTuiHost } = await import("../src/tui/host.js");
    // Hold the very first model call open so the turn is unambiguously still in
    // flight when the steer is submitted. (A turn that finishes first would
    // correctly be treated as a fresh prompt — a different, also valid path.)
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const model = new MockLanguageModelV4({
      doStream: async () => {
        await gate;
        return { stream: textStream("all done") };
      },
    });
    const terminal = new FakeTerminal(60, 20);
    const state = makeState(model);

    const host = startTuiHost({ state, terminal });
    await new Promise((resolve) => setTimeout(resolve, 20));

    terminal.type("first task");
    terminal.enter();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(state.turns).toBe(0); // turn started, not finished

    // Submit a correction while the model call is still in flight.
    terminal.type("actually use TypeScript");
    terminal.enter();
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Echoed immediately, but no second turn was started.
    expect(strip(terminal.written)).toContain("actually use TypeScript");
    expect(state.turns).toBe(0);

    release();
    await new Promise((resolve) => setTimeout(resolve, 200));

    // The steer reached the model and landed in the transcript.
    expect(
      state.messages.filter((m) => m.role === "user" && m.content === "actually use TypeScript"),
    ).toHaveLength(1);
    expect(state.turns).toBe(1);

    terminal.onInput?.("\x03"); // idle -> quit
    await host;
  });
});

describe("orphaned mouse-report text", () => {
  const GARBAGE = "35;107;19M35;108; 20M35; 109; 20M35; 110; 20M";

  it("strips a burst of leaked mouse reports from resumed history", () => {
    expect(stripMouseReportText(GARBAGE)).not.toMatch(/\d+;\d+;\d+[Mm]/);
    // Prose that merely contains digits and semicolons is left alone.
    expect(stripMouseReportText("matrix 1;2;3 here")).toBe("matrix 1;2;3 here");
    expect(stripMouseReportText("use offset 12;30 and then stop")).toContain("12;30");
  });

  it("never renders a burst of mouse reports, even from a polluted session", () => {
    const output = new TurnOutput();
    output.seedHistory([
      { role: "user", content: `before ${GARBAGE} after` },
      { role: "assistant", content: `reply ${GARBAGE} end` },
    ]);
    const text = strip(output.render(120).join("\n"));
    expect(text).not.toMatch(/\d+;\s*\d+;\s*\d+[Mm]/);
    expect(text).toContain("before");
    expect(text).toContain("after");
  });

  it("also sanitises streamed assistant text", () => {
    const output = new TurnOutput();
    output.appendStream(`answer ${GARBAGE} done`);
    expect(strip(output.render(120).join("\n"))).not.toMatch(/\d+;\s*\d+;\s*\d+[Mm]/);
  });

  it("sanitises a restored markdown response, which skips the plain-line path", () => {
    const output = new TurnOutput();
    output.seedHistory([
      { role: "assistant", content: `## Result ${GARBAGE} done` },
    ]);
    expect(strip(output.render(120).join("\n"))).not.toMatch(/\d+;\s*\d+;\s*\d+[Mm]/);
  });

  it("keeps markdown indentation, which the report stripper used to flatten", () => {
    // Collapsing runs of spaces to one turned every nested list and every
    // indented code block into a flush-left paragraph, destroying the structure.
    const output = new TurnOutput();
    output.addMarkdown("- top level\n  - nested item\n\n    indented code\n");
    const text = strip(output.render(120).join("\n"));
    // Lines are space-padded to the pane width, so compare trimmed lines.
    const lines = text.split("\n").map((line) => line.trimEnd());
    // The nested bullet keeps its extra indent relative to the top-level one.
    expect(lines).toContain("  - top level");
    expect(lines).toContain("      - nested item");
    expect(lines).toContain("        indented code");
  });
});
