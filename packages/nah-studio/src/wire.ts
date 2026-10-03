/**
 * The wire contract: what the Studio's API sends and accepts.
 *
 * One file, shared by the server and the UI, because they are one package and two
 * halves of one program.
 *
 * The spans and traces are not re-declared here — they are the engine's own
 * types, imported. That import is the point: an agent running in another process
 * produces these shapes, and if a field is renamed upstream this file stops
 * compiling rather than the dashboard quietly rendering `undefined` for a week.
 * The fields the Studio adds (denormalised cost, the owning agent) are declared
 * on top.
 *
 * Imports are type-only throughout, so nothing here survives into the UI bundle:
 * the contract must not be able to drag `node:sqlite` or React along with it.
 */

import type { Span as EngineSpan, SpanError as EngineSpanError, SpanKind, SpanStatus, Trace as EngineTrace } from "not-another-harness";

export type { SpanKind, SpanStatus };

export type SpanError = EngineSpanError;

export type Span = EngineSpan;

/**
 * A trace as stored.
 *
 * `costUsd` and the token counts are copied off the root span on the way in, so
 * a list of a thousand traces can be read and totalled without parsing a single
 * span's JSON. `agentId` is who ran it, when anyone knows.
 */
export type Trace = EngineTrace & {
  costUsd?: number;
  inputTokens?: number;
  outputTokens?: number;
  agentId?: string | null;
};

export type TraceDetail = { trace: Trace; spans: Span[] };

export type Overview = {
  traces: number;
  errors: number;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  medianDurationMs: number;
  /** One bucket per point, oldest first, for the sparklines. */
  timeseries?: Array<{
    t: number;
    traces: number;
    errors: number;
    costUsd: number;
    medianMs: number;
  }>;
};

export type ToolStat = {
  tool: string;
  calls: number;
  errors: number;
  errorRate: number;
  p50Ms: number;
  p95Ms: number;
  totalMs: number;
};

/**
 * A live agent.
 *
 * One row per process, not per project: two `nah` sessions in one repository are
 * two agents, and a dashboard that cannot tell them apart cannot answer "is
 * anything running right now". `name` is the friendly grouping key, and `id` is
 * what traces and logs point at.
 */
export type AgentStatus =
  /** Registered, first heartbeat not yet sent. */
  | "starting"
  /** Heartbeating, currently between turns or working. */
  | "running"
  /** Alive but quiet for a while. */
  | "idle"
  /** The process it launched has finished. */
  | "exited"
  /** The turn it was running failed. */
  | "failed"
  /** Stopped on request. */
  | "stopped";

export type Agent = {
  id: string;
  /** Defaults to the basename of the working directory. */
  name: string;
  cwd: string;
  /** Hostname of the machine the agent runs on. */
  host: string;
  pid: number | null;
  model: string | null;
  /** The agent's own version, so a trace can be read against the code that made it. */
  version: string | null;
  status: AgentStatus;
  /** `session` for one you started yourself, `launch` for one the Studio started. */
  source: "session" | "launch";
  startedAt: number;
  /** Last heartbeat or pushed trace. Drives the online/offline dot. */
  lastSeenAt: number;
  stoppedAt: number | null;
  exitCode: number | null;
  metadata: Record<string, unknown>;
};

/** An agent plus its own totals, which is what a list of agents actually shows. */
export type AgentSummary = Agent & {
  traces: number;
  errors: number;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  medianDurationMs: number;
  lastTraceAt: number | null;
};

/** What an agent says about itself when it registers. */
export type AgentRegistration = {
  /** Reuse to keep one row across re-registrations; generated when absent. */
  id?: string;
  name?: string;
  cwd: string;
  host?: string;
  pid?: number;
  model?: string | null;
  version?: string | null;
  source?: "session" | "launch";
  metadata?: Record<string, unknown>;
};

/** One POST to the ingest endpoint. `agent` is absent for the built-in agent. */
export type IngestPayload = { agent?: AgentRegistration; trace: Trace; spans: Span[] };

export type AgentLogLine = {
  seq: number;
  at: number;
  stream: "stdout" | "stderr" | "system";
  text: string;
};

/**
 * What `GET /api/stream` emits.
 *
 * A discriminated union rather than a generic message so the UI can switch on it,
 * and so an event the UI does not understand is skipped rather than crashing the
 * connection.
 */
export type StreamEvent =
  /** First frame after connecting: the current agent list, so a reload is not blank. */
  | { type: "hello"; agents: AgentSummary[]; at: number }
  | { type: "agent"; agent: AgentSummary }
  | { type: "trace"; trace: Trace }
  | { type: "log"; agentId: string; line: AgentLogLine }
  /** Keep-alive, so an idle dashboard is not mistaken for a dead server. */
  | { type: "pong"; at: number };

export type Message = {
  id: string;
  traceId?: string;
  role: string;
  content: string;
  createdAt: number;
  /**
   * Insertion order. `createdAt` is millisecond-resolution, and both halves of a
   * short turn can share one, so a thread is rebuilt from this instead.
   */
  seq: number;
  agentId?: string | null;
};

export type Dataset = { id: string; name: string; description: string; version: number; items: number };

export type DatasetItem = {
  id: string;
  input: string;
  expected?: string;
  metadata: Record<string, unknown>;
};

export type Scorer = { id: string; name: string; description: string; kind: string; config: Record<string, unknown> };

export type ScoreRecord = { scorerId: string; score: number; reason?: string; skipped?: boolean };

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
  attempts: number;
};

export type ScorerSummary = {
  mean: number | null;
  scored: number;
  skipped: number;
  reasons: string[];
};

export type ExperimentSummary = {
  items?: number;
  passed?: number;
  failed?: number;
  errored?: number;
  passRate?: number;
  durationMs?: number;
  scorers?: Record<string, ScorerSummary>;
};

export type Experiment = {
  id: string;
  datasetId: string;
  status: "running" | "completed" | "failed";
  model: string;
  startedAt: number;
  finishedAt: number | null;
  summary: ExperimentSummary;
  error?: string;
  results: ExperimentResult[];
};

export type ExperimentSummaryRow = {
  id: string;
  datasetId: string;
  status: string;
  model: string;
  startedAt: number;
  finishedAt: number | null;
  summary: ExperimentSummary;
};

export type ChatResponse = {
  output: string;
  toolsCalled: string[];
  filesChanged: string[];
  traceId?: string;
};
