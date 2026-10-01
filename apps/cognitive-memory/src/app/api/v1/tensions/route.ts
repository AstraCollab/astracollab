import { Effect } from "effect"

import { TensionBody } from "@/server/domain/api"
import { decodeBody, readJson } from "@/server/http/respond"
import { toTensionView } from "@/server/http/views"
import { authorize, MemoryEngine, respond } from "@/server/runtime"
import { Scope } from "@/server/services/keys"
import type { TensionStatus } from "@/server/domain/memory"

/**
 * Knowledge tensions: two claims that cannot both be true.
 *
 * A tension is worth more than either claim alone, so it is pinned into every
 * context build with an actionable question until it is resolved. That is the
 * difference between an agent that asks and one that picks a side silently.
 */
export const dynamic = "force-dynamic"

const STATUSES: ReadonlyArray<TensionStatus> = ["active", "latent", "resolved"]

const list = (request: Request) =>
  Effect.gen(function* () {
    const caller = yield* authorize(request, Scope.Read)
    const engine = yield* MemoryEngine
    const statusParam = new URL(request.url).searchParams.get("status")
    const status = STATUSES.find((value) => value === statusParam)

    const tensions = yield* engine.listTensions(
      caller.organizationId,
      status === undefined ? undefined : status
    )
    return { tensions: tensions.map(toTensionView) }
  })

const create = (request: Request) =>
  Effect.gen(function* () {
    const caller = yield* authorize(request, Scope.Write)
    const body = yield* decodeBody(TensionBody, yield* Effect.promise(() => readJson(request)))
    const engine = yield* MemoryEngine

    const tension = yield* engine.addTension({
      organizationId: caller.organizationId,
      claimA: body.claimA,
      claimB: body.claimB,
      ...(body.impact === undefined ? {} : { impact: body.impact }),
      actionableQuestion: body.actionableQuestion
    })
    return { tension: toTensionView(tension) }
  })

export const GET = async (request: Request): Promise<Response> => respond(list(request))
export const POST = async (request: Request): Promise<Response> => respond(create(request), { status: 201 })
