export {
  CognitiveMemory,
  extractIdentifiers,
  relevanceTokens,
  overlapScore,
} from "./cognitive-memory.js";
export { runFastGate, extractDomains, type FastGateResult } from "./fast-gate.js";
export { createModelArbiter, type CreateModelArbiterOptions } from "./arbiter.js";
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
  MemoryInjectionEntry,
  MemoryInjectionReport,
  ArbiterEvaluationResult,
  ArbiterFn,
  CognitiveMemoryOptions,
  CognitiveMemoryStateSnapshot,
} from "./types.js";
