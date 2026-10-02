/**
 * Where Studio's data lives: one SQLite file, no native dependency.
 *
 * `node:sqlite` again, for the same reasons the memory store uses it — nah
 * already requires Node 22.19, the module has shipped since 22.5, and a package
 * that ships a binary should not compile anything at install.
 *
 * Rows rather than documents because the questions Studio asks are questions:
 * which traces ran in the last hour, which spans of one trace, what scored below
 * 0.6 on dataset X. A JSON blob per trace cannot answer any of them without
 * loading everything, and "load everything" stops working at about a thousand
 * traces, which is a Tuesday.
 */
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { hostname as hostname_ } from "node:os";

import type { Agent, AgentLogLine, AgentStatus, AgentSummary, Span, Trace } from "./wire.js";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS traces (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  start_time  INTEGER NOT NULL,
  end_time    INTEGER,
  root_span_id TEXT NOT NULL,
  status      TEXT NOT NULL,
  tags        TEXT NOT NULL DEFAULT '[]',
  metadata    TEXT NOT NULL DEFAULT '{}',
  error       TEXT,
  cost_usd    REAL,
  input_tokens  INTEGER,
  output_tokens INTEGER,
  agent_id    TEXT
);
CREATE INDEX IF NOT EXISTS traces_start_idx ON traces (start_time DESC);

