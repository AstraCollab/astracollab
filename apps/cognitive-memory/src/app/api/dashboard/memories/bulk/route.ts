import { Effect } from "effect"

import { BulkMemoryBody } from "@/server/domain/api"
import type { MemoryTier } from "@/server/domain/memory"
import { decodeBody, readJson } from "@/server/http/respond"
import { requireOrganization, respond } from "@/server/runtime"
import { MemoryEngine } from "@/server/engine/memory-engine"

/**
 * A selection-wide change.
 *
 * Its own route rather than a second verb on `/memories`, because that route's
 * `POST` is already "store one of these" and a REST verb cannot mean two things.
 *
 * Promote and demote are the moves the tiers exist for; "archive" parks
 * something in L3 where it costs nothing until it is recalled; "forget" is the
 * only irreversible one, and it says how many rows it actually removed so a
 * selection that quietly missed some rows is visible rather than assumed.
 */
export const dynamic = "force-dynamic"

const apply = (request: Request) =>
  Effect.gen(function* () {
    const { organizationId } = yield* requireOrganization
    const body = yield* decodeBody(BulkMemoryBody, yield* Effect.promise(() => readJson(request)))
    const engine = yield* MemoryEngine

    const tier: MemoryTier | undefined =
      body.action === "promote"
        ? "L1"
        : body.action === "demote"
          ? "L2"
          : body.action === "archive"
            ? "L3"
            : undefined

    const affected = yield* engine.applyTo(
      organizationId,
      body.ids,
      tier === undefined ? "forget" : { tier }
    )
    return { affected, action: body.action }
  })

export const POST = async (request: Request): Promise<Response> => respond(apply(request))