import { Effect } from "effect"
import { extractIdentifiers } from "cogmemory"

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

    // Which deterministic signals fired, and what they cost. Recorded rather
    // than recomputed by the dashboard, because "why was this included" is only
    // answerable at the moment the block was built.
    const identifiers = body.userMessage === undefined ? [] : extractIdentifiers(body.userMessage)
    const reasons: Record<string, number> = {}
    for (const entry of report.entries) {
      reasons[entry.reason] = (reasons[entry.reason] ?? 0) + 1
    }

    // Accounted for after the fact and never in the response path: a usage write
    // that failed must not turn a successful context build into a 500.
    yield* Effect.promise(() => {
      const at = Date.now()
      const usage = store
        .recordUsage({
          id: `use-${at.toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
          organizationId: caller.organizationId,
          apiKeyId: caller.keyId,
          route: "POST /v1/context",
          injectedTokens: report.totalTokens,
          now: at
        })
        .pipe(Effect.runPromise)
      const log = store
        .recordInjection({
          id: `inj-${at.toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
          organizationId: caller.organizationId,
          apiKeyId: caller.keyId,
          tokens: report.totalTokens,
          truncated: report.truncated,
          indexLines: report.entries.filter((entry) => entry.reason === "index").length,
          bodies: report.entries.filter((entry) => entry.body !== undefined).length,
          identifiers,
          reasons,
          entries: report.entries.map((entry) => ({
            id: entry.id,
            tier: entry.tier,
            reason: entry.reason,
            gist: entry.gist,
            tokens: entry.tokens
          })),
          text: report.text,
          now: at
        })
        .pipe(Effect.runPromise)
      // Being in a prompt is the use. Counted here, on the path that actually
      // serves an agent — a dashboard preview builds the same block and must
      // leave the counters alone, or "most used" measures curiosity.
      const counted = store
        .touchMany(
          caller.organizationId,
          report.entries.map((entry) => entry.id),
          at
        )
        .pipe(Effect.runPromise)
      return Promise.all([usage, log, counted])
    }).pipe(Effect.ignore)

    return toContextView(report)
  })

export const POST = async (request: Request): Promise<Response> => respond(build(request))
