import { InvalidRequest } from "../domain/errors"
import {
  Claim,
  DomainCapability,
  KnowledgeTension,
  MemoryItem,
  MemoryInjectionReport,
  ProprioceptiveSelfModel,
  Resolution
} from "../domain/memory"
import type { MemoryView } from "../domain/api"

/**
 * Domain -> wire.
 *
 * Kept out of the schemas on purpose: `MemoryItem` is an Effect schema class
 * whose `Type` is a class instance, and `JSON.stringify` on a class instance is
 * the sort of thing that works until someone adds a field. Views are plain
 * objects with a fixed shape, so a client can rely on it and a change to the
 * internal model cannot leak by accident.
 */

export const toMemoryView = (item: MemoryItem): MemoryView => ({
  id: item.id,
  content: item.content,
  ...(item.gist === undefined ? {} : { gist: item.gist }),
  tier: item.tier,
  domains: item.metadata.domains,
  accessCount: item.metadata.accessCount,
  ...(item.source === undefined ? {} : { source: item.source }),
  ...(item.metadata.sourceSessionId === undefined
    ? {}
    : { sessionId: item.metadata.sourceSessionId }),
  createdAt: item.metadata.createdAt,
  lastAccessedAt: item.metadata.lastAccessedAt
})

export const toTensionView = (tension: KnowledgeTension) => ({
  id: tension.id,
  status: tension.status,
  claimA: { ...tension.claimA },
  claimB: { ...tension.claimB },
  impact: tension.impact,
  actionableQuestion: tension.actionableQuestion,
  ...(tension.resolution === undefined
    ? {}
    : {
        resolvedBy: tension.resolution.resolvedBy,
        pattern: tension.resolution.pattern
      })
})

export const toSelfModelView = (model: ProprioceptiveSelfModel) => ({
  calibrationFactor: model.calibrationFactor,
  activeDomains: model.activeDomains,
  domains: Object.fromEntries(
    Object.entries(model.domains).map(([domain, capability]) => [
      domain,
      {
        reliabilityScore: capability.reliabilityScore,
        sampleCount: capability.sampleCount,
        knownFailurePatterns: capability.knownFailurePatterns,
        recommendedStrategies: capability.recommendedStrategies
      }
    ])
  ),
  /** Domains below this are rendered as guardrails in the next context build. */
  weakDomains: Object.entries(model.domains)
    .filter(([, capability]) => capability.reliabilityScore < 0.75)
    .map(([domain]) => domain)
})

export const toContextView = (report: MemoryInjectionReport) => ({
  text: report.text,
  entries: report.entries.map((entry) => ({
    id: entry.id,
    tier: entry.tier,
    reason: entry.reason,
    gist: entry.gist,
    ...(entry.body === undefined ? {} : { body: entry.body }),
    tokens: entry.tokens
  })),
  totalTokens: report.totalTokens,
  truncated: report.truncated
})

/** What a learn call learned, phrased for a client rather than a log. */
export const toLearnView = (outcome: {
  readonly stored: ReadonlyArray<MemoryItem>
  readonly mergedInto: ReadonlyArray<MemoryItem>
  readonly merged: number
  readonly rejected: ReadonlyArray<{ readonly content: string; readonly reason: string }>
  readonly tensions: number
  readonly promotions: number
}) => ({
  stored: outcome.stored.map(toMemoryView),
  // Restatements that were folded in, with the memory that survived, so a client
  // can see that its statement was already known rather than silently lost.
  mergedInto: outcome.mergedInto.map(toMemoryView),
  counts: {
    stored: outcome.stored.length,
    merged: outcome.merged,
    rejected: outcome.rejected.length,
    tensions: outcome.tensions,
    promoted: outcome.promotions
  },
  // Never silently dropped: a client that sent ten statements and got three back
  // needs to know which seven did not make it and why.
  rejected: outcome.rejected
})

/** Ranked results, with the body included so a client does not need a second call. */
export const toRecallView = (hits: ReadonlyArray<{ readonly item: MemoryItem; readonly score: number }>) => ({
  results: hits.map((hit) => ({ memory: toMemoryView(hit.item), score: Number(hit.score.toFixed(4)) }))
})

export const invalidRequest = (message: string, issues?: ReadonlyArray<string>) =>
  new InvalidRequest({ message, ...(issues === undefined ? {} : { issues: [...issues] }) })

export { Claim, DomainCapability, Resolution }
