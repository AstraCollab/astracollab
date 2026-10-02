import { Effect } from "effect"

import { SettingsActionBody, SettingsBody } from "@/server/domain/api"
import { authConfigured } from "@/server/auth/better-auth"
import { settings } from "@/server/config"
import { decodeBody, readJson } from "@/server/http/respond"
import { requireOrganization, respond } from "@/server/runtime"
import { MemoryEngine } from "@/server/engine/memory-engine"
import { MemoryStore } from "@/server/services/memory-store"

/**
 * Per-organisation settings, and the operations the danger zone runs.
 *
 * Settings are per organisation rather than per deployment on purpose: a hosted
 * instance has many tenants who cannot be expected to agree on one token
 * ceiling, and a self-hosted deployment still wants to change it without a
 * restart. The deployment defaults are returned alongside the overrides so the
 * page can show which one is in force — a setting that silently reverts is worse
 * than no setting at all.
 *
 * The destructive operations live behind `POST` with a named action rather than
 * as separate routes: they are the same authority, the same session, and one
 * place where what "forget everything" actually deletes can be read.
 */
export const dynamic = "force-dynamic"

const read = Effect.gen(function* () {
  const { organizationId } = yield* requireOrganization
  const store = yield* MemoryStore
  const engine = yield* MemoryEngine
  const config = yield* settings

  const overrides = yield* store.getSettings(organizationId)
  const budgets = yield* engine.budgets(organizationId)
  const counts = yield* store.stats(organizationId)
  const keys = yield* store.listKeys(organizationId)

  return {
    settings: overrides,
    effective: {
      ...budgets,
      retentionDays: overrides?.retentionDays ?? 90,
      // What will actually run. "rules" in the settings only has an effect when
      // a model key exists, so the page shows the resolved mode rather than the
      // requested one.
      extraction: overrides?.extraction === "rules" || config.modelApiKey === null ? "rules-only" : "rules+model"
    },
    requestedExtraction: overrides?.extraction ?? "auto",
    deployment: {
      databasePath: config.databasePath,
      modelName: config.modelName,
      modelConfigured: config.modelApiKey !== null,
      authConfigured: authConfigured(),
      defaults: {
        maxTotalTokens: config.maxTotalTokens,
        maxIndexItems: config.maxIndexItems,
        defaultRecallLimit: config.defaultRecallLimit
      }
    },
    problems: config.problems,
    footprint: {
      memories: counts.total,
      keys: keys.length,
      activeKeys: keys.filter((key) => key.revokedAt === null).length
    }
  }
})

const patch = (request: Request) =>
  Effect.gen(function* () {
    const { organizationId } = yield* requireOrganization
    const body = yield* decodeBody(SettingsBody, yield* Effect.promise(() => readJson(request)))
    const store = yield* MemoryStore
    const engine = yield* MemoryEngine

    const saved = yield* store.putSettings(organizationId, body)
    const budgets = yield* engine.budgets(organizationId)
    return { settings: saved, effective: { ...budgets, retentionDays: saved.retentionDays } }
  })

const act = (request: Request) =>
  Effect.gen(function* () {
    const { organizationId } = yield* requireOrganization
    const body = yield* decodeBody(SettingsActionBody, yield* Effect.promise(() => readJson(request)))
    const store = yield* MemoryStore
    const engine = yield* MemoryEngine

    if (body.action === "prune") {
      const overrides = yield* store.getSettings(organizationId)
      const retentionDays = overrides?.retentionDays ?? 90
      const deleted = yield* store.pruneHistory(organizationId, retentionDays, Date.now())
      // Nothing is pruned by a timer, so the retention window is a promise the
      // operator keeps by pressing this. Said plainly on the page.
      return { action: "prune" as const, retentionDays, deleted }
    }

    if (body.action === "forget-all") {
      return { action: "forget-all" as const, deleted: yield* engine.forgetEverything(organizationId) }
    }

    return { action: "revoke-keys" as const, revoked: yield* store.revokeEveryKey(organizationId, Date.now()) }
  })

export const GET = async (): Promise<Response> => respond(read)

export const PATCH = async (request: Request): Promise<Response> => respond(patch(request))

export const POST = async (request: Request): Promise<Response> => respond(act(request))