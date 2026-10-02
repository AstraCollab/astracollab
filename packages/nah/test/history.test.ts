import { describe, expect, it } from "vitest";
import { simulateReadableStream } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import type { LanguageModelV4StreamPart } from "@ai-sdk/provider";
import type { Terminal } from "@earendil-works/pi-tui";

import { startTuiHost } from "../src/tui/host.js";
import type { SessionState } from "../src/session.js";
import { finishReason, v4Usage } from "./helpers/ai.js";

const USAGE = v4Usage({ input: 1, output: 1 });
const strip = (value: string): string =>
  value
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\u001b\]8;;\u0007/g, "");

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

class FakeTerminal implements Terminal {
  written = "";
  kittyProtocolActive = false;
  onInput: ((d: string) => void) | null = null;
  constructor(
    public columns = 100,
    public rows = 40,
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
  enter() {
    this.onInput?.("\r");
  }
  up() {
    this.onInput?.("\u001b[A");
  }
  down() {
    this.onInput?.("\u001b[B");
  }
}

const makeState = (overrides: Partial<SessionState> = {}): SessionState =>
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
    model: { model: null, spec: "test:model", provider: "openrouter", modelId: "test/model" },
    providerStatus: null,
    totalUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    contextUsedTokens: 0,
    contextUsageEstimated: false,
    lastOutputTokens: 0,
    turns: 0,
    permissions: "yolo",
    ...overrides,
  }) as unknown as SessionState;

const frame = (terminal: FakeTerminal): string =>
  strip((terminal.written.split("\u001b[?2026h").pop() ?? ""));

const settle = (ms = 250): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const waitFor = async (predicate: () => boolean, timeoutMs = 10_000): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return predicate();
};

/**
 * Assertions run against session state, never against the painted frame.
 *
 * Two frame-based approaches were tried and both are worthless here. Matching
 * the text finds the transcript's echo of the original prompt, so a
 * recalled-and-resubmitted prompt looks identical to the first one. Counting
 * user markers in the *last* frame finds nothing at all, because pi-tui
 * redraws only the rows that changed and the transcript line was painted
 * several frames earlier.
 *
 * `state.turns` increments once per real turn, and `/permissions` writes to
 * `state.permissions`, so both are unambiguous.
 */
const withHost = async (
  state: SessionState,
  body: (terminal: FakeTerminal, state: SessionState, prompts: string[]) => Promise<void>,
): Promise<void> => {
  /** Every prompt the model was actually sent, for asserting on content. */
  const prompts: string[] = [];
  const model = new MockLanguageModelV4({
    doStream: async (options) => {
      // The provider receives one `prompt` array of system + user turns; there
      // is no separate `messages` key, and a multi-line user turn arrives as an
      // array of text parts rather than a bare string.
      for (const part of (options.prompt ?? []) as Array<{ role?: string; content?: unknown }>) {
        if (typeof part.content === "string") prompts.push(part.content);
        else if (Array.isArray(part.content)) {
          for (const piece of part.content as Array<{ type?: string; text?: string }>) {
            if (typeof piece.text === "string") prompts.push(piece.text);
          }
        }
      }
      return { stream: textStream("ok") };
    },
  });
  state.model = { model, spec: "test:model", provider: "openrouter", modelId: "test/model" } as never;
  const terminal = new FakeTerminal(100, 40);
  const host = startTuiHost({ state, terminal });
  await waitFor(() => frame(terminal).length > 0);
  try {
    await body(terminal, state, prompts);
  } finally {
    terminal.onInput?.("\x03");
    await host;
  }
};

/** Type a prompt, submit it, and wait for the turn it starts to be counted. */
const submit = async (
  terminal: FakeTerminal,
  state: SessionState,
  prompt: string,
  expectedTurns: number,
): Promise<void> => {
  terminal.type(prompt);
  terminal.enter();
  await waitFor(() => state.turns >= expectedTurns);
};

/** Recall with Up and submit whatever landed in the editor. */
const recallAndSubmit = async (terminal: FakeTerminal, state: SessionState): Promise<void> => {
  terminal.up();
  await settle();
  terminal.enter();
  await settle();
  await waitFor(() => true, 50);
};

describe("prompt history", () => {
  it("restores the previous message on Up and submits it again", async () => {
    await withHost(makeState(), async (terminal, state) => {
      await submit(terminal, state, "find the bug", 1);

      terminal.up();
      await settle();
      terminal.enter();
      // With no history, Up is a no-op and Enter submits nothing. A second turn
      // can only happen if the editor really held the recalled text.
      expect(await waitFor(() => state.turns === 2)).toBe(true);
    });
  });

  it("walks backwards through several messages and forwards again", async () => {
    await withHost(makeState(), async (terminal, state) => {
      await submit(terminal, state, "first ask", 1);
      await submit(terminal, state, "second ask", 2);
      await submit(terminal, state, "third ask", 3);

      terminal.up();
      terminal.up();
      terminal.enter();
      expect(await waitFor(() => state.turns === 4)).toBe(true);

      // Down steps forward again to the newest entry.
      terminal.up();
      terminal.up();
      terminal.down();
      terminal.enter();
      expect(await waitFor(() => state.turns === 5)).toBe(true);
    });
  });

  it("seeds recall from a resumed transcript", async () => {
    const state = makeState({
      messages: [
        { role: "user", content: "an older question" },
        { role: "assistant", content: "an answer" },
        { role: "user", content: "the most recent question" },
      ] as never,
    });

    await withHost(state, async (terminal, live) => {
      // Oldest first when seeding, so the newest entry is the one Up finds.
      terminal.up();
      terminal.enter();
      expect(await waitFor(() => live.turns === 1)).toBe(true);

      terminal.up();
      terminal.enter();
      expect(await waitFor(() => live.turns === 2)).toBe(true);
    });
  });

  it("does not record a slash command, which Enter would re-run", async () => {
    await withHost(makeState(), async (terminal, state) => {
      await submit(terminal, state, "beta", 1);

      terminal.type("/permissions readonly");
      terminal.enter();
      await waitFor(() => state.permissions === "readonly");

      // Put it back, then try to recall the command. If `/permissions readonly`
      // were in history, Up would restore it and Enter would re-apply it.
      state.permissions = "yolo";
      terminal.up();
      await settle();
      terminal.enter();
      await settle();
      expect(state.permissions).toBe("yolo");
    });
  });

  it("leaves a multi-line entry alone, since Up moves the cursor there", async () => {
    await withHost(makeState(), async (terminal, state, prompts) => {
      // History is non-empty, so a firing Up would have something to replace
      // the entry with.
      await submit(terminal, state, "an older prompt", 1);

      terminal.type("line one\nline two");
      terminal.up();
      await settle();
      terminal.enter();

      expect(await waitFor(() => state.turns === 2)).toBe(true);
      const sent = prompts.join("\n");
      // pi-tui gates history to the first visual line, so Up moved the cursor
      // and both lines survived rather than being swapped for the older prompt.
      expect(sent).toContain("line one");
      expect(sent).toContain("line two");
    });
  });
});
