import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as nodePath from "node:path";
import { describe, expect, it } from "vitest";
import { simulateReadableStream } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import type { LanguageModelV4StreamPart } from "@ai-sdk/provider";
import type { Terminal } from "@earendil-works/pi-tui";

import { createApprover } from "../src/permissions.js";
import { TurnOutput } from "../src/tui/output.js";
import type { SessionState } from "../src/session.js";
import { finishReason, v4Usage } from "./helpers/ai.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** How many approval questions a frame shows, so each can be answered once. */
const countPrompts = (frame: string): number =>
  frame.split("always this tool").length - 1;

const strip = (s: string) =>
  s.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "").replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, "");

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

const bashStream = (id: string) =>
  simulateReadableStream<LanguageModelV4StreamPart>({
    chunkDelayInMs: 0,
    chunks: [
      { type: "tool-call", toolCallId: id, toolName: "bash", input: JSON.stringify({ command: "echo hi" }) },
      { type: "finish", finishReason: finishReason("tool-calls"), usage: v4Usage({ input: 10, output: 1 }) },
    ],
  });

describe("approval prompt", () => {
  it("uses the host prompt instead of readline when one is installed", async () => {
    const ask = createApprover(() => "ask");
    const asked: string[] = [];
    ask.setPrompt(async (question) => {
      asked.push(question);
      return "y";
    });
    expect(await ask("bash", { command: "ls" })).toBe(true);
    expect(asked[0]).toContain("ls");
  });

  it("'a' trusts the whole tool, so later commands stop asking", async () => {
    const ask = createApprover(() => "ask");
    let reply = "a";
    ask.setPrompt(async () => reply);
    let prompted = 0;
    ask.setPrompt(async () => {
      prompted += 1;
      return reply;
    });

    expect(await ask("bash", { command: "git status" })).toBe(true);
    expect(prompted).toBe(1);
    // A different command, same tool: must not ask again.
    reply = "n";
    expect(await ask("bash", { command: "git log --oneline -10" })).toBe(true);
    expect(prompted).toBe(1);
    expect(await ask("bash", { command: "cd apps/nah && git diff --stat" })).toBe(true);
    expect(prompted).toBe(1);
    // A different tool is still asked about.
    expect(await ask("write", { path: "a.ts", content: "x" })).toBe(false);
    expect(prompted).toBe(2);
  });

  it("'A' trusts only that exact call", async () => {
    const ask = createApprover(() => "ask");
    let prompted = 0;
    let reply = "A";
    ask.setPrompt(async () => {
      prompted += 1;
      return reply;
    });

    expect(await ask("bash", { command: "git status" })).toBe(true);
    expect(prompted).toBe(1);
    // Same tool, different command: still asks.
    reply = "n";
    expect(await ask("bash", { command: "git log" })).toBe(false);
    expect(prompted).toBe(2);
  });

  it("still short-circuits readonly and yolo without prompting", async () => {
    const readonly = createApprover(() => "readonly");
    let prompted = false;
    readonly.setPrompt(async () => {
      prompted = true;
      return "y";
    });
    expect(await readonly("bash", { command: "echo hi" })).toBe(false);
    expect(prompted).toBe(false);

    const yolo = createApprover(() => "yolo");
    yolo.setPrompt(async () => "n");
    expect(await yolo("bash", { command: "echo hi" })).toBe(true);
  });
});

