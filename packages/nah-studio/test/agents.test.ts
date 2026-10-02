/**
 * The agent registry, and what the dashboard is allowed to do with it.
 *
 * A monitoring view is only as trustworthy as its idea of "running", so most of
 * this is about status: what an agent says about itself, what is inferred when it
 * stops saying anything, and who is allowed to stop it.
 */
import { describe, expect, it } from "vitest";

import { StudioStore } from "../src/store.js";
import type { Span, Trace } from "../src/wire.js";

const store = (): StudioStore => new StudioStore({ path: ":memory:" });

const trace = (over: Partial<Trace> = {}): Trace => ({
  id: "t1",
  name: "do the thing",
  startTime: 1_000,
  endTime: 5_000,
  rootSpanId: "s1",
  status: "ok",
  tags: [],
  metadata: {},
  ...over,
});

const span = (over: Partial<Span> = {}): Span => ({
  id: "s1",
  traceId: "t1",
  parentId: null,
  name: "do the thing",
  kind: "agent",
  startTime: 1_000,
  endTime: 5_000,
  status: "ok",
  attributes: { "nah.cost.usd": 0.01, "gen_ai.usage.input_tokens": 100, "gen_ai.usage.output_tokens": 20 },
  metadata: {},
  ...over,
});

describe("registering an agent", () => {
  it("names one after its directory, so a list of agents is not a list of paths", () => {
    const db = store();
    const agent = db.registerAgent({ cwd: "/Users/x/code/astracollab" });
    expect(agent.name).toBe("astracollab");
    expect(agent.status).toBe("starting");
  });

  it("keeps one row per process however often it registers", () => {
    const db = store();
    const first = db.registerAgent({ id: "ag_1", cwd: "/repo", pid: 42 });
    const second = db.registerAgent({ id: "ag_1", cwd: "/repo", pid: 42, model: "anthropic:claude-sonnet-4-5" });
    expect(db.listAgents()).toHaveLength(1);
    // The second registration fills in what it knows and leaves the rest alone.
    expect(second.model).toBe("anthropic:claude-sonnet-4-5");
    expect(second.startedAt).toBe(first.startedAt);
    expect(second.lastSeenAt).toBeGreaterThanOrEqual(first.lastSeenAt);
  });

  it("separates two sessions in the same directory", () => {
    const db = store();
    db.registerAgent({ cwd: "/repo", pid: 1 });
    db.registerAgent({ cwd: "/repo", pid: 2 });
    // Two agents in one repository is the normal state of a developer machine,
    // and a dashboard that merges them cannot say whether anything is running.
    expect(db.listAgents()).toHaveLength(2);
  });

  it("takes the name the studio gave a launched agent", () => {
    const db = store();
    const agent = db.registerAgent({ cwd: "/repo", name: "nightly-checks", source: "launch", status: "running" });
    expect(agent.name).toBe("nightly-checks");
    expect(agent.source).toBe("launch");
  });
});

describe("liveness", () => {
  it("ages an agent to idle rather than believing it is still working", () => {
    const db = store();
    const agent = db.registerAgent({ id: "ag_1", cwd: "/repo" });
    db.setAgentState("ag_1", { status: "running" });

    // Asked now, while it has just been seen: running.
    expect(db.listAgents({ runningBefore: Date.now() - 30_000 })[0]!.status).toBe("running");

    // Asked as though nothing had been heard for a minute: idle. Nothing ever
    // writes "offline" — a machine that sleeps cannot file that report — so the
    // status column records the last thing the agent said and this decides what to
    // believe now.
    expect(db.listAgents({ runningBefore: Date.now() + 60_000 })[0]!.status).toBe("idle");
    // The row itself is untouched, so a later heartbeat is believed again.
    expect(db.getAgent(agent.id)?.status).toBe("running");
  });

  it("does not age out an agent that has ended", () => {
    const db = store();
    db.registerAgent({ id: "ag_1", cwd: "/repo" });
    db.setAgentState("ag_1", { status: "failed", exitCode: 2 });
    const [agent] = db.listAgents({ runningBefore: Date.now() + 60_000 });
    expect(agent!.status).toBe("failed");
    expect(agent!.exitCode).toBe(2);
    expect(agent!.stoppedAt).not.toBeNull();
  });

  it("keeps a heartbeat from wiping what it does not know", () => {
    const db = store();
    db.registerAgent({ id: "ag_1", cwd: "/repo", model: "openai:gpt-5", version: "1.0.0" });
    db.setAgentState("ag_1", { status: "running" });
    const agent = db.getAgent("ag_1");
    expect(agent?.model).toBe("openai:gpt-5");
    expect(agent?.version).toBe("1.0.0");
  });
});

