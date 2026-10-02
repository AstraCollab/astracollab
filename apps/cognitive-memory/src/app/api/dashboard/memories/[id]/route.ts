import { Effect } from "effect"

import { EditMemoryBody } from "@/server/domain/api"
import type { MemoryTier } from "@/server/domain/memory"
import { InvalidRequest } from "@/server/domain/errors"
import { decodeBody, readJson } from "@/server/http/respond"
import { toMemoryView } from "@/server/http/views"
import { requireOrganization, respond } from "@/server/runtime"
import { MemoryEngine } from "@/server/engine/memory-engine"

/**
 * One memory: read it whole, edit what it says, move it between tiers, or
 * forget it.
 *
 * Session-authenticated, mirroring `POST /api/dashboard/preview`. The `/v1`
 * routes are key-only by design, and an agent key should not be able to delete
 * memories just because a human left one in a curl command.
 *
 * An edit never touches `lastAccessedAt` or `accessCount`: correcting a memory
 * must not promote it back into every prompt as a side effect.
 */
export const dynamic = "force-dynamic"

const read = (_request: Request, context: RouteContext<"/api/dashboard/memories/[id]">) =>
  Effect.gen(function* () {
    const { organizationId } = yield* requireOrganization
    const { id } = yield* Effect.promise(() => context.params)
    const engine = yield* MemoryEngine
    return { memory: toMemoryView(yield* engine.get(organizationId, id)) }
  })

const patch = (request: Request, context: RouteContext<"/api/dashboard/memories/[id]">) =>
  Effect.gen(function* () {
    const { organizationId } = yield* requireOrganization
    const { id } = yield* Effect.promise(() => context.params)
    const body = yield* decodeBody(EditMemoryBody, yield* Effect.promise(() => readJson(request)))
    const engine = yield* MemoryEngine

    const hasContent = body.content !== undefined
    const hasTier = body.tier !== undefined
    const hasDomains = body.domains !== undefined
    const hasGist = body.gist !== undefined
    if (!hasContent && !hasTier && !hasDomains && !hasGist) {
      return yield* new InvalidRequest({ message: "Nothing to change: send tier, content, gist or domains." })
    }

    if (hasTier) yield* engine.promote(organizationId, id, body.tier as MemoryTier)

    const memory =
      hasContent || hasDomains || hasGist
        ? yield* engine.edit(organizationId, id, {
            ...(hasContent ? { content: body.content } : {}),
            ...(hasDomains ? { domains: body.domains } : {}),
            ...(hasGist ? { gist: body.gist } : {})
          })
        : yield* engine.get(organizationId, id)

    return { memory: toMemoryView(memory) }
  })

const forget = (_request: Request, context: RouteContext<"/api/dashboard/memories/[id]">) =>
  Effect.gen(function* () {
    const { organizationId } = yield* requireOrganization
    const { id } = yield* Effect.promise(() => context.params)
    const engine = yield* MemoryEngine
    return { deleted: yield* engine.forget(organizationId, id), id }
  })

export const GET = async (
  request: Request,
  context: RouteContext<"/api/dashboard/memories/[id]">
): Promise<Response> => respond(read(request, context))

export const PATCH = async (
  request: Request,
  context: RouteContext<"/api/dashboard/memories/[id]">
): Promise<Response> => respond(patch(request, context))

export const DELETE = async (
  request: Request,
  context: RouteContext<"/api/dashboard/memories/[id]">
): Promise<Response> => respond(forget(request, context))