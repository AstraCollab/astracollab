import { Effect } from "effect"

import { toMemoryView, toSelfModelView, toTensionView } from "@/server/http/views"
import { MemoryEngine } from "@/server/engine/memory-engine"
import { extractorMode, settings } from "@/server/config"
import { authConfigured } from "@/server/auth/better-auth"
import { requireOrganization, respond } from "@/server/runtime"
import { MemoryStore } from "@/server/services/memory-store"

/**
 * The dashboard's landing payload.
 *
 * Everything the first screen shows, in one read: what is held, what it costs,
 * what contradicts itself, what the agent is bad at, and whether this deployment
 * is even configured properly.
 *
 * Deliberately separate from `/v1/*`, which is key-only by design. A key is the
 * credential you hand to an agent; letting one read state a person is looking at
 * would mean minting a key just to open a page, and keys are the thing this
 * service tries to hand out carefully. Two entry points, two authenticators,
 * each with the authority it actually needs.
 */
export const dynamic = "force-dynamic"

const overview = Effect.gen(function* () {
  const { organizationId } = yield* requireOrganization
  const store = yield* MemoryStore
  const engine = yield* MemoryEngine
  const config = yield* settings
  const mode = yield* extractorMode

  const counts = yield* store.stats(organizationId)
  const memories = yield* store.listMemories(organizationId, { limit: 200 })
  const tensions = yield* engine.listTensions(organizationId, "active")
  const selfModel = yield* engine.selfModel(organizationId)
  const budgets = yield* engine.budgets(organizationId)
  const overrides = yield* store.getSettings(organizationId)
  const recent = yield* store.listInjections(organizationId, { limit: 20 })

  // The last fortnight, as a sparkline on the landing screen. Anything older
  // belongs to the analytics page, which is where a number gets interrogated
  // rather than glanced at.
  const from = Date.now() - 14 * 86_400_000
  const report = yield* store.analytics(organizationId, {
    from,
    to: Date.now(),
    days: 14,
    budget: budgets.maxTotalTokens
  })

  const problems = [...config.problems]
  if (!authConfigured()) problems.push("BETTER_AUTH_SECRET is not set, so sign-in will fail.")

  const topMemoried = [...memories].sort((a, b) => b.metadata.accessCount - a.metadata.accessCount).slice(0, 5)

  return {
    organizationId,
    memories: memories.map(toMemoryView),
    stats: {
      total: counts.total,
      byTier: counts.byTier,
      sessions: counts.sessions,
      firstStoredAt: counts.createdAt,
      lastAccessedAt: counts.lastAccessedAt,
      activeTensions: counts.activeTensions
    },
    selfModel: toSelfModelView(selfModel),
    tensions: tensions.map(toTensionView),
    budget: {
      effective: budgets,
      // Both numbers, because "which ceiling is in force" is the question a
      // tuning knob raises first and a single merged value cannot answer it.
      overrides,
      defaults: {
        maxTotalTokens: config.maxTotalTokens,
        maxIndexItems: config.maxIndexItems,
        defaultRecallLimit: config.defaultRecallLimit
      }
    },
    extraction: mode,
    problems,
    spend: {
      daily: report.daily,
      totals: report.totals
    },
    recent: recent.map((row) => ({
      id: row.id,
      createdAt: row.createdAt,
      tokens: row.tokens,
      truncated: row.truncated,
      bodies: row.bodies,
      indexLines: row.indexLines,
      identifiers: row.identifiers
    })),
    usedMost: topMemoried.map(toMemoryView)
  }
})

export const GET = async (): Promise<Response> => respond(overview)