describe("attributing work to an agent", () => {
  it("scopes traces, totals and tool stats to one agent", () => {
    const db = store();
    const a = db.registerAgent({ id: "ag_a", cwd: "/a" }).id;
    const b = db.registerAgent({ id: "ag_b", cwd: "/b" }).id;

    db.saveTrace(trace({ id: "t_a", rootSpanId: "sa" }), [span({ id: "sa", traceId: "t_a" })], a);
    db.saveTrace(
      trace({ id: "t_b", rootSpanId: "sb", status: "error" }),
      [span({ id: "sb", traceId: "t_b", kind: "tool", name: "tool: read", attributes: { "nah.cost.usd": 0.5 } })],
      b,
    );

    expect(db.listTraces({ agentId: a }).map((t) => t.id)).toEqual(["t_a"]);
    expect(db.listTraces({}).map((t) => t.id).sort()).toEqual(["t_a", "t_b"]);
    expect(db.overview({ agentId: a })).toMatchObject({ traces: 1, errors: 0, costUsd: 0.01 });
    expect(db.overview({})).toMatchObject({ traces: 2, errors: 1, costUsd: 0.51 });

    // Spans carry no agent of their own; they inherit it from the trace, so the
    // per-agent tool table has to join to find out who called this tool.
    expect(db.toolStats({ agentId: a })).toHaveLength(0);
    expect(db.toolStats({ agentId: b }).map((tool) => tool.tool)).toEqual(["read"]);
    expect(db.timeseries(4, { agentId: b }).reduce((sum, point) => sum + point.traces, 0)).toBe(1);
  });

  it("summarises each agent with its own numbers", () => {
    const db = store();
    const id = db.registerAgent({ id: "ag_a", cwd: "/a", status: "running" }).id;
    db.saveTrace(trace({ id: "t1", rootSpanId: "s1" }), [span()], id);
    const [agent] = db.listAgents();
    expect(agent).toMatchObject({ id, traces: 1, errors: 0, inputTokens: 100, outputTokens: 20, costUsd: 0.01 });
    expect(agent!.medianDurationMs).toBe(4_000);
    expect(agent!.lastTraceAt).toBe(1_000);
  });

  it("keeps a trace that is not yet finished out of the duration figures", () => {
    const db = store();
    const id = db.registerAgent({ id: "ag_a", cwd: "/a" }).id;
    db.saveTrace(trace({ id: "open", rootSpanId: "s1", endTime: null }), [span({ endTime: null })], id);
    const [agent] = db.listAgents();
    // A run still going has no duration yet, and counting its elapsed time as one
    // would make every dashboard look slow.
    expect(agent!.medianDurationMs).toBe(0);
  });

  it("finds a trace by id whatever its age", () => {
    const db = store();
    const id = db.registerAgent({ id: "ag_a", cwd: "/a" }).id;
    for (let index = 0; index < 60; index += 1) {
      db.saveTrace(trace({ id: `t${index}`, rootSpanId: `s${index}` }), [span({ id: `s${index}`, traceId: `t${index}` })], id);
    }
    // The list is capped at 50 by default; a trace opened from a chat turn is
    // whatever age it happens to be.
    expect(db.getTrace("t59")?.trace.id).toBe("t59");
    expect(db.getTrace("nope")).toBeNull();
  });
});

