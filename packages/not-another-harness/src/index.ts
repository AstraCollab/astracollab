export { runAgent } from "./agent.js";
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
export { DEFAULT_CAPS, capHead, capTail, sliceFileLines, toLines } from "./caps.js";
export { globToRegExp, globStaticPrefix, hasGlobMagic } from "./glob.js";
export { estimateMessageTokens, estimateRequestTokens, estimateTextTokens } from "./estimate.js";
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
  HarnessSteerDelivery,
  HarnessStopReason,
  HarnessUsage,
  ToolEnvironment,
  WorkspaceSnapshot,
  WorkspaceSnapshotEntry,
  WorkspaceRestoreResult,
} from "./types.js";
