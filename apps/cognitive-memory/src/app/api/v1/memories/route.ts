import { Effect } from "effect"

import { RememberBody } from "@/server/domain/api"
import { MemoryTier } from "@/server/domain/memory"
import { decodeBody, readJson } from "@/server/http/respond"
import { toLearnView, toMemoryView } from "@/server/http/views"
import { authorize, MemoryEngine, respond } from "@/server/runtime"
import { Scope } from "@/server/services/keys"
import { MemoryStore } from "@/server/services/memory-store"

/**
 * The write path: state facts your agent should keep.
 *
 * This is the endpoint a client uses when it already knows what is worth
 * remembering. Learning from conversation is `/turns`; this one is the storage
 * layer behaving like storage.
 */
export const dynamic = "force-dynamic"

const TIERS: ReadonlyArray<MemoryTier> = ["L0", "L1", "L2", "L3"]

const list = (request: Request) =>
  Effect.gen(function* () {
    const caller = yield* authorize(request, Scope.Read)
    const url = new URL(request.url)
    const limitParam = Number(url.searchParams.get("limit") ?? "100")
    const tierParam = url.searchParams.get("tier")

    const store = yield* MemoryStore
    const tier = TIERS.find((value) => value === tierParam)
    const memories = yield* store.listMemories(caller.organizationId, {
      limit: Number.isFinite(limitParam) ? limitParam : 100,
      ...(tier === undefined ? {} : { tiers: [tier] })
    })
    const stats = yield* store.stats(caller.organizationId)

    return { memories: memories.map(toMemoryView), stats }
  })

const create = (request: Request) =>
  Effect.gen(function* () {
    const caller = yield* authorize(request, Scope.Write)
    const body = yield* decodeBody(RememberBody, yield* Effect.promise(() => readJson(request)))
    const engine = yield* MemoryEngine

    const outcome = yield* engine.remember({
      organizationId: caller.organizationId,
      items: body.items,
      ...(body.sessionId === undefined ? {} : { sessionId: body.sessionId }),
      source: "api"
    })

    return toLearnView(outcome)
  })

export const GET = async (request: Request): Promise<Response> => respond(list(request))

export const POST = async (request: Request): Promise<Response> =>
  respond(create(request), { status: 201 })
