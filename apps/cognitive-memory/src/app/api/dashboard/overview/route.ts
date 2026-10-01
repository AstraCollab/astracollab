import { Effect } from "effect"

import { toMemoryView, toSelfModelView, toTensionView } from "@/server/http/views"
import { requireOrganization, respond } from "@/server/runtime"
import { MemoryEngine } from "@/server/engine/memory-engine"
import { MemoryStore } from "@/server/services/memory-store"

/**
 * What the dashboard shows, authenticated by session cookie.
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

  const counts = yield* store.stats(organizationId)
  const memories = yield* store.listMemories(organizationId, { limit: 200 })
  const tensions = yield* engine.listTensions(organizationId, "active")
  const selfModel = yield* engine.selfModel(organizationId)

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
    tensions: tensions.map(toTensionView)
  }
})

export const GET = async (): Promise<Response> => respond(overview)
