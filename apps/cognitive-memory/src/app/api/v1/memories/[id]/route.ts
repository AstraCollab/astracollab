import { Effect } from "effect"

import { PromoteBody } from "@/server/domain/api"
import { decodeBody, readJson } from "@/server/http/respond"
import { toMemoryView } from "@/server/http/views"
import { authorize, MemoryEngine, respond } from "@/server/runtime"
import { Scope } from "@/server/services/keys"

/**
 * One memory: read it whole, move it between tiers, or forget it.
 *
 * `DELETE` is a real delete, not a tombstone. There is a tension between "a
 * storage layer you can correct" and "an agent's memory is append-only", and the
 * honest answer is that both are needed: `PATCH` tier for the cheap correction,
 * `DELETE` for when a stored fact is wrong enough that keeping it would keep
 * poisoning recall.
 */
export const dynamic = "force-dynamic"

const read = (request: Request, context: RouteContext<"/api/v1/memories/[id]">) =>
  Effect.gen(function* () {
    const caller = yield* authorize(request, Scope.Read)
    const { id } = yield* Effect.promise(() => context.params)
    const engine = yield* MemoryEngine
    return { memory: toMemoryView(yield* engine.get(caller.organizationId, id)) }
  })

const promote = (request: Request, context: RouteContext<"/api/v1/memories/[id]">) =>
  Effect.gen(function* () {
    const caller = yield* authorize(request, Scope.Write)
    const { id } = yield* Effect.promise(() => context.params)
    const body = yield* decodeBody(PromoteBody, yield* Effect.promise(() => readJson(request)))
    const engine = yield* MemoryEngine

    yield* engine.promote(caller.organizationId, id, body.tier)
    return { memory: toMemoryView(yield* engine.get(caller.organizationId, id)) }
  })

const forget = (request: Request, context: RouteContext<"/api/v1/memories/[id]">) =>
  Effect.gen(function* () {
    const caller = yield* authorize(request, Scope.Write)
    const { id } = yield* Effect.promise(() => context.params)
    const engine = yield* MemoryEngine

    const removed = yield* engine.forget(caller.organizationId, id)
    return { deleted: removed, id }
  })

export const GET = async (
  request: Request,
  context: RouteContext<"/api/v1/memories/[id]">
): Promise<Response> => respond(read(request, context))

export const PATCH = async (
  request: Request,
  context: RouteContext<"/api/v1/memories/[id]">
): Promise<Response> => respond(promote(request, context))

export const DELETE = async (
  request: Request,
  context: RouteContext<"/api/v1/memories/[id]">
): Promise<Response> => respond(forget(request, context))
