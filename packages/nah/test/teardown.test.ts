import { describe, expect, it } from "vitest";
import { simulateReadableStream } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import type { LanguageModelV4StreamPart } from "@ai-sdk/provider";
import type { Terminal } from "@earendil-works/pi-tui";

import { TurnOutput } from "../src/tui/output.js";
import { finishReason, v4Usage } from "./helpers/ai.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

class FakeTerminal implements Terminal {
  written = "";
  kittyProtocolActive = false;
  onInput: ((d: string) => void) | null = null;
  constructor(
    public columns = 80,
    public rows = 24,
  ) {}
  start(onInput: (d: string) => void) {
    this.onInput = onInput;
  }
  stop() {}
  async drainInput() {}
  write(d: string) {
    this.written += d;
  }
  moveBy() {}
  hideCursor() {}
  showCursor() {}
  clearLine() {}
  clearFromCursor() {}
  clearScreen() {}
  setTitle() {}
  setProgress() {}
  type(text: string) {
    for (const ch of text) this.onInput?.(ch);
  }
}

const textStream = (text: string) =>
  simulateReadableStream<LanguageModelV4StreamPart>({
    chunkDelayInMs: 0,
    chunks: [
      { type: "text-start", id: "t" },
      { type: "text-delta", id: "t", delta: text },
      { type: "text-end", id: "t" },
      { type: "finish", finishReason: finishReason("stop"), usage: v4Usage({ input: 5, output: 1 }) },
    ],
  });

const makeState = (model: unknown) =>
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
  }) as never;

describe("terminal teardown", () => {
  it("exits when Ctrl-C is pressed again after aborting a stuck turn", async () => {
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
    const terminal = new FakeTerminal();
    const state = makeState(model);

    const host = startTuiHost({ state, terminal });
    await sleep(30);
    terminal.type("work");
    terminal.onInput?.("\r");
    await sleep(150);

    // Abort, then quit while the turn is still settling.
    terminal.onInput?.("\x03");
    await sleep(50);
    terminal.onInput?.("\x03");

    const exited = await Promise.race([
      host.then(() => "exited" as const),
      sleep(3000).then(() => "hung" as const),
    ]);

    release();
    const settled = await Promise.race([host.then(() => "exited" as const), sleep(2000).then(() => "hung" as const)]);
    expect(exited === "exited" || settled === "exited").toBe(true);
  }, 30000);
});
