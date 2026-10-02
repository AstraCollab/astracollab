import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as nodePath from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { simulateReadableStream } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import type { LanguageModelV4StreamPart } from "@ai-sdk/provider";
import type { Terminal } from "@earendil-works/pi-tui";
import { createJsonlSessionStore } from "@astracollab/not-another-harness";

import { handleSlashCommand } from "../src/repl.js";
import { TurnOutput } from "../src/tui/output.js";
import type { SessionState } from "../src/session.js";
import { finishReason, v4Usage } from "./helpers/ai.js";

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
  simulateReadableStream<LanguageModelV4StreamPart>({
    chunkDelayInMs: 0,
    chunks: [
      { type: "text-start", id: "t" },
      { type: "text-delta", id: "t", delta: text },
      { type: "text-end", id: "t" },
      { type: "finish", finishReason: finishReason("stop"), usage: v4Usage({ input: 3, output: 1 }) },
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
    expect(strip(out.join(""))).toContain("switched");
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

  it("zeroes the counters on /clear, which discards the transcript", async () => {
    const state = await seedTwoSessions();
    state.turns = 7;
    state.totalUsage = { inputTokens: 3000, outputTokens: 400, totalTokens: 3400 };
    state.contextUsedTokens = 3000;

    await run(state, "/clear");

    expect(state.messages).toEqual([]);
    expect(state.turns).toBe(0);
    expect(state.totalUsage).toEqual({ inputTokens: 0, outputTokens: 0, totalTokens: 0 });
    expect(state.contextUsedTokens).toBe(0);
  });

  it("carries the switched-to session's counters, not the previous one's", async () => {
    const state = await seedTwoSessions();
    const { defaultSessionFile } = await import("../src/context.js");
    const first = defaultSessionFile(cwd);
    // The session being left has spend; the one being opened has none. Keeping
    // the old totals made /stats describe a transcript that was gone.
    state.turns = 9;
    state.totalUsage = { inputTokens: 5000, outputTokens: 900, totalTokens: 5900 };

    await run(state, `/session ${nodePath.basename(first, ".jsonl")}`);

    expect(state.turns).toBe(0);
    expect(state.totalUsage).toEqual({ inputTokens: 0, outputTokens: 0, totalTokens: 0 });
  });

  it("adopts the counters recorded for the session it opens", async () => {
    const state = await seedTwoSessions();
    const { defaultSessionFile } = await import("../src/context.js");
    const second = `${defaultSessionFile(cwd).replace(/\.jsonl$/, "-2.jsonl")}`;
    await createJsonlSessionStore(second).saveUsage({
      turns: 3,
      inputTokens: 4100,
      outputTokens: 700,
      totalTokens: 4800,
      contextUsedTokens: 4100,
      contextUsageEstimated: false,
      lastOutputTokens: 120,
    });
    state.turns = 9;
    state.totalUsage = { inputTokens: 5000, outputTokens: 900, totalTokens: 5900 };

    await run(state, `/session ${nodePath.basename(second, ".jsonl")}`);

    expect(state.turns).toBe(3);
    expect(state.totalUsage).toEqual({ inputTokens: 4100, outputTokens: 700, totalTokens: 4800 });
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
describe("/branch", () => {
  let home: string;
  let realHome: string | undefined;
  let cwd: string;
  let out: string[];

  beforeEach(async () => {
    realHome = process.env.HOME;
    home = await mkdtemp(nodePath.join(tmpdir(), "nah-branch-"));
    process.env.HOME = home;
    cwd = await mkdtemp(nodePath.join(tmpdir(), "nah-bproj-"));
    out = [];
  });

  afterEach(async () => {
    if (realHome === undefined) delete process.env.HOME;
    else process.env.HOME = realHome;
    await rm(home, { recursive: true, force: true });
    await rm(cwd, { recursive: true, force: true });
  });

  const seeded = async (): Promise<SessionState> => {
    const { defaultSessionFile } = await import("../src/context.js");
    const base = defaultSessionFile(cwd);
    await createJsonlSessionStore(base).append([
      { role: "user", content: "original question" },
      { role: "assistant", content: "original answer" },
    ]);
    return {
      messages: [],
      system: "s",
      cwd,
      tools: {},
      workspace: {},
      activeFileChanges: null,
      activeShellCommands: null,
      undoHistory: [],
      sessionBasePath: base,
      taskLedger: null,
      discoveredChecks: [],
      store: createJsonlSessionStore(base),
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

  it("forks a named branch and says it created one", async () => {
    const state = await seeded();
    expect(await run(state, "/branch work")).toBe("handled");
    expect(strip(out.join(""))).toContain("created branch work");
    expect(strip(out.join(""))).toContain("/branch main returns you");
    expect(state.store?.path).toContain(".work.jsonl");
  });

  it("a forked branch starts from the parent's counters, not zero", async () => {
    const state = await seeded();
    state.turns = 4;
    state.totalUsage = { inputTokens: 2000, outputTokens: 500, totalTokens: 2500 };
    await state.store?.saveUsage({
      turns: 4,
      inputTokens: 2000,
      outputTokens: 500,
      totalTokens: 2500,
      contextUsedTokens: 2000,
      contextUsageEstimated: false,
      lastOutputTokens: 100,
    });

    await run(state, "/branch work");

    expect(state.turns).toBe(4);
    expect(state.totalUsage.totalTokens).toBe(2500);
  });

  it("switches back to main and restores its messages", async () => {
    const state = await seeded();
    await run(state, "/branch work");
    out.length = 0;
    let notified = 0;
    state.onSessionSwitch = () => {
      notified += 1;
    };

    expect(await run(state, "/branch main")).toBe("handled");
    expect(state.messages).toEqual([
      { role: "user", content: "original question" },
      { role: "assistant", content: "original answer" },
    ]);
    expect(strip(out.join(""))).toContain("switched");
    // The pane has to be rebuilt, or it still shows the branch transcript.
    expect(notified).toBe(1);
  });

  it("refreshes the pane when switching to an existing branch too", async () => {
    const state = await seeded();
    await run(state, "/branch work");
    out.length = 0;
    let notified = 0;
    state.onSessionSwitch = () => {
      notified += 1;
    };

    await run(state, "/branch work");
    expect(strip(out.join(""))).toContain("switched");
    expect(notified).toBe(1);
  });

  it("lists branches on a bare /branch, with sizes and the active one", async () => {
    const state = await seeded();
    await run(state, "/branch work");
    out.length = 0;

    await run(state, "/branch");
    const text = out.join("");
    expect(text).toContain("Branches");
    expect(text).toContain("main");
    expect(text).toContain("work");
    expect(text).toContain("msg");
    expect(text).toContain("active");
  });

  it("/branches and a bare /branch agree", async () => {
    const state = await seeded();
    await run(state, "/branch alpha");
    out.length = 0;
    await run(state, "/branch");
    const bare = out.join("");

    out.length = 0;
    await run(state, "/branches");
    expect(out.join("")).toBe(bare);
  });

  it("says so when persistence is off", async () => {
    const state = await seeded();
    state.store = null;
    state.sessionBasePath = null;
    await run(state, "/branches");
    expect(strip(out.join(""))).toContain("persistence is off");
  });
});
