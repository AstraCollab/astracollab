import { Effect } from "effect"

import { RecallInspectBody } from "@/server/domain/api"
import { decodeBody, readJson } from "@/server/http/respond"
import { toMemoryView } from "@/server/http/views"
import { requireOrganization, respond } from "@/server/runtime"
import { MemoryEngine } from "@/server/engine/memory-engine"

/**
 * Why a memory matched.
 *
 * The recall inspector: a query in, the ranked hits out with the terms that did
 * the matching. The service claims a cosine score is not an explanation, so this
 * is where that claim is cashed in — ranking is token overlap, which means the
 * overlapping terms can be named, and a bad hit becomes a sentence you can fix
 * ("it matched on `test`, not on `deploy`") instead of a hunch.
 *
 * Read-only and session-authenticated: looking at your own recall costs nothing
 * and records nothing, so there is no reason to spend an API key on it.
 */
export const dynamic = "force-dynamic"

const inspect = (request: Request) =>
  Effect.gen(function* () {
    const { organizationId } = yield* requireOrganization
    const body = yield* decodeBody(RecallInspectBody, yield* Effect.promise(() => readJson(request)))
    const engine = yield* MemoryEngine

    const hits = yield* engine.explainRecall({
      organizationId,
      query: body.query,
      ...(body.limit === undefined ? {} : { limit: body.limit })
    })

    return {
      query: body.query,
      results: hits.map((hit) => ({
        memory: toMemoryView(hit.item),
        score: Number(hit.score.toFixed(4)),
        matched: hit.matched
      }))
    }
  })

export const POST = async (request: Request): Promise<Response> => respond(inspect(request))