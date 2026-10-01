/**
 * The cognitive layer.
 *
 * Everything that decides *what* to remember, *what* to put in front of a model,
 * and *whether* a new statement says something new — with no database, no
 * network, and no model in the retrieval path.
 *
 * That last part is the design constraint everything else follows from. A memory
 * layer whose recall quality moves with provider availability is not a storage
 * layer, it is a demo, so ranking, merge safety and index budgeting are all
 * deterministic functions of the text in front of them.
 *
 * `CognitiveMemory` is the in-process implementation: four Maps, snapshots to
 * and from JSON, no I/O beyond what you give it. The service is the same
 * decisions with the tiers in a database, which is why the primitives below are
 * shared rather than reimplemented.
 */

export { CognitiveMemory } from "./memory.js"

export { runFastGate, extractDomains, type FastGateResult } from "./fast-gate.js"

export {
  extractDeterministic,
  type DeterministicMemory
} from "./rules.js"

export {
  CANDIDATE_FLOOR,
  COLLAPSE_THRESHOLD,
  MAX_CANDIDATES,
  PROMOTE_THRESHOLD,
  distinctiveTokens,
  estimateTokens,
  extractIdentifiers,
  gistOf,
  isInteractionScoped,
  isLossyRewrite,
  normalise,
  overlapScore,
  relevanceTokens,
  similarity
} from "./relevance.js"

export type {
  MemoryTier,
  TensionStatus,
  TensionImpact,
  KnowledgeTension,
  DomainCapability,
  ProprioceptiveSelfModel,
  MemoryMetadata,
  MemoryItem,
  TrajectoryPrediction,
  MemoryInclusionReason,
  MemoryInclusionReason as InclusionReason,
  MemoryInjectionEntry,
  MemoryInjectionReport,
  MemoryReconciliation,
  ArbiterEvaluationResult,
  ArbiterFn,
  CognitiveMemoryOptions,
  CognitiveMemoryStateSnapshot
} from "./types.js"
