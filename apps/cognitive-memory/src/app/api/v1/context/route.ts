import { Effect } from "effect"

import { ContextBody } from "@/server/domain/api"
import { decodeBody, readJson } from "@/server/http/respond"
import { toContextView } from "@/server/http/views"
import { authorize, MemoryEngine, respond } from "@/server/runtime"
import { Scope } from "@/server/services/keys"
import { MemoryStore } from "@/server/services/memory-store"

/**
 * Build the block to prepend to a system prompt.
 *
 * This is the endpoint that makes the service worth running: one call per turn,
 * returning text the agent can be primed with. The shape of that text is the
 * whole design —
 *
 *   - a one-line index of everything remembered, always, because it is cheap;
 *   - a full body only where a deterministic signal earned it: the caller's
 *     message named a concrete identifier a memory mentions, there is an
 *     unresolved contradiction, or a domain this agent keeps failing in.
 *
 * Bodies are the expensive part and injecting them indiscriminately is also how
 * you get distractors, so the budget is enforced here rather than hoped for.
 */
export const dynamic = "force-dynamic"

const build = (request: Request) =>
  Effect.gen(function* () {
    const caller = yield* authorize(request, Scope.Read)
    const body = yield* decodeBody(ContextBody, yield* Effect.promise(() => readJson(request)))
    const engine = yield* MemoryEngine
    const store = yield* MemoryStore

    const report = yield* engine.planContext({
      organizationId: caller.organizationId,
      ...(body.userMessage === undefined ? {} : { userMessage: body.userMessage }),
      ...(body.forceFull === undefined ? {} : { forceFull: body.forceFull }),
      ...(body.maxTokens === undefined ? {} : { maxTokens: body.maxTokens })
    })

    // Accounted for after the fact and never in the response path: a usage write
    // that failed must not turn a successful context build into a 500.
    yield* Effect.promise(() =>
      store
        .recordUsage({
          id: `use-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
          organizationId: caller.organizationId,
          apiKeyId: caller.keyId,
          route: "POST /v1/context",
          injectedTokens: report.totalTokens,
          now: Date.now()
        })
        .pipe(Effect.runPromise)
    ).pipe(Effect.ignore)

    return toContextView(report)
  })

export const POST = async (request: Request): Promise<Response> => respond(build(request))