describe("an agent's output", () => {
  it("keeps lines in order and numbers them", () => {
    const db = store();
    db.appendAgentLog("ag_a", { stream: "system", text: "started" });
    db.appendAgentLog("ag_a", { stream: "stdout", text: "one" });
    db.appendAgentLog("ag_a", { stream: "stdout", text: "two" });
    const logs = db.listAgentLogs("ag_a");
    expect(logs.map((line) => line.text)).toEqual(["started", "one", "two"]);
    expect(logs.map((line) => line.seq)).toEqual([1, 2, 3]);
  });

  it("numbers each agent's output separately", () => {
    const db = store();
    db.appendAgentLog("ag_a", { stream: "stdout", text: "a" });
    db.appendAgentLog("ag_b", { stream: "stdout", text: "b" });
    expect(db.listAgentLogs("ag_a")).toHaveLength(1);
    expect(db.listAgentLogs("ag_b")).toHaveLength(1);
  });

  it("keeps the traces when an agent is removed from the list", () => {
    const db = store();
    const id = db.registerAgent({ id: "ag_a", cwd: "/a" }).id;
    db.saveTrace(trace(), [span()], id);
    db.appendAgentLog(id, { stream: "stdout", text: "noise" });

    expect(db.deleteAgent(id)).toBe(true);
    expect(db.listAgents()).toHaveLength(0);
    // Removing tidies the list; it does not erase what the agent did, which is the
    // reason the dashboard exists.
    expect(db.listTraces({})).toHaveLength(1);
    expect(db.listAgentLogs(id)).toHaveLength(0);
  });

  it("ages out rows nobody is looking at, but never a live one", async () => {
    const db = store();
    db.registerAgent({ id: "ag_old", cwd: "/a" });
    db.setAgentState("ag_old", { status: "exited", exitCode: 0 });
    const running = db.registerAgent({ id: "ag_live", cwd: "/b", status: "running" }).id;

    // Pruning compares against the wall clock, so the row has to be a millisecond
    // old before it qualifies.
    await new Promise((resolve) => setTimeout(resolve, 2));
    expect(db.pruneAgents(0)).toBe(1);
    expect(db.listAgents().map((agent) => agent.id)).toEqual([running]);
  });
});

describe("a store written by an older build", () => {
  it("gains the agent columns instead of refusing to open", async () => {
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { DatabaseSync } = await import("node:sqlite");

    const path = join(mkdtempSync(join(tmpdir(), "nah-studio-migrate-")), "studio.sqlite");
    // The shape before agents existed.
    const old = new DatabaseSync(path);
    old.exec(`
      CREATE TABLE traces (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, start_time INTEGER NOT NULL, end_time INTEGER,
        root_span_id TEXT NOT NULL, status TEXT NOT NULL, tags TEXT NOT NULL DEFAULT '[]',
        metadata TEXT NOT NULL DEFAULT '{}', error TEXT, cost_usd REAL, input_tokens INTEGER,
        output_tokens INTEGER
      );
      CREATE TABLE messages (
        id TEXT PRIMARY KEY, trace_id TEXT, role TEXT NOT NULL, content TEXT NOT NULL,
        created_at INTEGER NOT NULL, metadata TEXT NOT NULL DEFAULT '{}'
      );
    `);
    old.close();

    const db = new StudioStore({ path });
    // Opening twice must not fail: the migration checks before it alters.
    const reopened = new StudioStore({ path });
    const id = reopened.registerAgent({ id: "ag_a", cwd: "/a" }).id;
    reopened.saveTrace(trace(), [span()], id);
    expect(reopened.listTraces({ agentId: id })).toHaveLength(1);
    // The traces that were already there are still readable.
    expect(db.listTraces({})).toHaveLength(1);
  });
});