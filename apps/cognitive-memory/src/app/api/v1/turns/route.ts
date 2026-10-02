import { Effect } from "effect"

import { TurnBody } from "@/server/domain/api"
import { decodeBody, readJson } from "@/server/http/respond"
import { toLearnView } from "@/server/http/views"
import { authorize, account, MemoryEngine, respond } from "@/server/runtime"
import { Scope } from "@/server/services/keys"

/**
 * Learn from a completed turn.
 *
 * The harness calls this after a reply finishes streaming, because it can see
 * the conversation. A service cannot, so the client posts the turn — which is
 * also the difference between a memory layer you can test and one you can only
 * observe.
 *
 * A turn whose user message contains a question is treated as a lookup, not a
 * lesson, and learns nothing: extracting from recall turns stored the assistant's
 * own answers back as memories, duplicating facts and evicting the real ones.
 */
export const dynamic = "force-dynamic"

const learn = (request: Request) =>
  Effect.gen(function* () {
    const caller = yield* authorize(request, Scope.Write)
    const body = yield* decodeBody(TurnBody, yield* Effect.promise(() => readJson(request)))
    const engine = yield* MemoryEngine

    const outcome = yield* engine.learnFromTurn({
      organizationId: caller.organizationId,
      userMessage: body.userMessage,
      assistantResponse: body.assistantResponse,
      ...(body.sessionId === undefined ? {} : { sessionId: body.sessionId })
    })

    yield* account(caller, "POST /v1/turns")

    return toLearnView(outcome)
  })

export const POST = async (request: Request): Promise<Response> => respond(learn(request))
