/**
 * @astracollab/cogmem — the Cognitive Memory service: deterministic four-tier memory as a credentialed storage layer.
 *
 * The export surface is arranged so a tree-shaking bundler can drop what is not
 * used: importing `createClient` and `runTurn` should not drag in the tensions
 * and self-model resources. That only works because everything is ESM and the
 * resources are separate modules, which is why they live in `resources/`
 * individually rather than in one file.
 */

// Core
export { CognitiveMemory, createClient } from "./cognitive-memory"
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

// Types
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