describe("TUI approval does not wedge the run", () => {
  it("answers a pending approval instead of hanging on the first mutating tool", async () => {
    const { startTuiHost } = await import("../src/tui/host.js");
    let call = 0;
    const model = new MockLanguageModelV4({
      doStream: async () => {
        const index = call++;
        return {
          stream:
            index < 2
              ? bashStream(`c${index}`)
              : simulateReadableStream<LanguageModelV4StreamPart>({
                  chunkDelayInMs: 0,
                  chunks: [
                    { type: "text-start", id: "t" },
                    { type: "text-delta", id: "t", delta: "done" },
                    { type: "text-end", id: "t" },
                    { type: "finish", finishReason: finishReason("stop"), usage: v4Usage({ input: 5, output: 1 }) },
                  ],
                }),
        };
      },
    });

    const approve = createApprover(() => "ask");
    const terminal = new FakeTerminal();
    const { createCodingTools } = await import("not-another-harness");
    const { createNodeEnvironment } = await import("not-another-harness/node");
    const workspace = await mkdtemp(nodePath.join(tmpdir(), "nah-approval-"));
    const env = createNodeEnvironment(workspace);
    const tools = createCodingTools(env, { approveToolCall: approve });
    const state = {
      messages: [],
      system: "s",
      cwd: workspace,
      tools,
      workspace: env,
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
      permissions: "ask",
      setApprovalPrompt: (p: never) => approve.setPrompt(p),
    } as unknown as SessionState;

    const host = startTuiHost({ state, terminal });
    await sleep(30);
    terminal.type("run echo");
    terminal.onInput?.("\r");

    /**
     * Answer every approval the way a user would, and require the run to finish.
     *
     * Polls on a deadline rather than a fixed number of iterations. The original
     * budget was 40 iterations of 50ms, which was chosen when the SDK loaded in
     * milliseconds; on v7 the module graph is several times larger and first-token
     * latency is correspondingly slower, so the same budget intermittently expired
     * before the run had produced a frame to answer. A fixed iteration count is a
     * guess about someone else's load time, and it fails on the slow machine, not
     * the fast one.
     *
     * Only re-answers while the question is still on screen, so two approvals in
     * one turn each get a keystroke — the model calls `bash` twice before it
     * writes its final message.
     */
    let sawPrompt = false;
    let answered = 0;
    const deadline = Date.now() + 15_000;
    while (state.turns === 0 && Date.now() < deadline) {
      await sleep(25);
      const frame = strip(terminal.written.split("\u001b[?2026h").slice(-1)[0] ?? "");
      if (frame.includes("always this tool")) {
        sawPrompt = true;
        // The prompt stays on screen until the run moves on, so count how many
        // are outstanding rather than typing into a question already answered.
        if (answered < countPrompts(frame)) {
          answered += 1;
          terminal.type("y");
          terminal.onInput?.("\r");
          await sleep(50);
        }
      }
    }

    // The question must be rendered inside the TUI, not on a readline prompt
    // that the TUI would paint over and never receive an answer for.
    expect(sawPrompt).toBe(true);
    expect(state.turns).toBeGreaterThan(0);
    expect(await rm(workspace, { recursive: true, force: true }).then(() => true)).toBe(true);


    terminal.onInput?.("\x03");
    await host;
  }, 20000);
});

describe("approval prompt surface", () => {
  const FILL = "48;5;94";

  it("covers every row of the panel and none after it", () => {
    const out = new TurnOutput(60);
    out.addApproval("  ! bash npm test — allow? [y / n / a=always this tool / A=always this exact call]");
    out.addLine("after the prompt");
    const lines = out.render(60);
    const filled = lines.filter((l) => l.includes(FILL));
    expect(filled.length).toBeGreaterThan(0);
    // Every row that opens the fill must close it, or the fill bleeds downward.
    for (const line of filled) expect(line.endsWith("\u001b[0m")).toBe(true);
    // The block after the panel is untouched. This is the documented failure:
    // the row is padded to the pane width and then clamped to the terminal width,
    // so an escape applied to an ordinary line gets cut and the band runs on.
    for (const line of lines.slice(lines.findIndex((l) => l.includes("after the prompt")))) {
      expect(line).not.toContain(FILL);
    }
  });

  it("terminates every escape at a narrow width with a long label", () => {
    const out = new TurnOutput(24);
    out.addApproval(`  ! bash ${"x".repeat(200)} — allow? [y / n / a=always this tool]`);
    const lines = out.render(24);
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      if (line.includes(FILL)) expect(line.endsWith("\u001b[0m")).toBe(true);
    }
  });

  it("carries no nested escape of its own", () => {
    // A nested SGR inside a padded row is what makes the row longer in bytes than
    // in columns, which is how the closing escape gets clipped. The fill must
    // arrive only through the background function.
    const out = new TurnOutput(60);
    out.addApproval("  ! bash npm test — allow? [y / n]");
    const row = out.render(60).find((l) => l.includes(FILL))!;
    const inner = row.slice(row.indexOf("\u001b[") + 2, row.lastIndexOf("\u001b["));
    expect(inner).not.toContain("\u001b[");
  });

  it("does not tint the marker glyph the same colour as the surface", () => {
    // `c.yellow` on an amber fill is the one pairing guaranteed to be invisible,
    // so the marker is dropped in favour of the surface carrying the emphasis.
    const out = new TurnOutput(80);
    out.addApproval("  ! bash rm -rf /tmp/x — allow? [y / n]");
    const row = out.render(80).find((l) => l.includes(FILL))!;
    expect(row).not.toContain("\u001b[33m");
  });
});
