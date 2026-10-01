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
 * The cognitive layer lives here rather than in a shared package.
 *
 * This package ships as a binary, and a binary that pulls its memory layer from
 * another published package inherits that package's release cadence, its
 * semver, and its breaking changes. It is deliberately self-contained.
 *
 * `packages/cognitive-memory` is the same layer published for the hosted
 * service, and `scripts/sync-cognitive.ts` copies it here; a test in this
 * package fails if the two have drifted. Duplication that CI polices is a
 * different thing from duplication that quietly rots.
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
} from "./cognitive-memory/index.js";

/*
 * The arbiter is imported from its own module rather than through the
 * layer's index, because the published copy keeps it out of the main entry — it
 * is the only part needing `ai` and `zod`. The vendored files stay byte-identical
 * to the published ones, and the export surface of this package is unchanged.
 */
export {
  createModelArbiter,
  type CreateModelArbiterOptions
} from "./cognitive-memory/arbiter.js";
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