CREATE TABLE IF NOT EXISTS agents (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  cwd         TEXT NOT NULL,
  host        TEXT NOT NULL DEFAULT '',
  pid         INTEGER,
  model       TEXT,
  version     TEXT,
  status      TEXT NOT NULL DEFAULT 'starting',
  source      TEXT NOT NULL DEFAULT 'session',
  started_at  INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  stopped_at  INTEGER,
  exit_code   INTEGER,
  metadata    TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS agents_seen_idx ON agents (last_seen_at DESC);

CREATE TABLE IF NOT EXISTS agent_logs (
  agent_id  TEXT NOT NULL,
  seq       INTEGER NOT NULL,
  at        INTEGER NOT NULL,
  stream    TEXT NOT NULL,
  text      TEXT NOT NULL,
  PRIMARY KEY (agent_id, seq)
);

CREATE TABLE IF NOT EXISTS spans (
  id         TEXT PRIMARY KEY,
  trace_id   TEXT NOT NULL,
  parent_id  TEXT,
  name       TEXT NOT NULL,
  kind       TEXT NOT NULL,
  start_time INTEGER NOT NULL,
  end_time   INTEGER,
  status     TEXT NOT NULL,
  attributes TEXT NOT NULL DEFAULT '{}',
  input      TEXT,
  output     TEXT,
  error      TEXT,
  metadata   TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS spans_trace_idx ON spans (trace_id, start_time);

CREATE TABLE IF NOT EXISTS messages (
  id         TEXT PRIMARY KEY,
  trace_id   TEXT,
  agent_id   TEXT,
  role       TEXT NOT NULL,
  content    TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  metadata   TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS messages_trace_idx ON messages (trace_id, created_at);

CREATE TABLE IF NOT EXISTS datasets (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  version     INTEGER NOT NULL DEFAULT 1,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS dataset_items (
  id          TEXT PRIMARY KEY,
  dataset_id  TEXT NOT NULL,
  position    INTEGER NOT NULL,
  input       TEXT NOT NULL,
  expected    TEXT,
  metadata    TEXT NOT NULL DEFAULT '{}',
  FOREIGN KEY (dataset_id) REFERENCES datasets (id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS dataset_items_idx ON dataset_items (dataset_id, position);

CREATE TABLE IF NOT EXISTS scorers (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  kind        TEXT NOT NULL,
  config      TEXT NOT NULL DEFAULT '{}',
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS experiments (
  id          TEXT PRIMARY KEY,
  dataset_id  TEXT NOT NULL,
  status      TEXT NOT NULL,
  model       TEXT NOT NULL DEFAULT '',
  started_at  INTEGER NOT NULL,
  finished_at INTEGER,
  summary     TEXT NOT NULL DEFAULT '{}',
  error       TEXT
);

CREATE TABLE IF NOT EXISTS experiment_results (
  id            TEXT PRIMARY KEY,
  experiment_id TEXT NOT NULL,
  item_id       TEXT NOT NULL,
  status        TEXT NOT NULL,
  output        TEXT,
  error         TEXT,
  scores        TEXT NOT NULL DEFAULT '[]',
  trace_id      TEXT,
  created_at    INTEGER NOT NULL,
  FOREIGN KEY (experiment_id) REFERENCES experiments (id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS experiment_results_idx ON experiment_results (experiment_id);
`;

const now = () => Date.now();

const parseJson = <T>(value: unknown, fallback: T): T => {
  if (typeof value !== "string") return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
};

const randomId = (): string => Math.random().toString(36).slice(2, 10);

const basename = (path: string): string => path.replace(/[/\\]+$/, "").split(/[/\\]/).at(-1) || path;

/** Recorded rather than resolved, so an agent row means the same thing on any host. */
const hostname = (): string => {
  try {
    return hostname_();
  } catch {
    return "unknown";
  }
};

const toAgent = (row: Record<string, unknown>): Agent => ({
  id: String(row.id),
  name: String(row.name),
  cwd: String(row.cwd),
  host: String(row.host ?? ""),
  pid: row.pid === null || row.pid === undefined ? null : Number(row.pid),
  model: row.model === null || row.model === undefined ? null : String(row.model),
  version: row.version === null || row.version === undefined ? null : String(row.version),
  status: String(row.status ?? "starting") as AgentStatus,
  source: (row.source === "launch" ? "launch" : "session") as Agent["source"],
  startedAt: Number(row.started_at),
  lastSeenAt: Number(row.last_seen_at),
  stoppedAt: row.stopped_at === null || row.stopped_at === undefined ? null : Number(row.stopped_at),
  exitCode: row.exit_code === null || row.exit_code === undefined ? null : Number(row.exit_code),
  metadata: parseJson<Record<string, unknown>>(row.metadata, {}),
});

/**
 * Age an agent out at read time.
 *
 * Nothing writes "offline": a process that is killed, or a machine that sleeps,
 * simply stops reporting. So the status column records what the agent last said
 * about itself and this decides what to believe now, which is the only honest
 * way to draw a live dot without a sweeper thread.
 */
const ageOut = (agent: Agent, runningBefore: number | undefined): AgentStatus => {
  if (runningBefore === undefined) return agent.status;
  if (agent.status !== "running" && agent.status !== "starting") return agent.status;
  return agent.lastSeenAt >= runningBefore ? agent.status : "idle";
};

export type TraceRow = Trace;

export type DatasetItem = {
  id: string;
  input: string;
  expected?: string;
  metadata: Record<string, unknown>;
};

export type ScoreRecord = {
  scorerId: string;
  score: number;
  reason?: string;
  /** Scorers may decline rather than guess; recorded so averages stay honest. */
  skipped?: boolean;
};

export type ExperimentResult = {
  id: string;
  itemId: string;
  input: string;
  status: "passed" | "failed" | "error";
  output?: string;
  error?: string;
  scores: ScoreRecord[];
  traceId?: string;
  durationMs: number;
  /** Provider-level retries before this item ran (or gave up). */
  attempts: number;
};

/**
 * What changed, for whoever is watching.
 *
 * The store is synchronous and knows nothing about HTTP, so it announces facts
 * and the server decides who to tell. That is what keeps the live dashboard from
 * needing a second source of truth: there is no polling loop to drift from the
 * writes that actually happened.
 */
export type StoreEvent =
  | { type: "trace"; trace: Trace; agentId: string | null }
  | { type: "agent"; agentId: string }
  | { type: "log"; agentId: string; line: AgentLogLine };

/** Applied to stores written before agents existed, one column at a time. */
const MIGRATIONS: Array<{ table: string; column: string; definition: string }> = [
  { table: "traces", column: "agent_id", definition: "TEXT" },
  { table: "messages", column: "agent_id", definition: "TEXT" },
];

export class StudioStore {
  private readonly db: DatabaseSync;
  private readonly listeners = new Set<(event: StoreEvent) => void>();

  constructor(options: { path: string }) {
    if (options.path !== ":memory:") mkdirSync(dirname(options.path), { recursive: true });
    this.db = new DatabaseSync(options.path);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA busy_timeout = 5000");
    this.db.exec("PRAGMA foreign_keys = ON");
    this.db.exec(SCHEMA);
    this.migrate();
  }

  /**
   * Bring an older file up to the current shape.
   *
   * `CREATE TABLE IF NOT EXISTS` only helps a store that does not exist yet, and
   * everyone who ran the Studio last week has one. SQLite has no
   * `ADD COLUMN IF NOT EXISTS`, so the columns are checked first: an `ALTER` on
   * an existing column is an error, and a dashboard that refuses to start
   * because it ran twice is worse than one that starts twice.
   */
  private migrate(): void {
    for (const { table, column, definition } of MIGRATIONS) {
      const existing = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
      if (existing.some((entry) => entry.name === column)) continue;
      this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    }
    // Indexes over the new columns come last, because an index on a column that
    // does not exist yet fails the whole open — and a Studio that refuses to start
    // because it was last run last week is the worst possible version of this bug.
    this.db.exec("CREATE INDEX IF NOT EXISTS traces_agent_idx ON traces (agent_id, start_time DESC)");
  }

  /** Watch for writes. Returns the unsubscribe, so a caller cannot leak a listener. */
  on(listener: (event: StoreEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Tell the listeners, and never let one of them fail the write.
   *
   * A watcher is a viewer. A dashboard that has gone away mid-turn must not turn
   * a completed run into an error for the agent that produced it.
   */
  private emit(event: StoreEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // Intentionally ignored; see above.
      }
    }
  }

  /** Persist a finished trace and all of its spans, as one unit. */
  saveTrace(trace: Trace, spans: Span[], agentId: string | null = null): void {
    const root = spans.find((span) => span.id === trace.rootSpanId);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      // Re-running the same trace id replaces it. An experiment re-runs its cases,
      // and appending would make one trace appear several times in the list.
      this.db.prepare("DELETE FROM spans WHERE trace_id = ?").run(trace.id);
      this.db
        .prepare(
          `INSERT OR REPLACE INTO traces
             (id, name, start_time, end_time, root_span_id, status, tags, metadata, error,
              cost_usd, input_tokens, output_tokens, agent_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          trace.id,
          trace.name,
          trace.startTime,
          trace.endTime,
          trace.rootSpanId,
          trace.status,
          JSON.stringify(trace.tags),
          JSON.stringify(trace.metadata),
          trace.error ? JSON.stringify(trace.error) : null,
          typeof root?.attributes["nah.cost.usd"] === "number" ? root.attributes["nah.cost.usd"] : null,
          typeof root?.attributes["gen_ai.usage.input_tokens"] === "number" ? root.attributes["gen_ai.usage.input_tokens"] : null,
          typeof root?.attributes["gen_ai.usage.output_tokens"] === "number" ? root.attributes["gen_ai.usage.output_tokens"] : null,
          agentId,
        );

      const insert = this.db.prepare(
        `INSERT OR REPLACE INTO spans
           (id, trace_id, parent_id, name, kind, start_time, end_time, status, attributes, input, output, error, metadata)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const span of spans) {
        insert.run(
          span.id,
          span.traceId,
          span.parentId,
          span.name,
          span.kind,
          span.startTime,
          span.endTime,
          span.status,
          JSON.stringify(span.attributes),
          span.input === undefined ? null : JSON.stringify(span.input),
          span.output === undefined ? null : JSON.stringify(span.output),
          span.error ? JSON.stringify(span.error) : null,
          JSON.stringify(span.metadata),
        );
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    // After the commit, so nobody is told about a trace that was rolled back.
    this.emit({ type: "trace", trace: { ...trace, agentId }, agentId });
  }

  listTraces(
    filter: {
      limit?: number;
      search?: string;
      status?: string;
      tag?: string;
      since?: number;
      until?: number;
      /** One agent, or every agent. */
      agentId?: string;
      sort?: "startTime" | "name" | "costUsd";
      order?: "asc" | "desc";
    } = {},
  ): TraceRow[] {
    const clauses: string[] = [];
    const params: Array<string | number> = [];
    if (filter.search) {
      clauses.push("(name LIKE ? OR id LIKE ?)");
      params.push(`%${filter.search}%`, `%${filter.search}%`);
    }
    if (filter.status) {
      clauses.push("status = ?");
      params.push(filter.status);
    }
    if (filter.since !== undefined) {
      clauses.push("start_time >= ?");
      params.push(filter.since);
    }
    if (filter.until !== undefined) {
      clauses.push("start_time <= ?");
      params.push(filter.until);
    }
    if (filter.agentId) {
      clauses.push("agent_id = ?");
      params.push(filter.agentId);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    // Whitelisted, never interpolated from the request: the sort column is the one
    // place a naive implementation ends up with a SQL injection.
    const column = { startTime: "start_time", name: "name", costUsd: "cost_usd" }[filter.sort ?? "startTime"] ?? "start_time";
    const direction = filter.order === "asc" ? "ASC" : "DESC";
    const rows = this.db
      .prepare(
        `SELECT * FROM traces ${where} ORDER BY ${column} ${direction} NULLS LAST, start_time DESC LIMIT ?`,
      )
      .all(...params, filter.limit ?? 50) as Array<Record<string, unknown>>;
    return rows.map((row) => {
      const trace: TraceRow = {
        id: String(row.id),
        name: String(row.name),
        startTime: Number(row.start_time),
        endTime: row.end_time === null ? null : Number(row.end_time),
        rootSpanId: String(row.root_span_id),
        status: String(row.status) as Trace["status"],
        tags: parseJson<string[]>(row.tags, []),
        metadata: parseJson<Record<string, unknown>>(row.metadata, {}),
        ...(row.error === null ? {} : { error: parseJson(row.error, undefined) }),
        ...(row.cost_usd === null ? {} : { costUsd: Number(row.cost_usd) }),
        ...(row.input_tokens === null ? {} : { inputTokens: Number(row.input_tokens) }),
        ...(row.output_tokens === null ? {} : { outputTokens: Number(row.output_tokens) }),
        ...(row.agent_id === null ? {} : { agentId: String(row.agent_id) }),
      };
      return trace;
    }).filter((trace) => (filter.tag ? trace.tags.includes(filter.tag) : true));
  }

  getTrace(id: string): { trace: TraceRow; spans: Span[] } | null {
    // Read the trace directly rather than through the list, which sorts and
    // limits: a trace opened by id must be found whatever its age.
    const row = this.db.prepare("SELECT * FROM traces WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    if (!row) return null;
    const trace: TraceRow = {
      id: String(row.id),
      name: String(row.name),
      startTime: Number(row.start_time),
      endTime: row.end_time === null ? null : Number(row.end_time),
      rootSpanId: String(row.root_span_id),
      status: String(row.status) as Trace["status"],
      tags: parseJson<string[]>(row.tags, []),
      metadata: parseJson<Record<string, unknown>>(row.metadata, {}),
      ...(row.error === null ? {} : { error: parseJson(row.error, undefined) }),
      ...(row.cost_usd === null ? {} : { costUsd: Number(row.cost_usd) }),
      ...(row.input_tokens === null ? {} : { inputTokens: Number(row.input_tokens) }),
      ...(row.output_tokens === null ? {} : { outputTokens: Number(row.output_tokens) }),
      ...(row.agent_id === null ? {} : { agentId: String(row.agent_id) }),
    };
    const spans = this.db
      .prepare("SELECT * FROM spans WHERE trace_id = ? ORDER BY start_time ASC")
      .all(id) as Array<Record<string, unknown>>;
    return {
      trace,
      spans: spans.map((span) => ({
        id: String(span.id),
        traceId: String(span.trace_id),
        parentId: span.parent_id === null ? null : String(span.parent_id),
        name: String(span.name),
        kind: String(span.kind) as Span["kind"],
        startTime: Number(span.start_time),
        endTime: span.end_time === null ? null : Number(span.end_time),
        status: String(span.status) as Span["status"],
        attributes: parseJson<Span["attributes"]>(span.attributes, {}),
        ...(span.input === null ? {} : { input: parseJson(span.input, null) }),
        ...(span.output === null ? {} : { output: parseJson(span.output, null) }),
        ...(span.error === null ? {} : { error: parseJson(span.error, undefined) }),
        metadata: parseJson<Record<string, unknown>>(span.metadata, {}),
      })),
    };
  }

  /**
   * Bucketed history for the dashboard charts.
   *
   * Buckets rather than a raw series: a week of runs is thousands of points, and
   * a sparkline cannot show that anyway. `NULLS`-free arithmetic keeps an empty
   * hour at zero rather than absent, which is the difference between "no runs"
   * and "the query lost them".
   */
  timeseries(buckets = 24, filter: { agentId?: string } = {}): Array<{ t: number; traces: number; errors: number; costUsd: number; medianMs: number }> {
    // Scoped by a join rather than a subquery over `traces` alone, because the
    // per-agent chart is the same chart over a different set of runs.
    const rows = (
      filter.agentId
        ? this.db
            .prepare(
              `SELECT t.start_time, t.status, t.cost_usd, t.end_time
               FROM traces t JOIN agents a ON a.id = t.agent_id
               WHERE a.id = ? ORDER BY t.start_time ASC`,
            )
            .all(filter.agentId)
        : this.db.prepare("SELECT start_time, status, cost_usd, end_time FROM traces ORDER BY start_time ASC").all()
    ) as Array<{ start_time: number; status: string; cost_usd: number | null; end_time: number | null }>;
    if (rows.length === 0) return [];
    const oldest = rows[0]!.start_time;
    const newest = now();
    const width = Math.max(1, Math.ceil((newest - oldest) / buckets));
    const series = Array.from({ length: buckets }, (_, index) => ({
      t: oldest + index * width,
      traces: 0,
      errors: 0,
      costUsd: 0,
      durations: [] as number[],
    }));
    for (const row of rows) {
      const index = Math.min(buckets - 1, Math.max(0, Math.floor((row.start_time - oldest) / width)));
      const bucket = series[index]!;
      bucket.traces += 1;
      if (row.status === "error") bucket.errors += 1;
      bucket.costUsd += row.cost_usd ?? 0;
      if (row.end_time !== null) bucket.durations.push(row.end_time - row.start_time);
    }
    return series.map((bucket) => {
      const sorted = bucket.durations.sort((a, b) => a - b);
      return {
        t: bucket.t,
        traces: bucket.traces,
        errors: bucket.errors,
        costUsd: Number(bucket.costUsd.toFixed(6)),
        medianMs: sorted.length === 0 ? 0 : (sorted[Math.floor(sorted.length / 2)] ?? 0),
      };
    });
  }

  /**
   * Per-tool aggregates across every trace.
   *
   * "Which tool is slow or failing" is a question about the whole history, not
   * about one run, so it is answered in SQL rather than by loading spans.
   */
  toolStats(filter: { agentId?: string } = {}): Array<{ tool: string; calls: number; errors: number; errorRate: number; p50Ms: number; p95Ms: number; totalMs: number }> {
    // Read the tool name off the span name rather than out of the attributes JSON.
    //
    // Two reasons, and the first is the real one: `json_extract` treats the dots
    // in "nah.tool.name" as path separators, so querying it fails outright, and a
    // JSON extraction on every tool span is a full scan of every span regardless
    // of how many rows it wants back. The name is already the first column of
    // every tool span, prefixed with "tool: ".
    //
    // Spans carry no agent of their own; they inherit it from the trace, so a
    // per-agent view has to join to find out who called this tool.
    const scope = filter.agentId ? "AND s.trace_id IN (SELECT id FROM traces WHERE agent_id = ?)" : "";
    const scoped = filter.agentId ? [filter.agentId] : [];
    const rows = this.db
      .prepare(
        `SELECT substr(s.name, 7) AS tool,
                COUNT(*) AS calls,
                SUM(CASE WHEN s.status = 'error' THEN 1 ELSE 0 END) AS errors,
                SUM(COALESCE(s.end_time, s.start_time) - s.start_time) AS total_ms
         FROM spans s
         WHERE s.kind = 'tool' AND s.name LIKE 'tool: %' ${scope}
         GROUP BY tool
         ORDER BY calls DESC`,
      )
      .all(...scoped) as Array<{ tool: string; calls: number; errors: number; total_ms: number }>;

    return rows.map((row) => {
      const durations = (
        this.db
          .prepare(
            `SELECT COALESCE(s.end_time, s.start_time) - s.start_time AS ms
             FROM spans s
             WHERE s.kind = 'tool' AND s.name = ? ${scope}
             ORDER BY ms ASC`,
          )
          .all(`tool: ${row.tool}`, ...scoped) as Array<{ ms: number }>
      ).map((entry) => entry.ms);
      const at = (fraction: number) => durations[Math.min(durations.length - 1, Math.floor(durations.length * fraction))] ?? 0;
      return {
        tool: row.tool,
        calls: row.calls,
        errors: row.errors,
        errorRate: row.calls === 0 ? 0 : Number((row.errors / row.calls).toFixed(4)),
        p50Ms: at(0.5),
        p95Ms: at(0.95),
        totalMs: row.total_ms,
      };
    });
  }

  /** Totals for the dashboard. One pass, so it stays cheap as the table grows. */
  overview(filter: { agentId?: string } = {}): {
    traces: number;
    errors: number;
    costUsd: number;
    inputTokens: number;
    outputTokens: number;
    medianDurationMs: number;
  } {
    const scope = filter.agentId ? "WHERE agent_id = ?" : "";
    const scoped = filter.agentId ? [filter.agentId] : [];
    const totals = this.db
      .prepare(
        `SELECT COUNT(*) AS n,
                SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) AS errors,
                SUM(COALESCE(cost_usd, 0)) AS cost,
                SUM(COALESCE(input_tokens, 0)) AS input_tokens,
                SUM(COALESCE(output_tokens, 0)) AS output_tokens
         FROM traces ${scope}`,
      )
      .get(...scoped) as { n: number; errors: number; cost: number; input_tokens: number; output_tokens: number };
    const durations = (
      this.db
        .prepare(
          `SELECT end_time - start_time AS ms FROM traces
           WHERE end_time IS NOT NULL ${filter.agentId ? "AND agent_id = ?" : ""}
           ORDER BY start_time DESC LIMIT 500`,
        )
        .all(...scoped) as Array<{ ms: number }>
    ).map((row) => row.ms);
    const middle = Math.floor(durations.length / 2);
    const sorted = durations.sort((a, b) => a - b);
    return {
      traces: totals.n ?? 0,
      errors: totals.errors ?? 0,
      costUsd: Number((totals.cost ?? 0).toFixed(6)),
      inputTokens: totals.input_tokens ?? 0,
      outputTokens: totals.output_tokens ?? 0,
      medianDurationMs: sorted.length === 0 ? 0 : (sorted[middle] ?? 0),
    };
  }

  // --- agents ---------------------------------------------------------------

  /**
   * Register, or refresh, one agent.
   *
   * An id is the identity: a process asks with the same id every time it
   * heartbeats, so a re-registration updates one row instead of filling the list
   * with copies of the same agent. A caller with no id gets a new one, which is
   * what a fresh `nah` session does.
   */
  registerAgent(registration: {
    id?: string;
    name?: string;
    cwd: string;
    host?: string;
    pid?: number;
    model?: string | null;
    version?: string | null;
    source?: "session" | "launch";
    metadata?: Record<string, unknown>;
    status?: AgentStatus;
  }): Agent {
    const id = registration.id ?? `ag_${randomId()}`;
    const existing = this.getAgent(id);
    const at = now();
    const agent: Agent = {
      id,
      // A name the user did not choose is the project's name: the dashboard is
      // full of directories, and "astracollab-packages" beats a path.
      name: registration.name?.trim() || existing?.name || basename(registration.cwd),
      cwd: registration.cwd,
      host: registration.host ?? existing?.host ?? hostname(),
      pid: registration.pid ?? existing?.pid ?? null,
      model: registration.model ?? existing?.model ?? null,
      version: registration.version ?? existing?.version ?? null,
      status: registration.status ?? existing?.status ?? "starting",
      source: registration.source ?? existing?.source ?? "session",
      // A re-registration is the same agent, so `startedAt` only moves for a
      // status that means the process ended.
      startedAt: existing?.startedAt ?? at,
      lastSeenAt: at,
      stoppedAt: registration.status === "running" ? null : (existing?.stoppedAt ?? null),
      exitCode: registration.status === "running" ? null : (existing?.exitCode ?? null),
      metadata: { ...(existing?.metadata ?? {}), ...(registration.metadata ?? {}) },
    };
    this.db
      .prepare(
        `INSERT OR REPLACE INTO agents
           (id, name, cwd, host, pid, model, version, status, source, started_at, last_seen_at, stopped_at, exit_code, metadata)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        agent.id,
        agent.name,
        agent.cwd,
        agent.host,
        agent.pid,
        agent.model,
        agent.version,
        agent.status,
        agent.source,
        agent.startedAt,
        agent.lastSeenAt,
        agent.stoppedAt,
        agent.exitCode,
        JSON.stringify(agent.metadata),
      );
    this.emit({ type: "agent", agentId: agent.id });
    return agent;
  }

  /**
   * Move an agent to a new status and mark it seen.
   *
   * Separate from registration because a heartbeat must not be able to rewrite
   * the fields it has no opinion about — a status change should not blank a model.
   */
  setAgentState(id: string, patch: { status?: AgentStatus; exitCode?: number | null; metadata?: Record<string, unknown> }): Agent | null {
    const existing = this.getAgent(id);
    if (!existing) return null;
    const ended = patch.status === "exited" || patch.status === "stopped" || patch.status === "failed";
    const agent: Agent = {
      ...existing,
      status: patch.status ?? existing.status,
      exitCode: patch.exitCode ?? existing.exitCode,
      stoppedAt: ended ? now() : existing.stoppedAt,
      lastSeenAt: now(),
      metadata: patch.metadata === undefined ? existing.metadata : { ...existing.metadata, ...patch.metadata },
    };
    this.db
      .prepare(
        `UPDATE agents SET status = ?, exit_code = ?, stopped_at = ?, last_seen_at = ?, metadata = ? WHERE id = ?`,
      )
      .run(agent.status, agent.exitCode, agent.stoppedAt, agent.lastSeenAt, JSON.stringify(agent.metadata), agent.id);
    this.emit({ type: "agent", agentId: agent.id });
    return agent;
  }

  getAgent(id: string): Agent | null {
    const row = this.db.prepare("SELECT * FROM agents WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    return row ? toAgent(row) : null;
  }

  /**
   * Agents, each with its own totals, newest activity first.
   *
   * `runningBefore` is what makes the online dot honest: a process that stopped
   * reporting is offline even though nothing ever wrote "offline", because a
   * machine that was unplugged cannot file that report.
   */
  listAgents(filter: { runningBefore?: number; cwd?: string } = {}): AgentSummary[] {
    const clauses: string[] = [];
    const params: Array<string | number> = [];
    if (filter.cwd) {
      clauses.push("a.cwd = ?");
      params.push(filter.cwd);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.db
      .prepare(
        `SELECT a.*,
                COUNT(t.id) AS traces,
                SUM(CASE WHEN t.status = 'error' THEN 1 ELSE 0 END) AS errors,
                COALESCE(SUM(t.cost_usd), 0) AS cost,
                COALESCE(SUM(t.input_tokens), 0) AS input_tokens,
                COALESCE(SUM(t.output_tokens), 0) AS output_tokens,
                MAX(t.start_time) AS last_trace
         FROM agents a
         LEFT JOIN traces t ON t.agent_id = a.id
         ${where}
         GROUP BY a.id
         ORDER BY a.last_seen_at DESC`,
      )
      .all(...params) as Array<Record<string, unknown>>;
    return rows.map((row) => this.summarize(row, filter.runningBefore));
  }

  /**
   * One agent's summary.
   *
   * Separate from filtering the list because the live stream needs this per
   * event, and re-aggregating every agent to describe the one that just moved is
   * how a ten-agent dashboard spends its time on nine agents nobody is watching.
   */
  getAgentSummary(id: string, runningBefore?: number): AgentSummary | null {
    const row = this.db
      .prepare(
        `SELECT a.*,
                COUNT(t.id) AS traces,
                SUM(CASE WHEN t.status = 'error' THEN 1 ELSE 0 END) AS errors,
                COALESCE(SUM(t.cost_usd), 0) AS cost,
                COALESCE(SUM(t.input_tokens), 0) AS input_tokens,
                COALESCE(SUM(t.output_tokens), 0) AS output_tokens,
                MAX(t.start_time) AS last_trace
         FROM agents a
         LEFT JOIN traces t ON t.agent_id = a.id
         WHERE a.id = ?
         GROUP BY a.id`,
      )
      .get(id) as Record<string, unknown> | undefined;
    return row ? this.summarize(row, runningBefore) : null;
  }

  private summarize(row: Record<string, unknown>, runningBefore: number | undefined): AgentSummary {
    const agent = toAgent(row);
    const durations = (
      this.db
        .prepare(
          `SELECT end_time - start_time AS ms FROM traces
           WHERE agent_id = ? AND end_time IS NOT NULL ORDER BY start_time DESC LIMIT 200`,
        )
        .all(agent.id) as Array<{ ms: number }>
    )
      .map((entry) => entry.ms)
      .sort((a, b) => a - b);
    return {
      ...agent,
      // Silence ages an agent to `idle` rather than to a lie: the process is
      // still there, it is just not working right now.
      status: ageOut(agent, runningBefore),
      traces: Number(row.traces ?? 0),
      errors: Number(row.errors ?? 0),
      costUsd: Number(Number(row.cost ?? 0).toFixed(6)),
      inputTokens: Number(row.input_tokens ?? 0),
      outputTokens: Number(row.output_tokens ?? 0),
      medianDurationMs: durations.length === 0 ? 0 : (durations[Math.floor(durations.length / 2)] ?? 0),
      lastTraceAt: row.last_trace === null || row.last_trace === undefined ? null : Number(row.last_trace),
    };
  }

  deleteAgent(id: string): boolean {
    // The traces stay. Removing an agent is how you tidy the list, not how you
    // erase what it did, and a row of traces with a missing agent is still
    // readable history.
    this.db.prepare("DELETE FROM agent_logs WHERE agent_id = ?").run(id);
    const result = this.db.prepare("DELETE FROM agents WHERE id = ?").run(id);
    return Number(result.changes ?? 0) > 0;
  }

  /** Append one line of an agent's output, and hand it to whoever is watching. */
  appendAgentLog(agentId: string, line: { stream: "stdout" | "stderr" | "system"; text: string }): AgentLogLine {
    // The aggregate always returns one row; the fallback only satisfies the type,
    // and a log line numbered from 1 is as readable as one numbered from 0.
    const seq =
      (this.db
        .prepare("SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM agent_logs WHERE agent_id = ?")
        .all(agentId) as Array<{ next: number }>)[0]?.next ?? 1;
    const entry: AgentLogLine = { seq, at: now(), stream: line.stream, text: line.text };
    this.db
      .prepare("INSERT OR REPLACE INTO agent_logs (agent_id, seq, at, stream, text) VALUES (?, ?, ?, ?, ?)")
      .run(agentId, entry.seq, entry.at, entry.stream, entry.text);
    this.emit({ type: "log", agentId, line: entry });
    return entry;
  }

  listAgentLogs(agentId: string, limit = 500): AgentLogLine[] {
    const rows = this.db
      .prepare("SELECT seq, at, stream, text FROM agent_logs WHERE agent_id = ? ORDER BY seq DESC LIMIT ?")
      .all(agentId, limit) as Array<{ seq: number; at: number; stream: string; text: string }>;
    return rows
      .map((row) => ({ seq: Number(row.seq), at: Number(row.at), stream: row.stream as AgentLogLine["stream"], text: String(row.text) }))
      .reverse();
  }

  /**
   * Drop the rows nobody is looking at any more.
   *
   * Agents age out far faster than traces: a process from last month is not a
   * thing to keep a row for, and the trace it produced is the part worth keeping.
   */
  pruneAgents(olderThanMs: number): number {
    const cutoff = now() - olderThanMs;
    const result = this.db
      .prepare("DELETE FROM agents WHERE last_seen_at < ? AND status NOT IN ('running', 'starting')")
      .run(cutoff);
    this.db.prepare("DELETE FROM agent_logs WHERE agent_id NOT IN (SELECT id FROM agents)").run();
    return Number(result.changes ?? 0);
  }

  saveMessage(message: { id: string; traceId?: string; agentId?: string; role: string; content: string; metadata?: Record<string, unknown> }): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO messages (id, trace_id, agent_id, role, content, created_at, metadata)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(message.id, message.traceId ?? null, message.agentId ?? null, message.role, message.content, now(), JSON.stringify(message.metadata ?? {}));
  }

  /**
   * Messages newest first, with a monotonic sequence number.
   *
   * `created_at` is millisecond-resolution, and a short reply writes its user and
   * assistant messages inside the same millisecond — so timestamp alone is not a
   * total order and a thread rebuilt from it can come back reversed. `seq` is
   * SQLite's insertion counter: it is monotonic, so sorting by it puts the thread
   * back in the order it was actually said in. The sort order *within* equal
   * timestamps is left unspecified on purpose rather than papered over.
   */
  listMessages(filter: { traceId?: string; limit?: number } = {}): Array<{
    id: string;
    traceId?: string;
    role: string;
    content: string;
    createdAt: number;
    seq: number;
  }> {
    const where = filter.traceId ? "WHERE trace_id = ?" : "";
    const params = filter.traceId ? [filter.traceId] : [];
    const rows = this.db
      .prepare(`SELECT rowid AS seq, * FROM messages ${where} ORDER BY created_at DESC, seq DESC LIMIT ?`)
      .all(...params, filter.limit ?? 100) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      id: String(row.id),
      ...(row.trace_id === null ? {} : { traceId: String(row.trace_id) }),
      role: String(row.role),
      content: String(row.content),
      createdAt: Number(row.created_at),
      seq: Number(row.seq),
    }));
  }

  /** Bounded retention. Traces are diagnostic; a year of them is a liability. */
  prune(olderThanMs: number): number {
    const cutoff = now() - olderThanMs;
    const result = this.db.prepare("DELETE FROM traces WHERE start_time < ?").run(cutoff);
    this.db.prepare("DELETE FROM spans WHERE trace_id NOT IN (SELECT id FROM traces)").run();
    return Number(result.changes ?? 0);
  }

  // --- datasets -------------------------------------------------------------

  createDataset(input: { id?: string; name: string; description?: string }): { id: string; version: number } {
    const id = input.id ?? `ds_${Math.random().toString(36).slice(2, 10)}`;
    this.db
      .prepare("INSERT INTO datasets (id, name, description, version, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?)")
      .run(id, input.name, input.description ?? "", now(), now());
    return { id, version: 1 };
  }

  listDatasets(): Array<{ id: string; name: string; description: string; version: number; items: number }> {
    const rows = this.db
      .prepare(
        `SELECT d.*, (SELECT COUNT(*) FROM dataset_items i WHERE i.dataset_id = d.id) AS items
         FROM datasets d ORDER BY d.updated_at DESC`,
      )
      .all() as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      id: String(row.id),
      name: String(row.name),
      description: String(row.description),
      version: Number(row.version),
      items: Number(row.items),
    }));
  }

  addDatasetItems(datasetId: string, items: Array<{ id?: string; input: string; expected?: string; metadata?: Record<string, unknown> }>): number {
    const existing = this.db
      .prepare("SELECT COALESCE(MAX(position), -1) AS max FROM dataset_items WHERE dataset_id = ?")
      .get(datasetId) as { max: number };
    let position = existing.max + 1;
    let added = 0;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const insert = this.db.prepare(
        "INSERT OR REPLACE INTO dataset_items (id, dataset_id, position, input, expected, metadata) VALUES (?, ?, ?, ?, ?, ?)",
      );
      for (const item of items) {
        insert.run(
          item.id ?? `it_${datasetId}_${position}`,
          datasetId,
          position,
          item.input,
          item.expected ?? null,
          JSON.stringify(item.metadata ?? {}),
        );
        position += 1;
        added += 1;
      }
      // Appending items changes the dataset, so the version moves: an experiment
      // result has to be attributable to the exact cases it ran.
      this.db.prepare("UPDATE datasets SET version = version + 1, updated_at = ? WHERE id = ?").run(now(), datasetId);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return added;
  }

  listDatasetItems(datasetId: string): DatasetItem[] {
    const rows = this.db
      .prepare("SELECT * FROM dataset_items WHERE dataset_id = ? ORDER BY position ASC")
      .all(datasetId) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      id: String(row.id),
      input: String(row.input),
      ...(row.expected === null ? {} : { expected: String(row.expected) }),
      metadata: parseJson<Record<string, unknown>>(row.metadata, {}),
    }));
  }

  deleteDataset(id: string): boolean {
    this.db.prepare("DELETE FROM dataset_items WHERE dataset_id = ?").run(id);
    return Number(this.db.prepare("DELETE FROM datasets WHERE id = ?").run(id).changes ?? 0) > 0;
  }

  // --- scorers --------------------------------------------------------------

  saveScorer(scorer: { id: string; name: string; description?: string; kind: string; config?: Record<string, unknown> }): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO scorers (id, name, description, kind, config, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(scorer.id, scorer.name, scorer.description ?? "", scorer.kind, JSON.stringify(scorer.config ?? {}), now());
  }

  listScorers(): Array<{ id: string; name: string; description: string; kind: string; config: Record<string, unknown> }> {
    const rows = this.db.prepare("SELECT * FROM scorers ORDER BY name ASC").all() as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      id: String(row.id),
      name: String(row.name),
      description: String(row.description),
      kind: String(row.kind),
      config: parseJson<Record<string, unknown>>(row.config, {}),
    }));
  }

  // --- experiments ----------------------------------------------------------

  startExperiment(input: { id?: string; datasetId: string; model: string }): string {
    const id = input.id ?? `ex_${Math.random().toString(36).slice(2, 10)}`;
    this.db
      .prepare("INSERT INTO experiments (id, dataset_id, status, model, started_at) VALUES (?, ?, 'running', ?, ?)")
      .run(id, input.datasetId, input.model, now());
    return id;
  }

  saveExperimentResult(result: ExperimentResult & { experimentId: string }): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO experiment_results
           (id, experiment_id, item_id, status, output, error, scores, trace_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        `${result.experimentId}:${result.itemId}`,
        result.experimentId,
        result.itemId,
        result.status,
        result.output ?? null,
        result.error ?? null,
        JSON.stringify(result.scores),
        result.traceId ?? null,
        now(),
      );
  }

  finishExperiment(id: string, summary: Record<string, unknown>, error?: string): void {
    this.db
      .prepare("UPDATE experiments SET status = ?, finished_at = ?, summary = ?, error = ? WHERE id = ?")
      .run(error === undefined ? "completed" : "failed", now(), JSON.stringify(summary), error ?? null, id);
  }

  getExperiment(id: string): {
    id: string;
    datasetId: string;
    status: string;
    model: string;
    startedAt: number;
    finishedAt: number | null;
    summary: Record<string, unknown>;
    error?: string;
    results: ExperimentResult[];
  } | null {
    const row = this.db.prepare("SELECT * FROM experiments WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    if (!row) return null;
    const items = this.db
      .prepare("SELECT * FROM experiment_results WHERE experiment_id = ? ORDER BY created_at ASC")
      .all(id) as Array<Record<string, unknown>>;
    const inputs = new Map(this.listDatasetItems(String(row.dataset_id)).map((item) => [item.id, item.input]));
    return {
      id: String(row.id),
      datasetId: String(row.dataset_id),
      status: String(row.status),
      model: String(row.model),
      startedAt: Number(row.started_at),
      finishedAt: row.finished_at === null ? null : Number(row.finished_at),
      summary: parseJson<Record<string, unknown>>(row.summary, {}),
      ...(row.error === null ? {} : { error: String(row.error) }),
      results: items.map((item) => ({
        id: String(item.id),
        itemId: String(item.item_id),
        input: inputs.get(String(item.item_id)) ?? "",
        status: String(item.status) as ExperimentResult["status"],
        ...(item.output === null ? {} : { output: String(item.output) }),
        ...(item.error === null ? {} : { error: String(item.error) }),
        scores: parseJson<ScoreRecord[]>(item.scores, []),
        ...(item.trace_id === null ? {} : { traceId: String(item.trace_id) }),
        durationMs: 0,
        // Not persisted per row; the experiment's own summary carries it.
        attempts: 1,
      })),
    };
  }

  listExperiments(limit = 20): Array<{ id: string; datasetId: string; status: string; model: string; startedAt: number; finishedAt: number | null; summary: Record<string, unknown> }> {
    const rows = this.db
      .prepare("SELECT * FROM experiments ORDER BY started_at DESC LIMIT ?")
      .all(limit) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      id: String(row.id),
      datasetId: String(row.dataset_id),
      status: String(row.status),
      model: String(row.model),
      startedAt: Number(row.started_at),
      finishedAt: row.finished_at === null ? null : Number(row.finished_at),
      summary: parseJson<Record<string, unknown>>(row.summary, {}),
    }));
  }

  close(): void {
    this.db.close();
  }
}