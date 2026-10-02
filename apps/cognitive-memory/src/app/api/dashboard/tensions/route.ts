import { Effect } from "effect"

import { TensionBody } from "@/server/domain/api"
import { decodeBody, readJson } from "@/server/http/respond"
import { toTensionView } from "@/server/http/views"
import { requireOrganization, respond } from "@/server/runtime"
import { MemoryEngine } from "@/server/engine/memory-engine"

/**
 * Every contradiction this organisation holds, whatever its status.
 *
 * The agent-facing route lists active tensions because those are the ones that
 * get injected. A dashboard also needs the resolved ones, for a reason that is
 * easy to miss: the reusable pattern from a resolution is usually worth more
 * than the contradiction was, and a list that only shows what is still broken
 * throws that away the moment somebody fixes it.
 */
export const dynamic = "force-dynamic"

const STATUSES = ["active", "latent", "resolved"] as const

const list = (request: Request) =>
  Effect.gen(function* () {
    const { organizationId } = yield* requireOrganization
    const engine = yield* MemoryEngine

    const url = new URL(request.url)
    const requested = url.searchParams.get("status")
    const status = STATUSES.find((value) => value === requested)

    const rows = yield* engine.listTensions(organizationId, status)
    return { tensions: rows.map(toTensionView) }
  })

const create = (request: Request) =>
  Effect.gen(function* () {
    const { organizationId } = yield* requireOrganization
    const body = yield* decodeBody(TensionBody, yield* Effect.promise(() => readJson(request)))
    const engine = yield* MemoryEngine

    const tension = yield* engine.addTension({
      organizationId,
      claimA: body.claimA,
      claimB: body.claimB,
      ...(body.impact === undefined ? {} : { impact: body.impact }),
      actionableQuestion: body.actionableQuestion
    })

    return { tension: toTensionView(tension) }
  })

export const GET = async (request: Request): Promise<Response> => respond(list(request))

export const POST = async (request: Request): Promise<Response> =>
  respond(create(request), { status: 201 })