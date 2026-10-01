import { Effect } from "effect"

import { ResolveTensionBody } from "@/server/domain/api"
import { decodeBody, readJson } from "@/server/http/respond"
import { toTensionView } from "@/server/http/views"
import { requireOrganization, respond } from "@/server/runtime"
import { MemoryEngine } from "@/server/engine/memory-engine"

/**
 * Resolving a contradiction from the dashboard.
 *
 * The resolution and its pattern are kept rather than deleted: the pattern is
 * usually the reusable part, and losing it means rediscovering the same
 * contradiction next month.
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

export const POST = async (
  request: Request,
  context: RouteContext<"/api/dashboard/tensions/[id]">
): Promise<Response> => respond(resolve(request, context))
