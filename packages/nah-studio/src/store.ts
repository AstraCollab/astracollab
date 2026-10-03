import { mkdirSync } from "node:fs";
import { hostname as hostname_ } from "node:os";
import { dirname } from "node:path";
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

import type {
	Agent,
	AgentLogLine,
	AgentStatus,
	AgentSummary,
	Span,
	Trace,
	WorkflowRunDetail,
	WorkflowRunStatus,
	WorkflowRunSummary,
	WorkflowStepRecord,
	WorkflowStepStatus,
} from "./wire.js";

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

CREATE TABLE IF NOT EXISTS workflow_runs (
  id           TEXT PRIMARY KEY,
  workflow_id  TEXT NOT NULL,
  status       TEXT NOT NULL,
  input        TEXT NOT NULL DEFAULT 'null',
  output       TEXT,
  error        TEXT,
  started_at   INTEGER NOT NULL,
  finished_at  INTEGER,
  model        TEXT,
  metadata     TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS workflow_runs_started_idx ON workflow_runs (started_at DESC);
CREATE INDEX IF NOT EXISTS workflow_runs_workflow_idx ON workflow_runs (workflow_id, started_at DESC);

-- One row per step, written as the run reports it. The graph itself comes from
-- the workflow, so this holds what actually happened rather than a copy of the
-- definition, and a step added to the workflow later is not in older runs.
CREATE TABLE IF NOT EXISTS workflow_steps (
  run_id      TEXT NOT NULL,
  step_id     TEXT NOT NULL,
  status      TEXT NOT NULL,
  started_at  INTEGER,
  finished_at INTEGER,
  duration_ms INTEGER,
  input       TEXT,
  output      TEXT,
  error       TEXT,
  text        TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (run_id, step_id),
  FOREIGN KEY (run_id) REFERENCES workflow_runs (id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS workflow_steps_run_idx ON workflow_steps (run_id, started_at);
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

const basename = (path: string): string =>
	path
		.replace(/[/\\]+$/, "")
		.split(/[/\\]/)
		.at(-1) || path;

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
	model:
		row.model === null || row.model === undefined ? null : String(row.model),
	version:
		row.version === null || row.version === undefined
			? null
			: String(row.version),
	status: String(row.status ?? "starting") as AgentStatus,
	source: (row.source === "launch" ? "launch" : "session") as Agent["source"],
	startedAt: Number(row.started_at),
	lastSeenAt: Number(row.last_seen_at),
	stoppedAt:
		row.stopped_at === null || row.stopped_at === undefined
			? null
			: Number(row.stopped_at),
	exitCode:
		row.exit_code === null || row.exit_code === undefined
			? null
			: Number(row.exit_code),
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
const ageOut = (
	agent: Agent,
	runningBefore: number | undefined,
): AgentStatus => {
	if (runningBefore === undefined) return agent.status;
	if (agent.status !== "running" && agent.status !== "starting")
		return agent.status;
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
const toWorkflowStep = (row: Record<string, unknown>): WorkflowStepRecord => ({
	runId: String(row.run_id),
	stepId: String(row.step_id),
	status: String(row.status) as WorkflowStepStatus,
	startedAt: row.started_at === null ? null : Number(row.started_at),
	finishedAt: row.finished_at === null ? null : Number(row.finished_at),
	durationMs: row.duration_ms === null ? null : Number(row.duration_ms),
	...(row.input === null ? {} : { input: parseJson<unknown>(row.input, null) }),
	...(row.output === null
		? {}
		: { output: parseJson<unknown>(row.output, null) }),
	...(row.error === null ? {} : { error: String(row.error) }),
	...(row.text === null || row.text === "" ? {} : { text: String(row.text) }),
});

const toWorkflowRun = (row: Record<string, unknown>): WorkflowRunSummary => ({
	runId: String(row.id),
	workflowId: String(row.workflow_id),
	status: String(row.status) as WorkflowRunStatus,
	input: parseJson<unknown>(row.input, null),
	...(row.output === null
		? {}
		: { output: parseJson<unknown>(row.output, null) }),
	...(row.error === null ? {} : { error: String(row.error) }),
	startedAt: Number(row.started_at),
	finishedAt: row.finished_at === null ? null : Number(row.finished_at),
	model: row.model === null ? null : String(row.model),
	started: Number(row.started ?? 0),
	steps: Number(row.steps ?? 0),
});

export type StoreEvent =
	| { type: "trace"; trace: Trace; agentId: string | null }
	| { type: "agent"; agentId: string }
	| { type: "log"; agentId: string; line: AgentLogLine };

/** Applied to stores written before agents existed, one column at a time. */
const MIGRATIONS: Array<{ table: string; column: string; definition: string }> =
	[
		{ table: "traces", column: "agent_id", definition: "TEXT" },
		{ table: "messages", column: "agent_id", definition: "TEXT" },
	];

export class StudioStore {
	private readonly db: DatabaseSync;
	private readonly listeners = new Set<(event: StoreEvent) => void>();
	/**
	 * Prepared once and reused, because `prepare` re-parses the SQL on every call
	 * and the log insert is the hottest statement in the process by a wide margin.
	 */
	private readonly logInsert: ReturnType<DatabaseSync["prepare"]>;
	/**
	 * The next sequence number per agent, kept in memory.
	 *
	 * Reading this back with `SELECT MAX(seq)` on every line meant a full
	 * aggregate query per line of agent output, which is the difference between a
	 * dashboard that keeps up with a chatty agent and one that falls minutes
	 * behind. Seeded from the table on first use, so an existing log still
	 * continues its numbering rather than restarting and colliding with it.
	 */
	private readonly logSeq = new Map<string, number>();

	constructor(options: { path: string }) {
		if (options.path !== ":memory:")
			mkdirSync(dirname(options.path), { recursive: true });
		this.db = new DatabaseSync(options.path);
		this.db.exec("PRAGMA journal_mode = WAL");
		/**
		 * `NORMAL`, which under WAL means a commit is not flushed to disk on its own.
		 *
		 * The default is `FULL`, which fsyncs every commit — and this store commits
		 * once per line of agent output, so a chatty run paid thousands of fsyncs
		 * to stream text that is worthless the moment it is lost to an OS crash.
		 * `NORMAL` still survives an application crash intact, which is the failure
		 * this database actually has to handle.
		 */
		this.db.exec("PRAGMA synchronous = NORMAL");
		this.db.exec("PRAGMA busy_timeout = 5000");
		this.db.exec("PRAGMA foreign_keys = ON");
		this.db.exec(SCHEMA);
		this.migrate();
		this.logInsert = this.db.prepare(
			"INSERT OR REPLACE INTO agent_logs (agent_id, seq, at, stream, text) VALUES (?, ?, ?, ?, ?)",
		);
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
			const existing = this.db
				.prepare(`PRAGMA table_info(${table})`)
				.all() as Array<{ name: string }>;
			if (existing.some((entry) => entry.name === column)) continue;
			this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
		}
		// Indexes over the new columns come last, because an index on a column that
		// does not exist yet fails the whole open — and a Studio that refuses to start
		// because it was last run last week is the worst possible version of this bug.
		this.db.exec(
			"CREATE INDEX IF NOT EXISTS traces_agent_idx ON traces (agent_id, start_time DESC)",
		);
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
					typeof root?.attributes["nah.cost.usd"] === "number"
						? root.attributes["nah.cost.usd"]
						: null,
					typeof root?.attributes["gen_ai.usage.input_tokens"] === "number"
						? root.attributes["gen_ai.usage.input_tokens"]
						: null,
					typeof root?.attributes["gen_ai.usage.output_tokens"] === "number"
						? root.attributes["gen_ai.usage.output_tokens"]
						: null,
					agentId,
				);

			this.writeSpans(spans);
			this.db.exec("COMMIT");
		} catch (error) {
			this.db.exec("ROLLBACK");
			throw error;
		}
		// After the commit, so nobody is told about a trace that was rolled back.
		this.emit({ type: "trace", trace: { ...trace, agentId }, agentId });
	}

	/**
	 * Write spans, replacing any with the same id.
	 *
	 * `id` is the spans table's primary key, so this is idempotent: the same span
	 * arriving twice — a retried request, a client that re-sent after a timeout it
	 * never saw the answer to — lands on the same row rather than twice.
	 */
	private writeSpans(spans: Span[]): void {
		if (spans.length === 0) return;
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
	}

	/**
	 * Add spans to a trace that is still running, without disturbing what is there.
	 *
	 * `saveTrace` is the finished-run write: it deletes every span for the trace
	 * and reinserts the set it was handed, because a trace id is replaced wholesale
	 * when an experiment re-runs its cases. That is exactly wrong for a run in
	 * flight — a partial upload would delete every span it did not carry, so a
	 * waterfall that is only ever growing would flicker instead.
	 *
	 * So this is the merge half. Upsert by span id, delete nothing.
	 *
	 * The trace row is written once, when the run first reports, and then never
	 * updated. Nothing about a running trace row changes until the run is over, and
	 * a partial write is the one thing that could make a finished trace go back to
	 * looking like it is still going: `end_time`, `status`, and the token and cost
	 * columns are all final-run facts, and `saveTrace` writes them at the end.
	 */
	appendSpans(
		trace: Trace,
		spans: Span[],
		agentId: string | null = null,
	): void {
		const root = spans.find((span) => span.id === trace.rootSpanId);
		this.db.exec("BEGIN IMMEDIATE");
		try {
			// `OR IGNORE` rather than `OR REPLACE`, and see above: an existing row is
			// a fact already established, not an older version to overwrite.
			this.db
				.prepare(
					`INSERT OR IGNORE INTO traces
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
					typeof root?.attributes["nah.cost.usd"] === "number"
						? root.attributes["nah.cost.usd"]
						: null,
					typeof root?.attributes["gen_ai.usage.input_tokens"] === "number"
						? root.attributes["gen_ai.usage.input_tokens"]
						: null,
					typeof root?.attributes["gen_ai.usage.output_tokens"] === "number"
						? root.attributes["gen_ai.usage.output_tokens"]
						: null,
					agentId,
				);
			this.writeSpans(spans);
			this.db.exec("COMMIT");
		} catch (error) {
			this.db.exec("ROLLBACK");
			throw error;
		}
		// After the commit, for the same reason `saveTrace` is: a rolled-back write
		// that was announced would leave the dashboard drawing a trace that is not there.
		this.emit({ type: "trace", trace: { ...trace, agentId }, agentId });
	}

	/**
	 * Report a run that began and never said how it ended.
	 *
	 * A client pushes a trace in pieces while it runs, then once more when it is
	 * over. Nothing ever writes "this run was interrupted": a process that is
	 * killed, or a Studio restarted mid-request, simply stops sending. The row
	 * keeps the shape its first partial gave it — no end time, `unset` — and would
	 * sit in the list forever claiming to be running, which is the one thing an
	 * observability tool must never do.
	 *
	 * So decide at read time, the way `ageOut` decides an agent's liveness, rather
	 * than running a sweeper. Every ingest bumps the agent's `last_seen_at`, so a
	 * run that is still going keeps bumping it and one that is dead goes quiet:
	 * the same signal the live dot uses, asked a different question.
	 *
	 * Reported as `interrupted`, which is deliberately not `error`: nothing said
	 * this run failed, only that it stopped. Folding it into `error` would make a
	 * Studio full of killed runs indistinguishable from a Studio full of broken
	 * ones. Only the status is rewritten — the end time is left absent rather than
	 * invented, because a made-up duration is a number somebody would trust.
	 */
	private ageInterrupted(
		trace: TraceRow,
		livenessMs: number | undefined,
	): TraceRow {
		if (livenessMs === undefined) return trace;
		// A finished trace is the client's own final word.
		if (trace.endTime !== null) return trace;
		// A trace with no agent has nobody to go quiet. The built-in agent writes
		// here directly, so an open trace of its making proves nothing either way.
		if (!trace.agentId) return trace;
		const agent = this.db
			.prepare("SELECT last_seen_at, status FROM agents WHERE id = ?")
			.get(trace.agentId) as
			| { last_seen_at: number; status: string }
			| undefined;
		if (!agent) return trace;
		// Only a live-and-then-silent agent says anything. An agent that stopped
		// cleanly left its traces closed by their own final posts.
		if (agent.status !== "running" && agent.status !== "starting") return trace;
		if (agent.last_seen_at >= now() - livenessMs) return trace;
		return { ...trace, status: "interrupted" };
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
			/** Age out runs that never reported an ending. Off when omitted. */
			livenessMs?: number;
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
		const column =
			{ startTime: "start_time", name: "name", costUsd: "cost_usd" }[
				filter.sort ?? "startTime"
			] ?? "start_time";
		const direction = filter.order === "asc" ? "ASC" : "DESC";
		const rows = this.db
			.prepare(
				`SELECT * FROM traces ${where} ORDER BY ${column} ${direction} NULLS LAST, start_time DESC LIMIT ?`,
			)
			.all(...params, filter.limit ?? 50) as Array<Record<string, unknown>>;
		return rows
			.map((row) => {
				const trace: TraceRow = {
					id: String(row.id),
					name: String(row.name),
					startTime: Number(row.start_time),
					endTime: row.end_time === null ? null : Number(row.end_time),
					rootSpanId: String(row.root_span_id),
					status: String(row.status) as Trace["status"],
					tags: parseJson<string[]>(row.tags, []),
					metadata: parseJson<Record<string, unknown>>(row.metadata, {}),
					...(row.error === null
						? {}
						: { error: parseJson(row.error, undefined) }),
					...(row.cost_usd === null ? {} : { costUsd: Number(row.cost_usd) }),
					...(row.input_tokens === null
						? {}
						: { inputTokens: Number(row.input_tokens) }),
					...(row.output_tokens === null
						? {}
						: { outputTokens: Number(row.output_tokens) }),
					...(row.agent_id === null ? {} : { agentId: String(row.agent_id) }),
				};
				return this.ageInterrupted(trace, filter.livenessMs);
			})
			.filter((trace) => (filter.tag ? trace.tags.includes(filter.tag) : true));
	}

	getTrace(
		id: string,
		options: { livenessMs?: number } = {},
	): { trace: TraceRow; spans: Span[] } | null {
		// Read the trace directly rather than through the list, which sorts and
		// limits: a trace opened by id must be found whatever its age.
		const row = this.db.prepare("SELECT * FROM traces WHERE id = ?").get(id) as
			| Record<string, unknown>
			| undefined;
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
			...(row.input_tokens === null
				? {}
				: { inputTokens: Number(row.input_tokens) }),
			...(row.output_tokens === null
				? {}
				: { outputTokens: Number(row.output_tokens) }),
			...(row.agent_id === null ? {} : { agentId: String(row.agent_id) }),
		};
		const spans = this.db
			.prepare("SELECT * FROM spans WHERE trace_id = ? ORDER BY start_time ASC")
			.all(id) as Array<Record<string, unknown>>;
		return {
			trace: this.ageInterrupted(trace, options.livenessMs),
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
				...(span.output === null
					? {}
					: { output: parseJson(span.output, null) }),
				...(span.error === null
					? {}
					: { error: parseJson(span.error, undefined) }),
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
	timeseries(
		buckets = 24,
		filter: { agentId?: string } = {},
	): Array<{
		t: number;
		traces: number;
		errors: number;
		costUsd: number;
		medianMs: number;
	}> {
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
				: this.db
						.prepare(
							"SELECT start_time, status, cost_usd, end_time FROM traces ORDER BY start_time ASC",
						)
						.all()
		) as Array<{
			start_time: number;
			status: string;
			cost_usd: number | null;
			end_time: number | null;
		}>;
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
			const index = Math.min(
				buckets - 1,
				Math.max(0, Math.floor((row.start_time - oldest) / width)),
			);
			const bucket = series[index]!;
			bucket.traces += 1;
			if (row.status === "error") bucket.errors += 1;
			bucket.costUsd += row.cost_usd ?? 0;
			if (row.end_time !== null)
				bucket.durations.push(row.end_time - row.start_time);
		}
		return series.map((bucket) => {
			const sorted = bucket.durations.sort((a, b) => a - b);
			return {
				t: bucket.t,
				traces: bucket.traces,
				errors: bucket.errors,
				costUsd: Number(bucket.costUsd.toFixed(6)),
				medianMs:
					sorted.length === 0
						? 0
						: (sorted[Math.floor(sorted.length / 2)] ?? 0),
			};
		});
	}

	/**
	 * Per-tool aggregates across every trace.
	 *
	 * "Which tool is slow or failing" is a question about the whole history, not
	 * about one run, so it is answered in SQL rather than by loading spans.
	 */
	toolStats(filter: { agentId?: string } = {}): Array<{
		tool: string;
		calls: number;
		errors: number;
		errorRate: number;
		p50Ms: number;
		p95Ms: number;
		totalMs: number;
	}> {
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
		const scope = filter.agentId
			? "AND s.trace_id IN (SELECT id FROM traces WHERE agent_id = ?)"
			: "";
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
			.all(...scoped) as Array<{
			tool: string;
			calls: number;
			errors: number;
			total_ms: number;
		}>;

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
			const at = (fraction: number) =>
				durations[
					Math.min(
						durations.length - 1,
						Math.floor(durations.length * fraction),
					)
				] ?? 0;
			return {
				tool: row.tool,
				calls: row.calls,
				errors: row.errors,
				errorRate:
					row.calls === 0 ? 0 : Number((row.errors / row.calls).toFixed(4)),
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
			.get(...scoped) as {
			n: number;
			errors: number;
			cost: number;
			input_tokens: number;
			output_tokens: number;
		};
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
			name:
				registration.name?.trim() ||
				existing?.name ||
				basename(registration.cwd),
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
			stoppedAt:
				registration.status === "running"
					? null
					: (existing?.stoppedAt ?? null),
			exitCode:
				registration.status === "running" ? null : (existing?.exitCode ?? null),
			metadata: {
				...(existing?.metadata ?? {}),
				...(registration.metadata ?? {}),
			},
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
	setAgentState(
		id: string,
		patch: {
			status?: AgentStatus;
			exitCode?: number | null;
			metadata?: Record<string, unknown>;
		},
	): Agent | null {
		const existing = this.getAgent(id);
		if (!existing) return null;
		const ended =
			patch.status === "exited" ||
			patch.status === "stopped" ||
			patch.status === "failed";
		const agent: Agent = {
			...existing,
			status: patch.status ?? existing.status,
			exitCode: patch.exitCode ?? existing.exitCode,
			stoppedAt: ended ? now() : existing.stoppedAt,
			lastSeenAt: now(),
			metadata:
				patch.metadata === undefined
					? existing.metadata
					: { ...existing.metadata, ...patch.metadata },
		};
		this.db
			.prepare(
				"UPDATE agents SET status = ?, exit_code = ?, stopped_at = ?, last_seen_at = ?, metadata = ? WHERE id = ?",
			)
			.run(
				agent.status,
				agent.exitCode,
				agent.stoppedAt,
				agent.lastSeenAt,
				JSON.stringify(agent.metadata),
				agent.id,
			);
		this.emit({ type: "agent", agentId: agent.id });
		return agent;
	}

	getAgent(id: string): Agent | null {
		const row = this.db.prepare("SELECT * FROM agents WHERE id = ?").get(id) as
			| Record<string, unknown>
			| undefined;
		return row ? toAgent(row) : null;
	}

	/**
	 * Agents, each with its own totals, newest activity first.
	 *
	 * `runningBefore` is what makes the online dot honest: a process that stopped
	 * reporting is offline even though nothing ever wrote "offline", because a
	 * machine that was unplugged cannot file that report.
	 */
	listAgents(
		filter: { runningBefore?: number; cwd?: string } = {},
	): AgentSummary[] {
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

	private summarize(
		row: Record<string, unknown>,
		runningBefore: number | undefined,
	): AgentSummary {
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
			medianDurationMs:
				durations.length === 0
					? 0
					: (durations[Math.floor(durations.length / 2)] ?? 0),
			lastTraceAt:
				row.last_trace === null || row.last_trace === undefined
					? null
					: Number(row.last_trace),
		};
	}

	deleteAgent(id: string): boolean {
		// The traces stay. Removing an agent is how you tidy the list, not how you
		// erase what it did, and a row of traces with a missing agent is still
		// readable history.
		this.db.prepare("DELETE FROM agent_logs WHERE agent_id = ?").run(id);
		// The rows are gone, so the cached high-water mark has nothing to seed from
		// and would keep counting numbers the table never issued.
		this.logSeq.delete(id);
		const result = this.db.prepare("DELETE FROM agents WHERE id = ?").run(id);
		return Number(result.changes ?? 0) > 0;
	}

	/** Append one line of an agent's output, and hand it to whoever is watching. */
	appendAgentLog(
		agentId: string,
		line: { stream: "stdout" | "stderr" | "system"; text: string },
	): AgentLogLine {
		const entry: AgentLogLine = {
			seq: this.takeLogSeq(agentId),
			at: now(),
			stream: line.stream,
			text: line.text,
		};
		this.logInsert.run(agentId, entry.seq, entry.at, entry.stream, entry.text);
		// Emitted after the row exists, so a watcher that reacts by reading the log
		// back cannot race ahead of the write.
		this.emit({ type: "log", agentId, line: entry });
		return entry;
	}

	/**
	 * The next sequence number for an agent, without asking the table.
	 *
	 * This used to be a `SELECT MAX(seq)` per line — a full aggregate query for
	 * every line of agent output, on the path that decides how fast the dashboard
	 * keeps up with a chatty agent. Seeded from the table the first time an agent
	 * logs, so a Studio that already had lines continues their numbering instead
	 * of handing out a 1 that would `INSERT OR REPLACE` over a real one.
	 */
	private takeLogSeq(agentId: string): number {
		let next = this.logSeq.get(agentId);
		if (next === undefined) {
			const row = this.db
				.prepare(
					"SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM agent_logs WHERE agent_id = ?",
				)
				.get(agentId) as { next?: number } | undefined;
			// A log line numbered from 1 is as readable as one numbered from 0.
			next = Number(row?.next ?? 1);
		}
		this.logSeq.set(agentId, next + 1);
		return next;
	}

	listAgentLogs(agentId: string, limit = 500): AgentLogLine[] {
		const rows = this.db
			.prepare(
				"SELECT seq, at, stream, text FROM agent_logs WHERE agent_id = ? ORDER BY seq DESC LIMIT ?",
			)
			.all(agentId, limit) as Array<{
			seq: number;
			at: number;
			stream: string;
			text: string;
		}>;
		return rows
			.map((row) => ({
				seq: Number(row.seq),
				at: Number(row.at),
				stream: row.stream as AgentLogLine["stream"],
				text: String(row.text),
			}))
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
			.prepare(
				"DELETE FROM agents WHERE last_seen_at < ? AND status NOT IN ('running', 'starting')",
			)
			.run(cutoff);
		this.db
			.prepare(
				"DELETE FROM agent_logs WHERE agent_id NOT IN (SELECT id FROM agents)",
			)
			.run();
		/**
		 * Logs were just deleted for agents that are gone, so every cached
		 * high-water mark is now counting rows that no longer exist. Dropped whole
		 * rather than pruned per agent: re-seeding costs one aggregate query, and
		 * this runs on a timer, not on the log path.
		 */
		this.logSeq.clear();
		return Number(result.changes ?? 0);
	}

	saveMessage(message: {
		id: string;
		traceId?: string;
		agentId?: string;
		role: string;
		content: string;
		metadata?: Record<string, unknown>;
	}): void {
		this.db
			.prepare(
				`INSERT OR REPLACE INTO messages (id, trace_id, agent_id, role, content, created_at, metadata)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(
				message.id,
				message.traceId ?? null,
				message.agentId ?? null,
				message.role,
				message.content,
				now(),
				JSON.stringify(message.metadata ?? {}),
			);
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
			.prepare(
				`SELECT rowid AS seq, * FROM messages ${where} ORDER BY created_at DESC, seq DESC LIMIT ?`,
			)
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
		const result = this.db
			.prepare("DELETE FROM traces WHERE start_time < ?")
			.run(cutoff);
		this.db
			.prepare(
				"DELETE FROM spans WHERE trace_id NOT IN (SELECT id FROM traces)",
			)
			.run();
		return Number(result.changes ?? 0);
	}

	// --- datasets -------------------------------------------------------------

	createDataset(input: { id?: string; name: string; description?: string }): {
		id: string;
		version: number;
	} {
		const id = input.id ?? `ds_${Math.random().toString(36).slice(2, 10)}`;
		this.db
			.prepare(
				"INSERT INTO datasets (id, name, description, version, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?)",
			)
			.run(id, input.name, input.description ?? "", now(), now());
		return { id, version: 1 };
	}

	listDatasets(): Array<{
		id: string;
		name: string;
		description: string;
		version: number;
		items: number;
	}> {
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

	addDatasetItems(
		datasetId: string,
		items: Array<{
			id?: string;
			input: string;
			expected?: string;
			metadata?: Record<string, unknown>;
		}>,
	): number {
		const existing = this.db
			.prepare(
				"SELECT COALESCE(MAX(position), -1) AS max FROM dataset_items WHERE dataset_id = ?",
			)
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
			this.db
				.prepare(
					"UPDATE datasets SET version = version + 1, updated_at = ? WHERE id = ?",
				)
				.run(now(), datasetId);
			this.db.exec("COMMIT");
		} catch (error) {
			this.db.exec("ROLLBACK");
			throw error;
		}
		return added;
	}

	listDatasetItems(datasetId: string): DatasetItem[] {
		const rows = this.db
			.prepare(
				"SELECT * FROM dataset_items WHERE dataset_id = ? ORDER BY position ASC",
			)
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
		return (
			Number(
				this.db.prepare("DELETE FROM datasets WHERE id = ?").run(id).changes ??
					0,
			) > 0
		);
	}

	// --- scorers --------------------------------------------------------------

	saveScorer(scorer: {
		id: string;
		name: string;
		description?: string;
		kind: string;
		config?: Record<string, unknown>;
	}): void {
		this.db
			.prepare(
				"INSERT OR REPLACE INTO scorers (id, name, description, kind, config, created_at) VALUES (?, ?, ?, ?, ?, ?)",
			)
			.run(
				scorer.id,
				scorer.name,
				scorer.description ?? "",
				scorer.kind,
				JSON.stringify(scorer.config ?? {}),
				now(),
			);
	}

	listScorers(): Array<{
		id: string;
		name: string;
		description: string;
		kind: string;
		config: Record<string, unknown>;
	}> {
		const rows = this.db
			.prepare("SELECT * FROM scorers ORDER BY name ASC")
			.all() as Array<Record<string, unknown>>;
		return rows.map((row) => ({
			id: String(row.id),
			name: String(row.name),
			description: String(row.description),
			kind: String(row.kind),
			config: parseJson<Record<string, unknown>>(row.config, {}),
		}));
	}

	// --- experiments ----------------------------------------------------------

	startExperiment(input: {
		id?: string;
		datasetId: string;
		model: string;
	}): string {
		const id = input.id ?? `ex_${Math.random().toString(36).slice(2, 10)}`;
		this.db
			.prepare(
				"INSERT INTO experiments (id, dataset_id, status, model, started_at) VALUES (?, ?, 'running', ?, ?)",
			)
			.run(id, input.datasetId, input.model, now());
		return id;
	}

	saveExperimentResult(
		result: ExperimentResult & { experimentId: string },
	): void {
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

	finishExperiment(
		id: string,
		summary: Record<string, unknown>,
		error?: string,
	): void {
		this.db
			.prepare(
				"UPDATE experiments SET status = ?, finished_at = ?, summary = ?, error = ? WHERE id = ?",
			)
			.run(
				error === undefined ? "completed" : "failed",
				now(),
				JSON.stringify(summary),
				error ?? null,
				id,
			);
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
		const row = this.db
			.prepare("SELECT * FROM experiments WHERE id = ?")
			.get(id) as Record<string, unknown> | undefined;
		if (!row) return null;
		const items = this.db
			.prepare(
				"SELECT * FROM experiment_results WHERE experiment_id = ? ORDER BY created_at ASC",
			)
			.all(id) as Array<Record<string, unknown>>;
		const inputs = new Map(
			this.listDatasetItems(String(row.dataset_id)).map((item) => [
				item.id,
				item.input,
			]),
		);
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

	listExperiments(limit = 20): Array<{
		id: string;
		datasetId: string;
		status: string;
		model: string;
		startedAt: number;
		finishedAt: number | null;
		summary: Record<string, unknown>;
	}> {
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

	/**
	 * Record a run that is about to start, with its steps laid out as pending.
	 *
	 * The rows exist before the first step does, so the canvas can draw the whole
	 * graph the moment a run starts rather than filling in as steps report — which
	 * is the difference between watching a sequence and watching things appear.
	 */
	startWorkflowRun(run: {
		runId: string;
		workflowId: string;
		input: unknown;
		model: string | null;
		steps: readonly string[];
	}): void {
		this.db.exec("BEGIN IMMEDIATE");
		try {
			this.db
				.prepare(
					`INSERT OR REPLACE INTO workflow_runs (id, workflow_id, status, input, started_at, model)
           VALUES (?, ?, 'running', ?, ?, ?)`,
				)
				.run(
					run.runId,
					run.workflowId,
					JSON.stringify(run.input ?? null),
					now(),
					run.model,
				);
			const insert = this.db.prepare(
				`INSERT OR REPLACE INTO workflow_steps (run_id, step_id, status) VALUES (?, ?, 'pending')`,
			);
			for (const stepId of run.steps) insert.run(run.runId, stepId);
			this.db.exec("COMMIT");
		} catch (error) {
			this.db.exec("ROLLBACK");
			throw error;
		}
	}

	/**
	 * Record one step's progress.
	 *
	 * A patch rather than a whole record because the run reports pieces of a step
	 * separately — started, text, then finished — and writing the row whole each
	 * time would mean re-reading it to preserve the parts the latest event did not
	 * mention.
	 */
	updateWorkflowStep(
		runId: string,
		stepId: string,
		patch: {
			status?: WorkflowStepStatus;
			startedAt?: number | null;
			finishedAt?: number | null;
			durationMs?: number | null;
			input?: unknown;
			output?: unknown;
			error?: string | null;
			text?: string;
		},
	): void {
		const existing = this.workflowStep(runId, stepId);
		const columns: string[] = [];
		const params: Array<string | number | null> = [];
		const set = (column: string, value: string | number | null): void => {
			columns.push(`${column} = ?`);
			params.push(value);
		};
		if (patch.status !== undefined) set("status", patch.status);
		if (patch.startedAt !== undefined) set("started_at", patch.startedAt);
		if (patch.finishedAt !== undefined) set("finished_at", patch.finishedAt);
		if (patch.durationMs !== undefined) set("duration_ms", patch.durationMs);
		if (patch.input !== undefined)
			set("input", JSON.stringify(patch.input ?? null));
		if (patch.output !== undefined)
			set("output", JSON.stringify(patch.output ?? null));
		if (patch.error !== undefined) set("error", patch.error);
		// Appended, not replaced: a step streams its answer in pieces, and the last
		// piece alone is not what the step said.
		if (patch.text !== undefined)
			set("text", `${existing?.text ?? ""}${patch.text}`);
		if (columns.length === 0) return;
		params.push(runId, stepId);
		this.db
			.prepare(
				`UPDATE workflow_steps SET ${columns.join(", ")} WHERE run_id = ? AND step_id = ?`,
			)
			.run(...params);
	}

	finishWorkflowRun(
		runId: string,
		outcome: { status: WorkflowRunStatus; output?: unknown; error?: string },
	): void {
		this.db
			.prepare(
				"UPDATE workflow_runs SET status = ?, output = ?, error = ?, finished_at = ? WHERE id = ?",
			)
			.run(
				outcome.status,
				outcome.output === undefined
					? null
					: JSON.stringify(outcome.output ?? null),
				outcome.error ?? null,
				now(),
				runId,
			);
	}

	private workflowStep(
		runId: string,
		stepId: string,
	): WorkflowStepRecord | null {
		const row = this.db
			.prepare("SELECT * FROM workflow_steps WHERE run_id = ? AND step_id = ?")
			.get(runId, stepId) as Record<string, unknown> | undefined;
		return row ? toWorkflowStep(row) : null;
	}

	listWorkflowSteps(runId: string): WorkflowStepRecord[] {
		const rows = this.db
			.prepare(
				"SELECT * FROM workflow_steps WHERE run_id = ? ORDER BY started_at ASC, step_id ASC",
			)
			.all(runId) as Array<Record<string, unknown>>;
		return rows.map(toWorkflowStep);
	}

	listWorkflowRuns(
		filter: { workflowId?: string; limit?: number } = {},
	): WorkflowRunSummary[] {
		const where = filter.workflowId ? "WHERE r.workflow_id = ?" : "";
		const params = filter.workflowId ? [filter.workflowId] : [];
		const rows = this.db
			.prepare(
				`SELECT r.*, COUNT(s.step_id) AS steps,
                SUM(CASE WHEN s.started_at IS NOT NULL THEN 1 ELSE 0 END) AS started
         FROM workflow_runs r
         LEFT JOIN workflow_steps s ON s.run_id = r.id
         ${where}
         GROUP BY r.id
         ORDER BY r.started_at DESC
         LIMIT ?`,
			)
			.all(...params, filter.limit ?? 50) as Array<Record<string, unknown>>;
		return rows.map(toWorkflowRun);
	}

	getWorkflowRun(runId: string): WorkflowRunDetail | null {
		const row = this.db
			.prepare("SELECT * FROM workflow_runs WHERE id = ?")
			.get(runId) as Record<string, unknown> | undefined;
		if (!row) return null;
		const counts = this.db
			.prepare(
				`SELECT COUNT(step_id) AS steps,
                SUM(CASE WHEN started_at IS NOT NULL THEN 1 ELSE 0 END) AS started
         FROM workflow_steps WHERE run_id = ?`,
			)
			.get(runId) as Record<string, unknown>;
		return {
			...toWorkflowRun({ ...row, ...counts }),
			records: this.listWorkflowSteps(runId),
		};
	}

	close(): void {
		this.db.close();
	}
}
