export { runAgent } from "./agent.js";
export { sessionUpdate } from "./types.js";
export { compactMessages, alignTailToToolBoundary, type CompactionOutcome } from "./compaction.js";
export {
  cacheAccountingFor,
  cacheOptions,
  contextManagementOptions,
  supportsCaching,
  withCachedTail,
  withCachedToolSchemas,
  MAX_CACHE_BREAKPOINTS,
  TAIL_CACHE_BREAKPOINTS,
  DEFAULT_PINNED_TOOLS,
  type CacheAccounting,
  type CacheControl,
  type ContextEditingOptions,
} from "./cache.js";
export {
  createSpendMeter,
  usageCostUsd,
  type CacheAwareUsage,
  type ModelRates,
} from "./spend.js";
export { buildSystemPrompt } from "./prompt.js";
/*
 * The orchestrator is the multi-agent half of the runtime: a parent agent handing
 * bounded subtasks to isolated children, rather than spending its own context on
 * them. Exported from the root because it is the same contract as `runAgent` —
 * give it a model, a tool factory, and an isolation strategy.
 *
 * `createGitWorktreeIsolation` is exported here too, not from `./node`, because
 * like the JSONL session store it is a Node implementation of a root-level
 * interface rather than a workspace adapter.
 */
export {
  Orchestrator,
  OrchestratorBusyError,
  formatSubtaskReport,
  orchestratorPrompt,
  sharedWorkspaceIsolation,
  createGitWorktreeIsolation,
  type OrchestratorOptions,
  type OrchestratorEvent,
  type OrchestratorWorkflowOptions,
  type WorkflowStepDelegate,
  type SubtaskSpec,
  type SubtaskResult,
  type SubtaskArtifact,
  type SubtaskIsolation,
  type IsolationHandle,
  type GitWorktreeIsolationOptions,
} from "./orchestrator.js";
/*
 * Workflows: task sequences whose order lives in code rather than in a prompt.
 *
 * Exported from the root next to `runAgent` because the two are the same
 * decision in different shapes — hand the work to a model that works it out, or
 * state the steps and keep judgement for the ones that need it. A caller that
 * reaches for a workflow wants the same import path as one that reaches for an
 * agent, not a second entry point to learn first.
 */
export {
  cloneWorkflow,
  createStep,
  createWorkflow,
  createWorkflowRegistry,
  formatWorkflowList,
  isStep,
  StepSuspend,
  workflowStepsSummary,
  type BranchCondition,
  type Workflow,
  type WorkflowBuilder,
  type WorkflowContext,
  type WorkflowEvent,
  type WorkflowNode,
  type WorkflowNodeLike,
  type WorkflowRegistry,
  type WorkflowRun,
  type WorkflowRunOptions,
  type WorkflowResumeOptions,
  type WorkflowRunResult,
  type WorkflowRunStatus,
  type WorkflowSnapshot,
  type WorkflowStep,
  type WorkflowSummary,
  type StepExecuteArgs,
  type StepRecord,
} from "./workflow.js";
export { detectScriptedMutation, type ScriptedMutation } from "./bash-guard.js";
export {
  createSearchLedger,
  createMutationLedger,
  type SearchLedger,
  type SearchRecord,
  type MutationLedger,
} from "./search-ledger.js";
export {
  createCodingTools,
  normalizeWorkspacePath,
  APPROVAL_GATED_TOOLS,
  type CodingToolsOptions,
  type ApprovalDecision,
} from "./tools.js";
export {
  createJsonlSessionStore,
  type JsonlSessionStore,
  type SessionTaskLedger,
  type SessionStepUsage,
  type SessionUsage,
} from "./session.js";
export { DEFAULT_CAPS, capHead, capTail, resolveCaps, sliceFileLines, toLines } from "./caps.js";
export type { CapsOverrides, OutputCaps } from "./caps.js";
export { globToRegExp, globStaticPrefix, hasGlobMagic } from "./glob.js";
export { estimateMessageTokens, estimateRequestTokens, estimateTextTokens } from "./estimate.js";
/*
 * Tracing.
 *
 * Re-exported from the root because it is consumed together with `runAgent` and
 * its event stream, and an event stream you cannot trace is half a contract.
 */
export {
  traceRun,
  memorySink,
  type Span,
  type SpanAttributes,
  type SpanError,
  type SpanKind,
  type SpanStatus,
  type Sampling,
  type TelemetryLimits,
  type TelemetryOptions,
  type TelemetrySink,
  type Trace,
  type TraceContext,
} from "./telemetry.js";
/*
 * The cognitive layer lives in `@astracollab/cogmem`, next to the client for
 * the service that runs it, so the two cannot disagree about what a memory is or
 * when a body earns its tokens.
 *
 * Re-exported here because this package is how the CLI reaches it, and
 * `packages/nah` imports `CognitiveMemory` from this package's public API.
 * Dropping the re-export would break a published package for no gain — new code
 * should import from `@astracollab/cogmem` directly.
 *
 * The arbiter is a separate entry point there because it is the only part needing
 * `ai` and `zod`. This package already peers on both, so re-exporting it keeps the
 * previous surface exactly.
 */
export {
  CognitiveMemory,
  extractDeterministic,
  type DeterministicMemory,
  extractIdentifiers,
  relevanceTokens,
  overlapScore,
  isInteractionScoped,
  runFastGate,
  extractDomains,
  type FastGateResult,
  type MemoryTier,
  type TensionStatus,
  type TensionImpact,
  type KnowledgeTension,
  type DomainCapability,
  type ProprioceptiveSelfModel,
  type MemoryMetadata,
  type MemoryItem,
  type MemoryInclusionReason,
  type MemoryInjectionEntry,
  type MemoryInjectionReport,
  type MemoryReconciliation,
  type TrajectoryPrediction,
  type ArbiterEvaluationResult,
  type ArbiterFn,
  type CognitiveMemoryOptions,
  type CognitiveMemoryStateSnapshot,
} from "@astracollab/cogmem";

export {
  createModelArbiter,
  type CreateModelArbiterOptions
} from "@astracollab/cogmem/arbiter";
export type {
  HarnessEvent,
  HarnessRun,
  HarnessRunOptions,
  HarnessRunResult,
  PrepareStep,
  PrepareStepContext,
  SessionUpdate,
  StepOverrides,
  StepToolChoice,
  HarnessSteerDelivery,
  HarnessStopReason,
  HarnessUsage,
  ToolEnvironment,
  WorkspaceSnapshot,
  WorkspaceSnapshotEntry,
  WorkspaceRestoreResult,
} from "./types.js";
