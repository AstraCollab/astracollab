import { describe, expect, it } from "vitest";
import { simulateReadableStream } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import type { LanguageModelV4StreamPart } from "@ai-sdk/provider";
import type { Terminal } from "@earendil-works/pi-tui";

import { TurnOutput } from "../src/tui/output.js";
import { ContextSidebar, formatSidebar, formatTokens, type SidebarData } from "../src/tui/sidebar.js";
import { stripAnsi } from "../src/render.js";
import type { SessionState } from "../src/session.js";
import { finishReason, v4Usage } from "./helpers/ai.js";

const strip = (value: string): string => stripAnsi(value).replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "");

const textStream = (text: string) =>
  simulateReadableStream<LanguageModelV4StreamPart>({
    chunkDelayInMs: 0,
    chunks: [
      { type: "text-start", id: "t" },
      { type: "text-delta", id: "t", delta: text },
      { type: "text-end", id: "t" },
      { type: "finish", finishReason: finishReason("stop"), usage: v4Usage({ input: 1, output: 1 }) },
    ],
  });

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
    model: { model, spec: "test:model", provider: "openrouter", modelId: "test/model" },
    providerStatus: null,
    totalUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    contextUsedTokens: 0,
    contextUsageEstimated: false,
    lastOutputTokens: 0,
    turns: 0,
    permissions: "yolo",
  }) as unknown as SessionState;

const lastFrame = (terminal: FakeTerminal): string => {
  const frames = terminal.written.split("\u001b[?2026h");
  return strip(frames[frames.length - 1] ?? "");
};

const waitFor = async (predicate: () => boolean, timeoutMs = 10_000): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return predicate();
};

const DATA: SidebarData = {
  sessionId: "a1b2c3d4e5f6",
  cwd: "/Users/elias/Documents/Code/astracollab/astracollab-packages",
  modelProvider: "openrouter",
  modelId: "stealth/space-bunny-alpha",
  contextUsedTokens: 12_400,
  contextEstimated: true,
  inputTokens: 84_200,
  outputTokens: 3_100,
  totalTokens: 87_300,
  cacheReadTokens: 1_840_000,
  cacheWriteTokens: 40_000,
  cacheHitRate: 0.94,
  spendUsd: 0.61,
  spendLimitUsd: null,
  turns: 12,
  permissions: "yolo",
  providerStatus: null,
  undoDepth: 2,
  planSteps: 4,
  workspaceRoot: null,
};

describe("workspace root", () => {
  const at = (over: Partial<SidebarData>) => strip(formatSidebar({ ...DATA, ...over }, 60).join("\n"));

  it("shows the root when it differs from the working directory", () => {
    // In a monorepo the root is usually one level up. An agent refused a sibling
    // package should be able to see why without having to ask.
    expect(at({ workspaceRoot: "/Users/x/repo" })).toContain("root …/x/repo");
  });

  it("stays quiet when the root is the working directory", () => {
    expect(at({ workspaceRoot: null })).not.toContain("root");
  });
});

describe("cache hit rate", () => {
  const at = (over: Partial<SidebarData>) => strip(formatSidebar({ ...DATA, ...over }, 60).join("\n"));

  it("shows the rate once there is enough input for it to mean anything", () => {
    expect(at({})).toContain("94% cached");
  });

  it("stays quiet on turn one, where the rate is legitimately zero", () => {
    // The first request of a run is nearly all cache *write*. Rendering "0%" in
    // red before any read is possible would be a false alarm.
    expect(at({ cacheHitRate: 0, cacheReadTokens: 0, inputTokens: 1_500 })).not.toContain("cached");
  });

  it("stays quiet below the volume threshold", () => {
    expect(
      at({ cacheHitRate: 0.5, cacheReadTokens: 100, cacheWriteTokens: 0, inputTokens: 100 }),
    ).not.toContain("cached");
  });

  it("surfaces a healthy rate plainly", () => {
    expect(at({ cacheHitRate: 0.94 })).toContain("94% cached");
  });

  it("shows a poor rate too — that is the whole point of the readout", () => {
    // Below ~80% the run rewrites its prefix rather than reading it back, costing
    // roughly 10x per step. Nothing else on this panel reveals that.
    expect(at({ cacheHitRate: 0.12 })).toContain("12% cached");
  });

  it("does not crash when the cache counters are missing", () => {
    // The panel renders every frame and these come from a session file that may
    // predate the fields. A NaN here would throw inside the render loop.
    const broken = strip(
      formatSidebar(
        {
          ...DATA,
          cacheReadTokens: undefined as unknown as number,
          cacheWriteTokens: undefined as unknown as number,
          cacheHitRate: Number.NaN,
          spendUsd: undefined as unknown as number,
        },
        60,
      ).join("\n"),
    );
    expect(broken).toContain("12.4k used");
    expect(broken).not.toContain("NaN");
  });
});

