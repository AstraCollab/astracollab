import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as nodePath from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { simulateReadableStream } from "ai";
import { MockLanguageModelV2 } from "ai/test";
import type { LanguageModelV2StreamPart } from "@ai-sdk/provider";

import { allocateSessionFile, defaultSessionFile, latestSessionFile, resolveSessionFile } from "../src/context.js";
import { TurnOutput } from "../src/tui/output.js";
import type { SessionState } from "../src/session.js";
import { createJsonlSessionStore } from "@astracollab/not-another-harness";

const strip = (s: string) =>
  s.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "").replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, "");

const realHome = process.env.HOME;
let root: string;

beforeAll(async () => {
  root = await mkdtemp(nodePath.join(tmpdir(), "nah-session-"));
  const home = nodePath.join(root, "home");
  await mkdir(nodePath.join(home, ".nah", "sessions"), { recursive: true });
  process.env.HOME = home;
});

afterAll(async () => {
  if (realHome === undefined) delete process.env.HOME;
  else process.env.HOME = realHome;
  await rm(root, { recursive: true, force: true });
});

let cwdCounter = 0;
const freshCwd = async (): Promise<string> => {
  cwdCounter += 1;
  const dir = nodePath.join(root, `proj-${cwdCounter}`);
  await mkdir(dir, { recursive: true });
  return dir;
};

describe("session file allocation", () => {
  it("uses the default file for the first run in a directory", async () => {
    const cwd = await freshCwd();
    expect(await allocateSessionFile(cwd)).toBe(defaultSessionFile(cwd));
  });

  it("allocates a new file once the default one has content", async () => {
    const cwd = await freshCwd();
    const first = await allocateSessionFile(cwd);
    await createJsonlSessionStore(first).append([{ role: "user", content: "run one" }]);

    const second = await allocateSessionFile(cwd);
    expect(second).not.toBe(first);
    expect(nodePath.basename(second)).toMatch(/-2\.jsonl$/);
  });

  it("never reuses an existing id across several runs", async () => {
    const cwd = await freshCwd();
    const seen = new Set<string>();
    for (let i = 0; i < 4; i += 1) {
      const file = await allocateSessionFile(cwd);
      expect(seen.has(file)).toBe(false);
      seen.add(file);
      await createJsonlSessionStore(file).append([{ role: "user", content: `run ${i}` }]);
    }
    expect(seen.size).toBe(4);
  });

  it("keeps a new run from chaining onto the previous run's tail", async () => {
    const cwd = await freshCwd();
    const run1 = await allocateSessionFile(cwd);
    const s1 = createJsonlSessionStore(run1);
    await s1.append([
      { role: "user", content: "run one" },
      { role: "assistant", content: "reply one" },
    ]);

    const run2 = await allocateSessionFile(cwd);
    expect(run2).not.toBe(run1);
    await createJsonlSessionStore(run2).append([{ role: "user", content: "run two" }]);

    // The new session sees only its own message...
    expect(await createJsonlSessionStore(run2).load()).toEqual([{ role: "user", content: "run two" }]);
    // ...and the old session is still intact and reachable by id.
    expect(await createJsonlSessionStore(run1).load()).toEqual([
      { role: "user", content: "run one" },
      { role: "assistant", content: "reply one" },
    ]);
  });

  it("--continue resolves to the most recent session", async () => {
    const cwd = await freshCwd();
    const run1 = await allocateSessionFile(cwd);
    await createJsonlSessionStore(run1).append([{ role: "user", content: "one" }]);
    // Make run1 unambiguously the older file.
    const older = new Date(Date.now() - 60_000);
    const { utimes } = await import("node:fs/promises");
    await utimes(run1, older, older);

    const run2 = await allocateSessionFile(cwd);
    await createJsonlSessionStore(run2).append([{ role: "user", content: "two" }]);

    expect(await latestSessionFile(cwd)).toBe(run2);
  });

  it("--session <id> still loads exactly that session", async () => {
    const cwd = await freshCwd();
    const run1 = await allocateSessionFile(cwd);
    await createJsonlSessionStore(run1).append([
      { role: "user", content: "first question" },
      { role: "assistant", content: "first answer" },
    ]);
    await allocateSessionFile(cwd); // a later run exists

    const id = nodePath.basename(run1, ".jsonl");
    const resolved = resolveSessionFile(cwd, id);
    expect(resolved).toBe(run1);
    expect(await createJsonlSessionStore(resolved).load()).toEqual([
      { role: "user", content: "first question" },
      { role: "assistant", content: "first answer" },
    ]);
  });
});

