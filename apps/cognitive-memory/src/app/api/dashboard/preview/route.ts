import { Effect } from "effect"

import { toContextView } from "@/server/http/views"
import { requireOrganization, respond } from "@/server/runtime"
import { MemoryEngine } from "@/server/engine/memory-engine"
import { extractIdentifiers } from "cogmemory"

/**
 * Preview the block an agent would be given, without an agent.
 *
 * The most useful thing a memory service can show a person is the exact prompt
 * text their agent is about to receive, with the reason and token cost of every
 * line in it. It turns "memory is not working" from a report into something you
 * can read and adjust.
 *
 * Session-authenticated and read-only, like the rest of the dashboard: it costs
 * nothing and records nothing, so there is no reason to spend an API key on it.
 */
export const dynamic = "force-dynamic"

const preview = (request: Request) =>
  Effect.gen(function* () {
    const { organizationId } = yield* requireOrganization
    const engine = yield* MemoryEngine

    const raw = (yield* Effect.promise(() => request.json().catch(() => ({})))) as {
      userMessage?: unknown
    }
    const userMessage = typeof raw.userMessage === "string" ? raw.userMessage : ""

    const report = yield* engine.planContext({
      organizationId,
      ...(userMessage === "" ? {} : { userMessage })
    })

    const view = toContextView(report)
    return {
      ...view,
      // Shown next to the preview so the trigger rule is visible rather than magic.
      identifiers: userMessage === "" ? [] : extractIdentifiers(userMessage),
      // The budget is configurable, so a truncated preview should say so loudly
      // rather than looking like the whole story.
      truncated: view.truncated
    }
  })

export const POST = async (request: Request): Promise<Response> => respond(preview(request))
