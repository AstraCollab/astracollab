import { Schema } from "effect"

/**
 * The cognitive memory domain model, expressed as Effect schemas.
 *
 * This is the same model the in-process harness keeps in Maps (L0 pinned state,
 * L1 hot cache, L2 warm store, L3 cold archive). The difference is where it
 * lives: here it is rows in a database, scoped to a tenant, reachable over HTTP.
 *
 * Schemas rather than TypeScript interfaces because these are exactly the
 * values crossing a trust boundary — every one of them arrives from, or is sent
 * to, an untrusted request.
 */

export const MemoryTier = Schema.Literals(["L0", "L1", "L2", "L3"])
export type MemoryTier = typeof MemoryTier.Type

export const TensionStatus = Schema.Literals(["active", "latent", "resolved"])
export type TensionStatus = typeof TensionStatus.Type

export const TensionImpact = Schema.Literals(["low", "medium", "critical"])
export type TensionImpact = typeof TensionImpact.Type

export const InclusionReason = Schema.Literals([
  /** Index line only — the default, and what nearly everything costs. */
  "index",
  /** A concrete identifier in the caller's message matched this memory. */
  "trigger",
  /** An unresolved contradiction earned the body. */
  "tension",
  /** A domain the agent has been unreliable in. */
  "guardrail"
])
export type InclusionReason = typeof InclusionReason.Type

export const MemorySource = Schema.Literals(["rules", "model", "api"])
export type MemorySource = typeof MemorySource.Type

export const ReconciliationAction = Schema.Literals(["add", "merge", "replace", "reject"])
export type ReconciliationAction = typeof ReconciliationAction.Type

export class MemoryMetadata extends Schema.Class<MemoryMetadata>("cognitive-memory/MemoryMetadata")({
  domains: Schema.Array(Schema.String),
  createdAt: Schema.Number,
  lastAccessedAt: Schema.Number,
  accessCount: Schema.Number,
  sourceSessionId: Schema.optional(Schema.String)
}) {}

export class MemoryItem extends Schema.Class<MemoryItem>("cognitive-memory/MemoryItem")({
  id: Schema.String,
  organizationId: Schema.String,
  content: Schema.String,
  /**
   * Dense 1-2 sentence representation. Kept separate from `content` so the
   * pre-staged index and a full recall can be different sizes of the same fact.
   */
  bookmark: Schema.String,
  /** Short label for the always-present index. */
  gist: Schema.optional(Schema.String),
  tier: MemoryTier,
  metadata: MemoryMetadata,
  source: Schema.optional(MemorySource)
}) {}

export class Claim extends Schema.Class<Claim>("cognitive-memory/Claim")({
  source: Schema.String,
  statement: Schema.String,
  timestamp: Schema.Number
}) {}

export class Resolution extends Schema.Class<Resolution>("cognitive-memory/Resolution")({
  resolvedAt: Schema.Number,
  resolvedBy: Schema.String,
  /** The reusable pattern the resolution revealed, if any. */
  pattern: Schema.String
}) {}

export class KnowledgeTension extends Schema.Class<KnowledgeTension>("cognitive-memory/KnowledgeTension")({
  id: Schema.String,
  organizationId: Schema.String,
  status: TensionStatus,
  claimA: Claim,
  claimB: Claim,
  impact: TensionImpact,
  /** 0.0 - 1.0 */
  taskRelevance: Schema.Number,
  /** The question to put to the user rather than guessing. */
  actionableQuestion: Schema.String,
  resolution: Schema.optional(Resolution)
}) {}

export class DomainCapability extends Schema.Class<DomainCapability>("cognitive-memory/DomainCapability")({
  /** Historical success rate, 0.0 - 1.0. */
  reliabilityScore: Schema.Number,
  sampleCount: Schema.Number,
  knownFailurePatterns: Schema.Array(Schema.String),
  recommendedStrategies: Schema.Array(Schema.String)
}) {}

export class ProprioceptiveSelfModel extends Schema.Class<ProprioceptiveSelfModel>(
  "cognitive-memory/ProprioceptiveSelfModel"
)({
  domains: Schema.Record(Schema.String, DomainCapability),
  /** 1.0 = well calibrated; below 0.7 reads as overconfident. */
  calibrationFactor: Schema.Number,
  activeDomains: Schema.Array(Schema.String)
}) {}

export class MemoryInjectionEntry extends Schema.Class<MemoryInjectionEntry>(
  "cognitive-memory/MemoryInjectionEntry"
)({
  id: Schema.String,
  tier: MemoryTier,
  reason: InclusionReason,
  gist: Schema.String,
  /** Present only when the body earned its tokens. */
  body: Schema.optional(Schema.String),
  tokens: Schema.Number
}) {}

export class MemoryInjectionReport extends Schema.Class<MemoryInjectionReport>(
  "cognitive-memory/MemoryInjectionReport"
)({
  /** The block to prepend to the system prompt. Empty when there is nothing to say. */
  text: Schema.String,
  entries: Schema.Array(MemoryInjectionEntry),
  totalTokens: Schema.Number,
  /** True when the budget forced something out. */
  truncated: Schema.Boolean
}) {}

export class MemoryStats extends Schema.Class<MemoryStats>("cognitive-memory/MemoryStats")({
  total: Schema.Number,
  byTier: Schema.Record(Schema.Literals(["L0", "L1", "L2", "L3"]), Schema.Number),
  sessions: Schema.Number,
  activeTensions: Schema.Number,
  turnsProcessed: Schema.Number,
  createdAt: Schema.Number,
  lastAccessedAt: Schema.Number
}) {}

/** Approximate token cost of a string. */
export const estimateTokens = (value: string): number => Math.ceil(value.length / 4)

/**
 * The index line: short, scannable, no body.
 *
 * Falling back to the first sentence keeps an index line readable when a
 * memory arrives from the API without a gist.
 */
export const gistOf = (item: { readonly content: string; readonly gist?: string | undefined }): string => {
  if (item.gist && item.gist.trim().length > 0) return item.gist.trim()
  const first = item.content.split(/(?<=[.!?])\s/)[0] ?? item.content
  const trimmed = first.trim()
  return trimmed.length > 90 ? `${trimmed.slice(0, 90)}…` : trimmed
}