describe("resumed transcript is visible", () => {
  it("renders prior turns instead of starting blank", () => {
    const output = new TurnOutput();
    output.seedHistory([
      { role: "user", content: "add a docs section" },
      { role: "assistant", content: "Added it." },
    ]);
    const text = strip(output.render(90).join("\n"));
    expect(text).toContain("add a docs section");
    expect(text).toContain("Added it.");
    expect(text).toContain("resumed 2 earlier messages");
  });

  it("replays restored tool calls and their results", () => {
    const output = new TurnOutput();
    output.seedHistory([
      {
        role: "assistant",
        content: [
          { type: "tool-call", toolCallId: "a", toolName: "read", input: { path: "src/app.ts" } },
          { type: "text", text: "Found it." },
        ],
      },
      {
        role: "tool",
        content: [
          { type: "tool-result", toolCallId: "a", toolName: "read", output: { type: "text", value: "…" } },
          { type: "tool-result", toolCallId: "b", toolName: "write", output: { type: "text", value: "wrote packages/nah/src/x.ts" } },
        ],
      },
    ]);
    const text = strip(output.render(90).join("\n"));
    // The call and its result are the substance of a coding transcript. The
    // previous renderer counted the calls and dropped the lines, which is what
    // made a resumed session look truncated.
    expect(text).toContain("◆ read src/app.ts");
    expect(text).toContain("Found it.");
    expect(text).toContain("wrote packages/nah/src/x.ts");
    expect(text).toContain("1 tool calls");
  });

  it("shows reasoning instead of dropping it", () => {
    const output = new TurnOutput();
    output.seedHistory([
      {
        role: "assistant",
        content: [
          { type: "reasoning", text: "The workspace root is elsewhere, so the path is absolute." },
          { type: "text", text: "Mapped it." },
        ],
      },
    ]);
    const text = strip(output.render(90).join("\n"));
    expect(text).toContain("The workspace root is elsewhere");
    expect(text).toContain("Mapped it.");
  });

  it("renders a user message that carried a file attachment", () => {
    const output = new TurnOutput();
    output.seedHistory([
      {
        role: "user",
        content: [
          { type: "text", text: "explain this" },
          { type: "file", data: "…", mediaType: "text/plain" },
        ],
      },
    ]);
    const text = strip(output.render(90).join("\n"));
    expect(text).toContain("explain this");
    expect(text).toContain("+1 file");
  });

  it("does nothing for an empty transcript", () => {
    const output = new TurnOutput();
    output.seedHistory([]);
    expect(output.blockCount).toBe(0);
  });
});

