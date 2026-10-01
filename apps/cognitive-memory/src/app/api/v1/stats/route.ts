import { Effect } from "effect"

import { toMemoryView, toTensionView } from "@/server/http/views"
import { authorize, MemoryEngine, respond } from "@/server/runtime"
import { Scope } from "@/server/services/keys"
import { MemoryStore } from "@/server/services/memory-store"

/**
 * What this tenant's memory currently looks like.
 *
 * Read-only and unauthenticated-by-key-free: it needs only `stats:read`, so a
 * monitoring job can watch token cost without being able to read the memories
 * themselves.
 */
export const dynamic = "force-dynamic"

const stats = (request: Request) =>
  Effect.gen(function* () {
    const caller = yield* authorize(request, Scope.Stats)
    const store = yield* MemoryStore
    const engine = yield* MemoryEngine

    const counts = yield* store.stats(caller.organizationId)
    const recent = yield* store.listMemories(caller.organizationId, { limit: 5 })
    const tensions = yield* engine.listTensions(caller.organizationId, "active")
    const selfModel = yield* engine.selfModel(caller.organizationId)

    return {
      memories: {
        total: counts.total,
        byTier: counts.byTier,
        sessions: counts.sessions,
        firstStoredAt: counts.createdAt,
        lastAccessedAt: counts.lastAccessedAt
      },
      tensions: { active: counts.activeTensions },
      weakDomains: Object.entries(selfModel.domains)
        .filter(([, capability]) => capability.reliabilityScore < 0.75)
        .map(([domain, capability]) => ({
          domain,
          reliabilityScore: capability.reliabilityScore,
          sampleCount: capability.sampleCount
        })),
      recent: recent.map(toMemoryView),
      activeTensions: tensions.map(toTensionView)
    }
  })

export const GET = async (request: Request): Promise<Response> => respond(stats(request))
