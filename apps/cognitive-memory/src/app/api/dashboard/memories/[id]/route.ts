import { Effect } from "effect"

import { PromoteBody } from "@/server/domain/api"
import { decodeBody, readJson } from "@/server/http/respond"
import { toMemoryView } from "@/server/http/views"
import { requireOrganization, respond } from "@/server/runtime"
import { MemoryEngine } from "@/server/engine/memory-engine"

/**
 * Tier changes and deletion, from the dashboard.
 *
 * Session-authenticated, mirroring `POST /api/dashboard/preview`. The `/v1`
 * routes are key-only by design, and an agent key should not be able to delete
 * memories just because a human left one in a curl command.
 */
export const dynamic = "force-dynamic"

const promote = (request: Request, context: RouteContext<"/api/dashboard/memories/[id]">) =>
  Effect.gen(function* () {
    const { organizationId } = yield* requireOrganization
    const { id } = yield* Effect.promise(() => context.params)
    const body = yield* decodeBody(PromoteBody, yield* Effect.promise(() => readJson(request)))
    const engine = yield* MemoryEngine

    yield* engine.promote(organizationId, id, body.tier)
    return { memory: toMemoryView(yield* engine.get(organizationId, id)) }
  })

const forget = (_request: Request, context: RouteContext<"/api/dashboard/memories/[id]">) =>
  Effect.gen(function* () {
    const { organizationId } = yield* requireOrganization
    const { id } = yield* Effect.promise(() => context.params)
    const engine = yield* MemoryEngine
    return { deleted: yield* engine.forget(organizationId, id), id }
  })

export const PATCH = async (
  request: Request,
  context: RouteContext<"/api/dashboard/memories/[id]">
): Promise<Response> => respond(promote(request, context))

export const DELETE = async (
  request: Request,
  context: RouteContext<"/api/dashboard/memories/[id]">
): Promise<Response> => respond(forget(request, context))
