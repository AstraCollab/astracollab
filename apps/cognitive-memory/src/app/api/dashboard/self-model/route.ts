import { Effect } from "effect"

import { toSelfModelView } from "@/server/http/views"
import { requireOrganization, respond } from "@/server/runtime"
import { MemoryEngine } from "@/server/engine/memory-engine"
import { MemoryStore } from "@/server/services/memory-store"

/**
 * The self-model, with the samples behind it.
 *
 * The score alone is a moving average, and a moving average cannot show you that
 * a domain got better — it just moves slowly. The individual outcomes travel with
 * it so the page can draw the trend and name the failure patterns that caused it.
 */
export const dynamic = "force-dynamic"

const selfModel = (request: Request) =>
  Effect.gen(function* () {
    const { organizationId } = yield* requireOrganization
    const engine = yield* MemoryEngine
    const store = yield* MemoryStore

    const url = new URL(request.url)
    const domain = url.searchParams.get("domain")

    const model = yield* engine.selfModel(organizationId)
    const outcomes = yield* store.listOutcomes(organizationId, {
      limit: 200,
      ...(domain === null ? {} : { domain })
    })

    return {
      selfModel: toSelfModelView(model),
      outcomes: outcomes.map((outcome) => ({ ...outcome }))
    }
  })

export const GET = async (request: Request): Promise<Response> => respond(selfModel(request))