import { Effect } from "effect"

import { ResolveTensionBody } from "@/server/domain/api"
import { decodeBody, readJson } from "@/server/http/respond"
import { toTensionView } from "@/server/http/views"
import { authorize, MemoryEngine, respond } from "@/server/runtime"
import { Scope } from "@/server/services/keys"

/**
 * Resolve a tension.
 *
 * A resolution is kept rather than deleted: the pattern it revealed is usually
 * the reusable part, and losing it means rediscovering the same contradiction
 * next month.
 */
export const dynamic = "force-dynamic"

const resolve = (request: Request, context: RouteContext<"/api/v1/tensions/[id]">) =>
  Effect.gen(function* () {
    const caller = yield* authorize(request, Scope.Write)
    const { id } = yield* Effect.promise(() => context.params)
    const body = yield* decodeBody(ResolveTensionBody, yield* Effect.promise(() => readJson(request)))
    const engine = yield* MemoryEngine

    const tension = yield* engine.resolveTension({
      organizationId: caller.organizationId,
      id,
      resolvedBy: body.resolvedBy,
      ...(body.pattern === undefined ? {} : { pattern: body.pattern })
    })
    return { tension: toTensionView(tension) }
  })

export const POST = async (
  request: Request,
  context: RouteContext<"/api/v1/tensions/[id]">
): Promise<Response> => respond(resolve(request, context))
