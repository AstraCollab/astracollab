import { Effect } from "effect"

import { toSelfModelView } from "@/server/http/views"
import { authorize, MemoryEngine, respond } from "@/server/runtime"
import { Scope } from "@/server/services/keys"

/**
 * The proprioceptive self-model: how reliably this agent has done in each domain.
 *
 * Domains that fall below 75% are rendered as guardrails in the next context
 * build, so a weak area gets explicit attention instead of a confident guess.
 */
export const dynamic = "force-dynamic"

const read = (request: Request) =>
  Effect.gen(function* () {
    const caller = yield* authorize(request, Scope.Read)
    const engine = yield* MemoryEngine
    return toSelfModelView(yield* engine.selfModel(caller.organizationId))
  })

export const GET = async (request: Request): Promise<Response> => respond(read(request))
