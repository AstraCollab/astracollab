import { Effect } from "effect"

import { DomainBody, DomainOutcomeBody } from "@/server/domain/api"
import { decodeBody, readJson } from "@/server/http/respond"
import { requireOrganization, respond } from "@/server/runtime"
import { MemoryEngine } from "@/server/engine/memory-engine"

/**
 * Recording how a task went, and forgetting a domain.
 *
 * Outcome recording is normally the agent's job, through `/v1/self-model/outcome`,
 * because the agent knows whether the migration worked. It is exposed here too
 * because the person watching the agent usually knows first: "it failed again"
 * typed into a form reaches the self-model in a second, and the alternative is a
 * guardrail that stays switched off until somebody remembers to write code.
 *
 * `DELETE` clears a domain's score *and* its samples. A reset that kept the
 * history would rebuild the same wrong average from the same evidence.
 */
export const dynamic = "force-dynamic"

const record = (request: Request) =>
  Effect.gen(function* () {
    const { organizationId } = yield* requireOrganization
    const body = yield* decodeBody(DomainOutcomeBody, yield* Effect.promise(() => readJson(request)))
    const engine = yield* MemoryEngine

    const capability = yield* engine.recordDomainOutcome({
      organizationId,
      domain: body.domain,
      success: body.success,
      ...(body.failurePattern === undefined ? {} : { failurePattern: body.failurePattern }),
      ...(body.strategy === undefined ? {} : { strategy: body.strategy })
    })

    return {
      domain: body.domain,
      capability: {
        reliabilityScore: capability.reliabilityScore,
        sampleCount: capability.sampleCount,
        knownFailurePatterns: capability.knownFailurePatterns,
        recommendedStrategies: capability.recommendedStrategies
      }
    }
  })

const forget = (request: Request) =>
  Effect.gen(function* () {
    const { organizationId } = yield* requireOrganization
    const body = yield* decodeBody(DomainBody, yield* Effect.promise(() => readJson(request)))
    const engine = yield* MemoryEngine
    return { domain: body.domain, ...(yield* engine.forgetDomain(organizationId, body.domain)) }
  })

export const POST = async (request: Request): Promise<Response> => respond(record(request), { status: 201 })

export const DELETE = async (request: Request): Promise<Response> => respond(forget(request))