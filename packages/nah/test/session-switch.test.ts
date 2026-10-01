import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as nodePath from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { simulateReadableStream } from "ai";
import { MockLanguageModelV2 } from "ai/test";
import type { LanguageModelV2StreamPart } from "@ai-sdk/provider";
import type { Terminal } from "@earendil-works/pi-tui";
import { createJsonlSessionStore } from "@astracollab/not-another-harness";

import { handleSlashCommand } from "../src/repl.js";
import { TurnOutput } from "../src/tui/output.js";
import type { SessionState } from "../src/session.js";

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

const textStream = (text: string) =>
  simulateReadableStream<LanguageModelV2StreamPart>({
    chunkDelayInMs: 0,
    chunks: [
      { type: "text-start", id: "t" },
      { type: "text-delta", id: "t", delta: text },
      { type: "text-end", id: "t" },
      { type: "finish", finishReason: "stop", usage: { inputTokens: 3, outputTokens: 1, totalTokens: 4 } },
    ],
  });

describe("/session <id>", () => {
  let home: string;
  let realHome: string | undefined;
  let cwd: string;
  let out: string[];

  beforeEach(async () => {
    realHome = process.env.HOME;
    home = await mkdtemp(nodePath.join(tmpdir(), "nah-sess-"));
    process.env.HOME = home;
    cwd = await mkdtemp(nodePath.join(tmpdir(), "nah-proj-"));
    out = [];
  });

  afterEach(async () => {
    if (realHome === undefined) delete process.env.HOME;
    else process.env.HOME = realHome;
    await rm(home, { recursive: true, force: true });
    await rm(cwd, { recursive: true, force: true });
  });

  /** Writes two sibling sessions and returns the state pointing at the second. */
  const seedTwoSessions = async (): Promise<SessionState> => {
    const { defaultSessionFile } = await import("../src/context.js");
    const first = defaultSessionFile(cwd);
    const second = `${first.replace(/\.jsonl$/, "-2.jsonl")}`;
    await createJsonlSessionStore(first).append([
      { role: "user", content: "session one question" },
      { role: "assistant", content: "session one answer" },
    ]);
    await createJsonlSessionStore(second).append([{ role: "user", content: "session two question" }]);

    return {
      messages: [],
      system: "s",
      cwd,
      tools: {},
      workspace: {},
      activeFileChanges: null,
      activeShellCommands: null,
      undoHistory: [{ steps: [], changes: [], messages: [], ledgerBefore: null }],
      sessionBasePath: second,
      taskLedger: null,
      discoveredChecks: [],
      store: createJsonlSessionStore(second),
      model: null,
      providerStatus: null,
      totalUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      contextUsedTokens: 0,
      contextUsageEstimated: false,
      lastOutputTokens: 0,
      turns: 0,
      permissions: "yolo",
    } as unknown as SessionState;
  };

  const run = (state: SessionState, input: string) =>
    handleSlashCommand(input, state, cwd, {
      write: (chunk: string) => {
        out.push(chunk);
        return true;
      },
    } as never);

  it("switches to another session and restores its messages", async () => {
    const state = await seedTwoSessions();
    const { defaultSessionFile } = await import("../src/context.js");
    const first = defaultSessionFile(cwd);

    expect(await run(state, `/session ${nodePath.basename(first, ".jsonl")}`)).toBe("handled");

    expect(state.messages).toEqual([
      { role: "user", content: "session one question" },
      { role: "assistant", content: "session one answer" },
    ]);
    expect(state.store?.path).toBe(first);
    expect(out.join("")).toContain("switched");
    expect(out.join("")).toContain("2 messages restored");
  });

  it("notifies the host so the transcript pane is rebuilt", async () => {
    const state = await seedTwoSessions();
    const { defaultSessionFile } = await import("../src/context.js");
    let notified = 0;
    state.onSessionSwitch = () => {
      notified += 1;
    };

    await run(state, `/session ${nodePath.basename(defaultSessionFile(cwd), ".jsonl")}`);
    expect(notified).toBe(1);
  });

  it("clears undo history, which no longer describes this transcript", async () => {
    const state = await seedTwoSessions();
    const { defaultSessionFile } = await import("../src/context.js");
    await run(state, `/session ${nodePath.basename(defaultSessionFile(cwd), ".jsonl")}`);
    expect(state.undoHistory).toEqual([]);
  });

  it("reports a typo and lists what does exist, instead of opening nothing", async () => {
    const state = await seedTwoSessions();
    await run(state, "/session nope");
    const text = out.join("");
    expect(text).toContain('no session "nope"');
    expect(text).toContain("sessions here:");
    // Nothing was switched.
    expect(state.messages).toEqual([]);
  });

  it("accepts a switch after persistence was turned off", async () => {
    const state = await seedTwoSessions();
    await run(state, "/session off");
    expect(state.store).toBeNull();

    const { defaultSessionFile } = await import("../src/context.js");
    await run(state, `/session ${nodePath.basename(defaultSessionFile(cwd), ".jsonl")}`);
    expect(state.store).not.toBeNull();
    expect(state.messages).toHaveLength(2);
  });

  it("treats a bare /session as a listing", async () => {
    const state = await seedTwoSessions();
    await run(state, "/session");
    expect(out.join("")).toContain("Sessions for this directory");
  });
});

describe("TurnOutput.reset", () => {
  it("clears rendered blocks so a new session can be seeded", () => {
    const output = new TurnOutput();
    output.seedHistory([{ role: "user", content: "first session" }]);
    expect(output.blockCount).toBeGreaterThan(0);

    output.reset();
    expect(output.blockCount).toBe(0);
    expect(strip(output.render(80).join("\n"))).toBe("");

    output.seedHistory([{ role: "user", content: "second session" }]);
    const text = strip(output.render(80).join("\n"));
    expect(text).toContain("second session");
    expect(text).not.toContain("first session");
  });
});