describe("end-to-end resume through the host", () => {
  beforeEach(() => {
    cwdCounter += 1;
  });

  it("restores the counters a previous run recorded, not zeroes", async () => {
    const { resumeSession } = await import("../src/session.js");
    const cwd = await freshCwd();
    const file = defaultSessionFile(cwd);
    const store = createJsonlSessionStore(file);
    await store.append([
      { role: "user", content: "what changed in the session store?" },
      { role: "assistant", content: "usage records are now appended per turn" },
    ]);
    await store.saveUsage({
      turns: 6,
      inputTokens: 371_689,
      outputTokens: 0,
      totalTokens: 371_689,
      contextUsedTokens: 120_000,
      contextUsageEstimated: false,
      lastOutputTokens: 900,
    });

    const state = { store: createJsonlSessionStore(file) } as SessionState;
    expect(await resumeSession(state)).toBe(true);

    expect(state.messages).toHaveLength(2);
    expect(state.turns).toBe(6);
    expect(state.totalUsage.totalTokens).toBe(371_689);
    expect(state.contextUsedTokens).toBe(120_000);
  });

  it("reports zeroes for a session written before usage was recorded", async () => {
    const { resumeSession } = await import("../src/session.js");
    const cwd = await freshCwd();
    const file = defaultSessionFile(cwd);
    await createJsonlSessionStore(file).append([{ role: "user", content: "older session" }]);

    const state = { store: createJsonlSessionStore(file) } as SessionState;
    await resumeSession(state);

    expect(state.turns).toBe(0);
    expect(state.totalUsage).toEqual({ inputTokens: 0, outputTokens: 0, totalTokens: 0 });
  });

  it("shows resumed messages in the pane", async () => {
    const { startTuiHost } = await import("../src/tui/host.js");
    const cwd = await freshCwd();
    const file = defaultSessionFile(cwd);
    await createJsonlSessionStore(file).append([
      { role: "user", content: "remember this detail" },
      { role: "assistant", content: "noted" },
    ]);

    class FakeTerminal {
      written = "";
      kittyProtocolActive = false;
      constructor(
        public columns = 80,
        public rows = 24,
      ) {}
      start(onInput: (d: string) => void) {
        this.onInput = onInput;
      }
      onInput: ((d: string) => void) | null = null;
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
    }

    const terminal = new FakeTerminal();
    const state = {
      messages: await createJsonlSessionStore(file).load(),
      system: "s",
      cwd,
      tools: {},
      workspace: {},
      activeFileChanges: null,
      activeShellCommands: null,
      undoHistory: [],
      sessionBasePath: file,
      taskLedger: null,
      discoveredChecks: [],
      store: createJsonlSessionStore(file),
      model: { spec: "test:model" },
      providerStatus: null,
      totalUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      contextUsedTokens: 0,
      contextUsageEstimated: false,
      lastOutputTokens: 0,
      turns: 0,
      permissions: "yolo",
    } as unknown as SessionState;

    const host = startTuiHost({ state, terminal });
    await new Promise((resolve) => setTimeout(resolve, 60));

    const frames = terminal.written.split("\u001b[?2026h");
    const frame = strip(frames[frames.length - 1] ?? "");
    expect(frame).toContain("remember this detail");
    expect(frame).toContain("noted");

    terminal.onInput?.("\x03");
    await host;
  });

  it("restores tool calls and reasoning into the pane, not just prose", async () => {
    const { startTuiHost } = await import("../src/tui/host.js");
    const cwd = await freshCwd();
    const file = defaultSessionFile(cwd);
    await createJsonlSessionStore(file).append([
      { role: "user", content: "where is the session store?" },
      {
        role: "assistant",
        content: [
          { type: "reasoning", text: "The store lives in the harness package." },
          { type: "tool-call", toolCallId: "c1", toolName: "read", input: { path: "src/session.ts" } },
          { type: "text", text: "Found it." },
        ],
      },
      {
        role: "tool",
        content: [
          { type: "tool-result", toolCallId: "c1", toolName: "write", output: { type: "text", value: "wrote src/session.ts" } },
        ],
      },
    ]);

    class FakeTerminal {
      written = "";
      kittyProtocolActive = false;
      constructor(
        public columns = 80,
        public rows = 24,
      ) {}
      start(onInput: (d: string) => void) {
        this.onInput = onInput;
      }
      onInput: ((d: string) => void) | null = null;
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
    }

    const terminal = new FakeTerminal();
    const state = {
      messages: await createJsonlSessionStore(file).load(),
      system: "s",
      cwd,
      tools: {},
      workspace: {},
      activeFileChanges: null,
      activeShellCommands: null,
      undoHistory: [],
      sessionBasePath: file,
      taskLedger: null,
      discoveredChecks: [],
      store: createJsonlSessionStore(file),
      model: { spec: "test:model" },
      providerStatus: null,
      totalUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      contextUsedTokens: 0,
      contextUsageEstimated: false,
      lastOutputTokens: 0,
      turns: 0,
      permissions: "yolo",
    } as unknown as SessionState;

    const host = startTuiHost({ state, terminal });
    await new Promise((resolve) => setTimeout(resolve, 60));

    const frames = terminal.written.split("\u001b[?2026h");
    const frame = strip(frames[frames.length - 1] ?? "");
    expect(frame).toContain("where is the session store?");
    expect(frame).toContain("The store lives in the harness package");
    expect(frame).toContain("◆ read src/session.ts");
    expect(frame).toContain("wrote src/session.ts");
    expect(frame).toContain("Found it.");

    terminal.onInput?.("\x03");
    await host;
  });
});