describe("spend", () => {
  const at = (over: Partial<SidebarData>) => strip(formatSidebar({ ...DATA, ...over }, 60).join("\n"));

  it("shows spend alone when there is no ceiling, which is the normal state", () => {
    // `$1.99 / $2.00` implied a limit that could end the turn, and on a run that
    // went long it read as "nearly out of budget" rather than "this is what the
    // work has cost".
    expect(at({ spendLimitUsd: null })).toContain("$0.610 spent");
  });

  it("names the ceiling when the user set one, so it is not mistaken for progress", () => {
    expect(at({ spendLimitUsd: 2 })).toContain("$0.610 / $2.00 ceiling");
  });

  it("does not invent a ceiling from the spend figure", () => {
    // The old code derived one from context every frame, so a panel could show a
    // denominator the run was never subject to.
    const moneyRow = at({ spendLimitUsd: null })
      .split("\n")
      .find((line) => line.includes("spent"));
    expect(moneyRow).toBe("$0.610 spent");
  });

  it("keeps three decimals, because a cheap turn must not read as zero", () => {
    expect(at({ spendUsd: 0.0824 })).toContain("$0.082");
  });
});

describe("formatSidebar", () => {
  const text = (data: Partial<SidebarData> = {}) =>
    stripAnsi(formatSidebar({ ...DATA, ...data }, 28).join("\n"));

  it("puts the session id first", () => {
    const lines = formatSidebar(DATA, 28).map(stripAnsi);
    expect(lines[0]?.toLowerCase()).toBe("session");
    expect(lines[1]).toBe("a1b2c3d4e5f6");
  });

  it("shows the context and token figures", () => {
    const rendered = text();
    expect(rendered).toContain("~12.4k used");
    expect(rendered).toContain("↑84.2k in");
    expect(rendered).toContain("↓3.1k out");
    expect(rendered).toContain("87.3k total");
  });

  it("omits the estimate marker when the figure was reported", () => {
    expect(text({ contextEstimated: false })).toContain("12.4k used");
    expect(text({ contextEstimated: false })).not.toContain("~12.4k used");
  });

  it("keeps every line inside the width it was given", () => {
    for (const line of formatSidebar({ ...DATA, modelId: "x".repeat(80) }, 20)) {
      expect(stripAnsi(line).length).toBeLessThanOrEqual(20);
    }
  });

  it("shortens a deep path but keeps the tail visible", () => {
    const wide = stripAnsi(formatSidebar(DATA, 40).join("\n"));
    // The full path is far longer than any sidebar; the last two segments are
    // what identify the working directory at a glance.
    expect(wide).toContain("…/astracollab/astracollab-packages");
    expect(wide).not.toContain("/Users/elias");
  });

  it("shows plan and undo state only when there is any", () => {
    expect(text()).toContain("plan 4 steps");
    expect(text()).toContain("2 undoable");
    expect(text({ planSteps: null, undoDepth: 0 })).not.toContain("plan");
    expect(text({ planSteps: null, undoDepth: 0 })).not.toContain("undoable");
  });

  it("surfaces a transient provider message", () => {
    expect(text({ providerStatus: "anthropic retry 1…" })).toContain("anthropic retry 1");
  });
});

describe("formatTokens", () => {
  it("abbreviates like the status line does", () => {
    expect(formatTokens(0)).toBe("0");
    expect(formatTokens(999)).toBe("999");
    expect(formatTokens(1_500)).toBe("1.5k");
    expect(formatTokens(2_400_000)).toBe("2.4m");
  });
});

describe("the sidebar inside the real TUI", () => {
  it("sits beside the transcript on a wide terminal and is dropped on a narrow one", async () => {
    const { startTuiHost } = await import("../src/tui/host.js");
    const model = new MockLanguageModelV4({
      doStream: async () => ({ stream: textStream("done") }),
    });

    const wide = new FakeTerminal(120, 30);
    const state = makeState(model);
    state.sessionBasePath = "/tmp/sessions/a1b2c3d4e5f6.jsonl";
    state.contextUsedTokens = 12_400;
    state.contextUsageEstimated = true;
    state.totalUsage = { inputTokens: 84_200, outputTokens: 3_100, totalTokens: 87_300 };
    state.turns = 12;
    const host = startTuiHost({ state, terminal: wide });
    await waitFor(() => lastFrame(wide).length > 0);

    const frame = strip(lastFrame(wide));
    // The panel's own fields reached the screen alongside the editor.
    expect(frame).toContain("a1b2c3d4e5f6");
    expect(frame).toContain("12.4k used");
    expect(frame).toContain("12 turns");
    wide.onInput?.("\x03");
    await host;

    const narrow = new FakeTerminal(80, 30);
    const host2 = startTuiHost({ state: makeState(model), terminal: narrow });
    await waitFor(() => lastFrame(narrow).length > 0);
    // 80 columns cannot carry a panel, so the transcript keeps the whole width.
    expect(strip(lastFrame(narrow))).not.toContain("12.4k used");
    narrow.onInput?.("\x03");
    await host2;
  });
});
