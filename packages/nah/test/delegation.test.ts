import { describe, expect, it } from "vitest";

import { toolLabel } from "../src/render.js";
import { composeTurnRequest } from "../src/session.js";
import type { SessionState } from "../src/session.js";

const baseState = (over: Partial<SessionState> = {}): SessionState =>
  ({
    system: "base system",
    tools: {},
    messages: [],
    cwd: "/repo",
    workspace: null as never,
    activeFileChanges: null,
    activeShellCommands: null,
    undoHistory: [],
    sessionBasePath: null,
    taskLedger: null,
    discoveredChecks: [],
    store: null,
    model: null,
    providerStatus: null,
    totalUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    contextUsedTokens: 0,
    contextUsageEstimated: false,
    lastOutputTokens: 0,
    turns: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    cacheHitRate: 0,
    spendUsd: 0,
    permissions: "yolo",
    ...over,
  }) as unknown as SessionState;

/** Delegation is registered without a sandbox, so a tool map is enough to say so. */
const withDelegation = (extra: Record<string, unknown> = {}) =>
  baseState({ tools: { delegate_task: {}, ...extra } as unknown as SessionState["tools"] });

describe("the plan-to-sub-agents path is the one the model is told about", () => {
  it("points at the batch call, not just the single one", () => {
    // The gap this closes: a plan is several independent pieces, and delegating
    // them one call at a time means waiting for each child in turn — the fan-out
    // the orchestrator exists for would never happen on its own.
    const { system } = composeTurnRequest(withDelegation({ delegate_tasks: {} }), "implement the plan", "");
    expect(system).toContain("spin up sub-agents");
    expect(system).toContain("delegate_tasks");
    expect(system).toContain("delegate_task");
  });

  it("keeps the isolation constraints, and does not make them nah-local", () => {
    const { system } = composeTurnRequest(withDelegation(), "implement the plan", "");
    expect(system).toContain("committed");
    expect(system).toContain("merged automatically");
    expect(system).toContain("At most 3 children run at once");
  });

  it("tells the model to keep dependent work itself", () => {
    const { system } = composeTurnRequest(withDelegation(), "implement the plan", "");
    expect(system).toContain("depend on each other");
  });

  it("says nothing about delegation when the tools are not registered", () => {
    // A sandboxed session has no delegation tools, and telling the model about a
    // capability it cannot call is a plan it cannot follow.
    const { system } = composeTurnRequest(baseState(), "implement the plan", "");
    expect(system).not.toContain("delegate");
  });

  it("leaves the system half byte-identical across turns", () => {
    // The delegation guidance rides in the system prefix, so it has to be pure.
    const first = composeTurnRequest(withDelegation(), "one", "");
    const second = composeTurnRequest(withDelegation(), "two", "");
    expect(second.system).toBe(first.system);
  });
});

describe("a fan-out reads as one decision in the transcript", () => {
  it("leads with the count, because that is what the call was for", () => {
    const label = toolLabel("delegate_tasks", {
      tasks: [{ title: "extract parser" }, { title: "cover parser" }, { title: "rename export" }],
    });
    expect(label).toContain("delegate 3 subtasks in isolated worktrees");
    expect(label).toContain("extract parser");
  });

  it("does not crash on a malformed argument list", () => {
    expect(() => toolLabel("delegate_tasks", {})).not.toThrow();
    expect(() => toolLabel("delegate_tasks", { tasks: "nope" })).not.toThrow();
  });

  it("still labels a single delegation", () => {
    expect(toolLabel("delegate_task", { title: "extract parser" })).toBe("delegate in isolated worktree: extract parser");
  });
});