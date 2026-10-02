import { Effect } from "effect"

import { ResolveTensionBody, TensionStatusBody } from "@/server/domain/api"
import { decodeBody, readJson } from "@/server/http/respond"
import { toTensionView } from "@/server/http/views"
import { requireOrganization, respond } from "@/server/runtime"
import { MemoryEngine } from "@/server/engine/memory-engine"

/**
 * Resolving, reopening and discarding a contradiction.
 *
 * The resolution and its pattern are kept rather than deleted: the pattern is
 * usually the reusable part, and losing it means rediscovering the same
 * contradiction next month.
 *
 * `DELETE` is for the case where there was never a contradiction — a misfiled
 * pair, or two claims that turned out to be about different subjects. It
 * discards the row rather than resolving it, so the history does not imply
 * somebody thought about it.
 */
export const dynamic = "force-dynamic"

const resolve = (request: Request, context: RouteContext<"/api/dashboard/tensions/[id]">) =>
  Effect.gen(function* () {
    const { organizationId } = yield* requireOrganization
    const { id } = yield* Effect.promise(() => context.params)
    const body = yield* decodeBody(ResolveTensionBody, yield* Effect.promise(() => readJson(request)))
    const engine = yield* MemoryEngine

    const tension = yield* engine.resolveTension({
      organizationId,
      id,
      resolvedBy: body.resolvedBy,
      ...(body.pattern === undefined ? {} : { pattern: body.pattern })
    })
    return { tension: toTensionView(tension) }
  })

/**
 * Put a tension back in front of the agent.
 *
 * Resolution is a judgement, and judgements get reversed — usually by the same
 * person, months later, who no longer remembers resolving it. Reopening is how
 * that gets undone without deleting the original claims.
 */
const reopen = (request: Request, context: RouteContext<"/api/dashboard/tensions/[id]">) =>
  Effect.gen(function* () {
    const { organizationId } = yield* requireOrganization
    const { id } = yield* Effect.promise(() => context.params)
    const body = yield* decodeBody(TensionStatusBody, yield* Effect.promise(() => readJson(request)))
    const engine = yield* MemoryEngine

    const tension = yield* engine.setTensionStatus(organizationId, id, body.status)
    return { tension: toTensionView(tension) }
  })

const discard = (_request: Request, context: RouteContext<"/api/dashboard/tensions/[id]">) =>
  Effect.gen(function* () {
    const { organizationId } = yield* requireOrganization
    const { id } = yield* Effect.promise(() => context.params)
    const engine = yield* MemoryEngine
    return { deleted: yield* engine.forgetTension(organizationId, id), id }
  })

export const POST = async (
  request: Request,
  context: RouteContext<"/api/dashboard/tensions/[id]">
): Promise<Response> => respond(resolve(request, context))

export const PATCH = async (
  request: Request,
  context: RouteContext<"/api/dashboard/tensions/[id]">
): Promise<Response> => respond(reopen(request, context))

export const DELETE = async (
  request: Request,
  context: RouteContext<"/api/dashboard/tensions/[id]">
): Promise<Response> => respond(discard(request, context))