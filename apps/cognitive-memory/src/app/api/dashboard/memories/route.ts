import { Effect } from "effect"

import { RememberBody } from "@/server/domain/api"
import { decodeBody, readJson } from "@/server/http/respond"
import { toLearnView, toMemoryView } from "@/server/http/views"
import { requireOrganization, respond } from "@/server/runtime"
import { MemoryEngine } from "@/server/engine/memory-engine"

/**
 * The memory library.
 *
 * Filtering, sorting and paging happen in SQL rather than in the browser because
 * the browser cannot: an organisation with a few thousand memories would have to
 * be shipped all of them to show the first fifty. The facets come back with the
 * page, because a filter sidebar whose counts are stale is worse than no counts.
 *
 * Session-authenticated, like the rest of the dashboard. Reading your own memory
 * through an agent key would be training exactly the habit this service exists to
 * discourage.
 */
export const dynamic = "force-dynamic"

const SORTS = ["recent", "created", "accessed", "alpha"] as const

const search = (request: Request) =>
  Effect.gen(function* () {
    const { organizationId } = yield* requireOrganization
    const engine = yield* MemoryEngine

    const url = new URL(request.url)
    const tiers = url.searchParams.getAll("tier").filter((tier) => /^L[0-3]$/.test(tier))
    const sortParam = url.searchParams.get("sort")
    const sort = SORTS.find((value) => value === sortParam)
    const limit = Number(url.searchParams.get("limit") ?? "50")
    const offset = Number(url.searchParams.get("offset") ?? "0")

    const page = yield* engine.page(organizationId, {
      ...(url.searchParams.get("q") === null ? {} : { text: url.searchParams.get("q") ?? "" }),
      ...(tiers.length === 0 ? {} : { tiers }),
      ...(url.searchParams.get("domain") === null
        ? {}
        : { domain: url.searchParams.get("domain") ?? "" }),
      ...(url.searchParams.get("source") === null
        ? {}
        : { source: url.searchParams.get("source") ?? "" }),
      ...(sort === undefined ? {} : { sort }),
      limit: Number.isFinite(limit) ? limit : 50,
      offset: Number.isFinite(offset) ? offset : 0
    })

    return {
      total: page.total,
      offset: page.offset,
      limit: page.limit,
      memories: page.rows.map(toMemoryView),
      facets: page.facets
    }
  })

/** Store a fact by hand, from the dashboard rather than from an agent. */
const create = (request: Request) =>
  Effect.gen(function* () {
    const { organizationId } = yield* requireOrganization
    const body = yield* decodeBody(RememberBody, yield* Effect.promise(() => readJson(request)))
    const engine = yield* MemoryEngine

    const outcome = yield* engine.remember({
      organizationId,
      items: body.items,
      ...(body.sessionId === undefined ? {} : { sessionId: body.sessionId }),
      // "api" because that is what this is: a person using the storage layer
      // directly. Inventing a "dashboard" source would show up in the analytics
      // breakdown as a fifth origin nobody can act on.
      source: "api"
    })

    return toLearnView(outcome)
  })

export const GET = async (request: Request): Promise<Response> => respond(search(request))

export const POST = async (request: Request): Promise<Response> =>
  respond(create(request), { status: 201 })