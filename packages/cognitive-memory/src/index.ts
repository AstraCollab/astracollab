/**
 * @astracollab/cogmem — Cognitive Memory for agents.
 *
 * Two things in one package, deliberately:
 *
 * 1. **A client** for the Cognitive Memory service, for agents that call memory
 *    over HTTP.
 * 2. **The cognitive layer itself** — the deterministic decisions about what to
 *    store, what to inject, and whether a new statement is new. No database, no
 *    network, no model in the retrieval path.
 *
 * Shipping both means a consumer can start with the service and later run the
 * same logic in-process, or run it only in-process, without the behaviour
 * changing underneath them. The primitives are the reason the two cannot drift.
 *
 * The exports are arranged for tree-shaking: importing `createClient` alone does
 * not pull in the in-process engine, and the model-backed arbiter — which needs
 * `ai` and `zod` — is a separate entry point so those stay optional peers.
 */

// ---------------------------------------------------------------------------
// The service client
// ---------------------------------------------------------------------------
export { Cogmem, createClient } from "./cogmem"
export { createHttpClient, type HttpClient } from "./client"
export { CognitiveMemoryError } from "./errors"

// Helpers — the workflows that encode best practice
export {
  runTurn,
  recallOrExplain,
  seedMemories,
  type TurnOptions,
  type RunTurnResult,
  type RecallOrExplainOptions,
  type SeedOptions
} from "./helpers/turn"

// Resources, for advanced use and for testing
export { MemoriesResource } from "./resources/memories"
export { ContextResource } from "./resources/context"
export { RecallResource } from "./resources/recall"
export { TurnsResource } from "./resources/turns"
export { TensionsResource } from "./resources/tensions"
export { SelfModelResource } from "./resources/self-model"
export { StatsResource, fetchHealth } from "./resources/stats"

// ---------------------------------------------------------------------------
// The cognitive layer — runnable in-process
// ---------------------------------------------------------------------------
export { CognitiveMemory, runFastGate, extractDomains } from "./cognitive"
export {
  extractDeterministic,
  relevanceTokens,
  overlapScore,
  distinctiveTokens,
  isLossyRewrite,
  extractIdentifiers,
  isInteractionScoped,
  similarity,
  normalise,
  estimateTokens,
  gistOf,
  CANDIDATE_FLOOR,
  COLLAPSE_THRESHOLD,
  MAX_CANDIDATES,
  PROMOTE_THRESHOLD
} from "./cognitive"
export type { FastGateResult, DeterministicMemory } from "./cognitive"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

// The client's wire types.
export type {
  Memory,
  MemoryTier,
  MemorySource,
  Impact,
  TensionStatus,
  InclusionReason,
  Scope,
  RecallHit,
  ContextEntry,
  ContextReport,
  LearnResult,
  RejectedStatement,
  Claim,
  Tension,
  DomainCapability,
  SelfModel,
  Health,
  Stats,
  RememberRequest,
  ListMemoriesParams,
  RecallRequest,
  RecallResponse,
  TurnRequest,
  ContextRequest,
  AddTensionRequest,
  ResolveTensionRequest,
  DomainOutcomeRequest,
  CognitiveMemoryConfig,
  CognitiveMemoryErrorBody
} from "./types"

/*
 * The cognitive layer's own vocabulary, under its own names.
 *
 * No prefixing was necessary: the client's types are `Memory`, `Impact`,
 * `Tension` and `SelfModel`, and the layer's are `MemoryItem`, `TensionImpact`,
 * `KnowledgeTension` and `ProprioceptiveSelfModel`. The only genuine overlap is
 * `MemoryTier`, `TensionStatus` and `DomainCapability`, which are identical in
 * both — the same field names and the same string values — so the client's
 * copies above are the canonical ones and are not re-exported here.
 */
export type {
  MemoryItem,
  MemoryMetadata,
  MemoryInclusionReason,
  MemoryInjectionEntry,
  MemoryInjectionReport,
  MemoryReconciliation,
  MemoryTier as CognitiveMemoryTier,
  KnowledgeTension,
  ProprioceptiveSelfModel,
  TrajectoryPrediction,
  TensionImpact,
  ArbiterEvaluationResult,
  ArbiterFn,
  CognitiveMemoryOptions,
  CognitiveMemoryStateSnapshot
} from "./cognitive"
