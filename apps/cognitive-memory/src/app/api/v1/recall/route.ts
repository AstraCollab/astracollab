import { Effect } from "effect"

import { RecallBody } from "@/server/domain/api"
import { decodeBody, readJson } from "@/server/http/respond"
import { toRecallView } from "@/server/http/views"
import { authorize, MemoryEngine, respond } from "@/server/runtime"
import { Scope } from "@/server/services/keys"

/**
 * Deterministic recall: "what do you actually know about X?".
 *
 * The endpoint an agent calls when pre-staged context might not be enough — a
 * question sharing no words with the injected index, or a model that ignored
 * it. Ranking is token overlap with no model in the loop, so recall quality does
 * not change when a provider is down or a different model is configured.
 */
export const dynamic = "force-dynamic"

const recall = (request: Request) =>
  Effect.gen(function* () {
    const caller = yield* authorize(request, Scope.Read)
    const body = yield* decodeBody(RecallBody, yield* Effect.promise(() => readJson(request)))
    const engine = yield* MemoryEngine

    const hits = yield* engine.recall({
      organizationId: caller.organizationId,
      query: body.query,
      ...(body.limit === undefined ? {} : { limit: body.limit })
    })

    return {
      ...toRecallView(hits),
      // Said explicitly so a client can tell "nothing matched" from "the request
      // failed" and prompt the model to admit ignorance rather than guess.
      empty: hits.length === 0
    }
  })

export const POST = async (request: Request): Promise<Response> => respond(recall(request))
