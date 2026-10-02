/**
 * The API shapes the Studio reads.
 *
 * Re-exported from the server's own contract (`src/wire.ts`) rather than written
 * out again. This used to be a separate package, where duplicating the types was
 * the point: a renamed field on one side had to fail on the other. Now that both
 * halves are one program, the compiler enforces that for free, and a second copy
 * would only be a second thing to forget.
 */

export type {
  Agent,
  AgentLogLine,
  AgentRegistration,
  AgentStatus,
  AgentSummary,
  ChatResponse,
  Dataset,
  DatasetItem,
  Experiment,
  ExperimentResult,
  ExperimentSummary,
  ExperimentSummaryRow,
  IngestPayload,
  Message,
  Overview,
  ScoreRecord,
  Scorer,
  ScorerSummary,
  Span,
  SpanError,
  SpanKind,
  SpanStatus,
  StreamEvent,
  ToolStat,
  Trace,
  TraceDetail,
} from "../src/wire.js";
