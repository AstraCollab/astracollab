import { Effect } from "effect"

import { requireOrganization, respond } from "@/server/runtime"
import { MemoryStore } from "@/server/services/memory-store"

/**
 * What has actually been injected, in order, with the block that was sent.
 *
 * The audit trail. A log line saying "memory was injected, 812 tokens" tells you
 * something happened; it does not tell you whether the *right* thing was
 * injected, and by the time an agent has said the wrong thing you cannot
 * reconstruct that from a count.
 *
 * So the block is stored, not just its size, and this serves it back with the
 * reason and token cost of every line. The message that triggered a build is not
 * stored with it: that is the conversation, not the memory, and it belongs to the
 * caller. The identifiers it contained are, because those are what explain why a
 * full body was spent.
 */
export const dynamic = "force-dynamic"

const activity = (request: Request) =>
  Effect.gen(function* () {
    const { organizationId } = yield* requireOrganization
    const store = yield* MemoryStore

    const url = new URL(request.url)
    const before = url.searchParams.get("before")
    const keyId = url.searchParams.get("keyId")
    const limit = Number(url.searchParams.get("limit") ?? "25")

    const [rows, keys] = yield* Effect.all(
      [
        store.listInjections(organizationId, {
          limit: Number.isFinite(limit) ? limit : 25,
          ...(before === null ? {} : { before }),
          ...(keyId === null ? {} : { keyId })
        }),
        store.listKeys(organizationId)
      ],
      { concurrency: 2 }
    )

    const names = new Map(keys.map((key) => [key.id, { name: key.name, prefix: key.prefix }]))
    const last = rows.at(-1)

    return {
      events: rows.map((row) => ({
        ...row,
        key: row.apiKeyId === null ? null : (names.get(row.apiKeyId) ?? null)
      })),
      // The cursor is the oldest row returned, so the next page starts strictly
      // after it. Newer builds arriving mid-scroll cannot shift the window.
      nextCursor: rows.length === 0 ? null : (last?.createdAt ?? null)
    }
  })

export const GET = async (request: Request): Promise<Response> => respond(activity(request))