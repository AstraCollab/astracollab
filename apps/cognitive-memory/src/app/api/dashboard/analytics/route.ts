import { Effect } from "effect"

import { requireOrganization, respond } from "@/server/runtime"
import { MemoryEngine } from "@/server/engine/memory-engine"
import { MemoryStore } from "@/server/services/memory-store"

/**
 * What memory is costing, and what it is buying.
 *
 * The token chart is the easy half. The reason mix beside it is the half that
 * changes behaviour: a build that spends 900 tokens on 60 index lines and no
 * bodies is not a memory problem, it is a store with nothing worth a full body,
 * and no amount of budget would fix it.
 *
 * Returns the aggregate report directly rather than through a view: every value
 * is already a plain number or string produced by the store, so a mapping layer
 * would only be a second place for the shape to drift.
 */
export const dynamic = "force-dynamic"

const RANGES: Record<string, number> = { "7d": 7, "30d": 30, "90d": 90, "365d": 365 }

const analytics = (request: Request) =>
  Effect.gen(function* () {
    const { organizationId } = yield* requireOrganization
    const store = yield* MemoryStore
    const engine = yield* MemoryEngine

    const url = new URL(request.url)
    const days = RANGES[url.searchParams.get("range") ?? "30d"] ?? 30

    const to = Date.now()
    const budgets = yield* engine.budgets(organizationId)
    const report = yield* store.analytics(organizationId, {
      // Aligned to midnight so a "7 day" chart shows seven whole days rather
      // than seven overlapping ones that start mid-afternoon.
      from: Math.floor((to - days * 86_400_000) / 86_400_000) * 86_400_000,
      to,
      days,
      budget: budgets.maxTotalTokens
    })

    return { ...report, budget: budgets }
  })

export const GET = async (request: Request): Promise<Response> => respond(analytics(request))