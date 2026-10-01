import { Effect } from "effect"

import { DomainOutcomeBody } from "@/server/domain/api"
import { decodeBody, readJson } from "@/server/http/respond"
import { toSelfModelView } from "@/server/http/views"
import { authorize, MemoryEngine, respond } from "@/server/runtime"
import { Scope } from "@/server/services/keys"

/**
 * Record how a domain went.
 *
 * This is the input that makes the self-model mean anything: without outcomes
 * recorded, the model stays at its priors and no guardrail ever fires.
 */
export const dynamic = "force-dynamic"

const record = (request: Request) =>
  Effect.gen(function* () {
    const caller = yield* authorize(request, Scope.Write)
    const body = yield* decodeBody(DomainOutcomeBody, yield* Effect.promise(() => readJson(request)))
    const engine = yield* MemoryEngine

    yield* engine.recordDomainOutcome({
      organizationId: caller.organizationId,
      domain: body.domain,
      success: body.success,
      ...(body.failurePattern === undefined ? {} : { failurePattern: body.failurePattern }),
      ...(body.strategy === undefined ? {} : { strategy: body.strategy })
    })

    return toSelfModelView(yield* engine.selfModel(caller.organizationId))
  })

export const POST = async (request: Request): Promise<Response> => respond(record(request))
