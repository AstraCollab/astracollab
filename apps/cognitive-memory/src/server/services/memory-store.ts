import { and, count, desc, eq, inArray, lt, sql } from "drizzle-orm"
import { Context, Effect, Layer } from "effect"

import type { AnalyticsReport } from "../domain/analytics"
import { NotFound, StorageFailure } from "../domain/errors"
import {
  Claim,
  DomainCapability,
  KnowledgeTension,
  MemoryItem,
  MemoryMetadata,
  MemorySource,
  MemoryTier,
  ProprioceptiveSelfModel,
  Resolution
} from "../domain/memory"
import { Database } from "../db/database"
import {
  apiKeys,
  domainOutcomes,
  injectionLogs,
  memories,
  organizationSettings,
  selfModels,
  tensions,
  usageEvents
} from "../db/schema"
import type {
  DomainCapability as DomainCapabilityShape,
  InjectionLogEntry
} from "../db/schema"

/**
 * Every read and write of memory state, tenant-scoped.
 *
 * The engine above this layer never builds a SQL string and never sees a table
 * name, which is what keeps "a key can only reach its own tenant" checkable by
 * reading one file. Each method takes `organizationId` and filters on it; the only
 * exception is `createKey`/`listKeys`, which are reached through the
 * authorisation path instead.
 *
 * Times are epoch milliseconds in the domain and ISO-8601 in the database:
 * arithmetic happens in the domain, ordering happens in SQL where ISO text
 * sorts chronologically.
 */

const isoOf = (ms: number): string => new Date(ms).toISOString()
const msOf = (iso: string): number => new Date(iso).getTime()

const toItem = (row: typeof memories.$inferSelect): MemoryItem =>
  new MemoryItem({
    id: row.id,
    organizationId: row.organizationId,
    content: row.content,
    bookmark: row.bookmark,
    ...(row.gist === null ? {} : { gist: row.gist }),
    tier: row.tier as MemoryTier,
    metadata: new MemoryMetadata({
      domains: row.domains,
      createdAt: msOf(row.createdAt),
      lastAccessedAt: msOf(row.lastAccessedAt),
      accessCount: row.accessCount,
      ...(row.sourceSessionId === null ? {} : { sourceSessionId: row.sourceSessionId })
    }),
    source: row.source as MemorySource
  })

const toTension = (row: typeof tensions.$inferSelect): KnowledgeTension =>
  new KnowledgeTension({
    id: row.id,
    organizationId: row.organizationId,
    status: row.status as KnowledgeTension["status"],
    claimA: new Claim(row.claimA),
    claimB: new Claim(row.claimB),
    impact: row.impact as KnowledgeTension["impact"],
    taskRelevance: row.taskRelevance,
    actionableQuestion: row.actionableQuestion,
    ...(row.resolution ? { resolution: new Resolution(row.resolution) } : {})
  })

/** Per-organisation overrides. `null` means "inherit the deployment default". */
export interface SettingsRow {
  readonly organizationId: string
  readonly maxTotalTokens: number | null
  readonly maxIndexItems: number | null
  readonly defaultRecallLimit: number | null
  readonly retentionDays: number
  readonly extraction: "auto" | "rules"
}

export interface InjectionLogRow {
  readonly id: string
  readonly tokens: number
  readonly truncated: boolean
  readonly indexLines: number
  readonly bodies: number
  readonly identifiers: ReadonlyArray<string>
  readonly reasons: Record<string, number>
  readonly entries: ReadonlyArray<InjectionLogEntry>
  readonly text: string
  readonly apiKeyId: string | null
  readonly createdAt: string
}

/** The memory list as the library page needs it: a page plus its facets. */
export interface MemoryPage {
  readonly rows: Array<MemoryItem>
  readonly total: number
  readonly offset: number
  readonly limit: number
  readonly facets: {
    readonly tiers: Record<string, number>
    readonly sources: Record<string, number>
    readonly domains: ReadonlyArray<{ readonly name: string; readonly count: number }>
  }
}

export interface OutcomeRow {
  readonly id: string
  readonly domain: string
  readonly success: boolean
  readonly failurePattern: string | null
  readonly strategy: string | null
  readonly createdAt: string
}

export interface StoreService {
  readonly listMemories: (organizationId: string, options?: {
    readonly tiers?: ReadonlyArray<MemoryTier>
    readonly limit?: number
    readonly sessionId?: string
  }) => Effect.Effect<Array<MemoryItem>, StorageFailure>

  /** Everything the engine may consider for injection or arbitration. */
  readonly activeMemories: (organizationId: string, limit: number) => Effect.Effect<Array<MemoryItem>, StorageFailure>

  readonly getMemory: (organizationId: string, id: string) => Effect.Effect<MemoryItem, StorageFailure | NotFound>

  readonly insertMemory: (
    organizationId: string,
    input: {
      readonly id: string
      readonly content: string
      readonly bookmark: string
      readonly gist?: string | undefined
      readonly tier: MemoryTier
      readonly domains: ReadonlyArray<string>
      readonly now: number
      readonly source: MemorySource
      readonly sessionId?: string | undefined
    }
  ) => Effect.Effect<MemoryItem, StorageFailure | NotFound>

  /** Rewrite an entry in place, keeping its identity, tags and counters. */
  readonly updateContent: (
    organizationId: string,
    id: string,
    content: string,
    bookmark: string,
    now: number
  ) => Effect.Effect<void, StorageFailure>

  readonly setTier: (organizationId: string, id: string, tier: MemoryTier) => Effect.Effect<void, StorageFailure>

  readonly touch: (organizationId: string, id: string, now: number) => Effect.Effect<void, StorageFailure>

  /**
   * Count one use of many memories at once.
   *
   * Called with the ids a context build actually included, which is the only
   * definition of "used" worth counting: a memory in the index is being spent on
   * every prompt, and the counter is what "most used" and the per-tier cost
   * reasoning are read off.
   *
   * One statement rather than one per row, because this runs on the hot path of
   * every turn. Ids with no matching row — guardrail and tension placeholders the
   * planner synthesises — simply do not match, which is why they can be passed
   * without being filtered out first.
   */
  readonly touchMany: (
    organizationId: string,
    ids: ReadonlyArray<string>,
    now: number
  ) => Effect.Effect<number, StorageFailure>

  readonly deleteMemory: (organizationId: string, id: string) => Effect.Effect<boolean, StorageFailure>

  readonly deleteByContent: (
    organizationId: string,
    contents: ReadonlyArray<string>
  ) => Effect.Effect<number, StorageFailure>

  readonly findByContent: (
    organizationId: string,
    contents: ReadonlyArray<string>
  ) => Effect.Effect<Array<MemoryItem>, StorageFailure>

  readonly listTensions: (
    organizationId: string,
    status?: KnowledgeTension["status"]
  ) => Effect.Effect<Array<KnowledgeTension>, StorageFailure>

  readonly upsertTension: (tension: KnowledgeTension, now: number) => Effect.Effect<KnowledgeTension, StorageFailure>

  readonly resolveTension: (
    organizationId: string,
    id: string,
    resolution: { readonly resolvedAt: number; readonly resolvedBy: string; readonly pattern: string }
  ) => Effect.Effect<KnowledgeTension, StorageFailure | NotFound>

  readonly deleteTension: (organizationId: string, id: string) => Effect.Effect<boolean, StorageFailure>

  readonly getSelfModel: (organizationId: string) => Effect.Effect<ProprioceptiveSelfModel, StorageFailure>

  readonly putSelfModel: (organizationId: string, model: ProprioceptiveSelfModel, now: number) => Effect.Effect<void, StorageFailure>

  readonly findKeyByPrefix: (prefix: string) => Effect.Effect<{
    readonly id: string
    readonly organizationId: string
    readonly secretHash: string
    readonly scopes: ReadonlyArray<string>
    readonly revokedAt: string | null
    readonly expiresAt: string | null
  } | null, StorageFailure>

  readonly createKey: (input: {
    readonly id: string
    readonly organizationId: string
    readonly name: string
    readonly prefix: string
    readonly secretHash: string
    readonly scopes: ReadonlyArray<string>
    readonly now: number
    readonly expiresAt?: string | undefined
  }) => Effect.Effect<void, StorageFailure>

  readonly listKeys: (organizationId: string) => Effect.Effect<Array<{
    readonly id: string
    readonly name: string
    readonly prefix: string
    readonly scopes: ReadonlyArray<string>
    readonly lastUsedAt: string | null
    readonly revokedAt: string | null
    readonly expiresAt: string | null
    readonly createdAt: string
  }>, StorageFailure>

  readonly revokeKey: (organizationId: string, id: string, now: number) => Effect.Effect<boolean, StorageFailure>

  readonly markKeyUsed: (id: string, now: number) => Effect.Effect<void, StorageFailure>

  readonly recordUsage: (input: {
    readonly id: string
    readonly organizationId: string
    readonly apiKeyId: string | null
    readonly route: string
    readonly injectedTokens: number | null
    readonly now: number
  }) => Effect.Effect<void, StorageFailure>

  readonly stats: (organizationId: string) => Effect.Effect<{
    readonly total: number
    readonly byTier: Record<string, number>
    readonly sessions: number
    readonly activeTensions: number
    readonly createdAt: number
    readonly lastAccessedAt: number
  }, StorageFailure>

  /**
   * A filtered, sorted page of memories plus the counts behind the filters.
   *
   * Facets come from the same read rather than a second pass so the numbers in
   * the sidebar always describe the list next to them.
   */
  readonly memoryPage: (
    organizationId: string,
    query: {
      readonly text?: string | undefined
      readonly tiers?: ReadonlyArray<string> | undefined
      readonly domain?: string | undefined
      readonly source?: string | undefined
      readonly sort?: "recent" | "created" | "accessed" | "alpha" | undefined
      readonly limit?: number | undefined
      readonly offset?: number | undefined
    }
  ) => Effect.Effect<MemoryPage, StorageFailure>

  /** Edit a memory in place, keeping its identity, tags and counters. */
  readonly editMemory: (
    organizationId: string,
    id: string,
    patch: {
      readonly content?: string | undefined
      readonly gist?: string | undefined
      readonly domains?: ReadonlyArray<string> | undefined
    },
    now: number
  ) => Effect.Effect<MemoryItem, StorageFailure | NotFound>

  /** Tier change or deletion across a selection. Returns how many rows moved. */
  readonly applyToMemories: (
    organizationId: string,
    ids: ReadonlyArray<string>,
    action: "forget" | { readonly tier: MemoryTier }
  ) => Effect.Effect<number, StorageFailure>

  readonly deleteEveryMemory: (organizationId: string) => Effect.Effect<number, StorageFailure>

  readonly setTensionStatus: (
    organizationId: string,
    id: string,
    status: KnowledgeTension["status"]
  ) => Effect.Effect<KnowledgeTension, StorageFailure | NotFound>

  /** Overrides, or null when this organisation has never changed a setting. */
  readonly getSettings: (organizationId: string) => Effect.Effect<SettingsRow | null, StorageFailure>

  /** Upsert the overrides. `undefined` fields are left alone. */
  readonly putSettings: (
    organizationId: string,
    patch: {
      readonly maxTotalTokens?: number | null | undefined
      readonly maxIndexItems?: number | null | undefined
      readonly defaultRecallLimit?: number | null | undefined
      readonly retentionDays?: number | undefined
      readonly extraction?: "auto" | "rules" | undefined
    }
  ) => Effect.Effect<SettingsRow, StorageFailure>

  /** Record what a context build actually cost, and why. */
  readonly recordInjection: (input: {
    readonly id: string
    readonly organizationId: string
    readonly apiKeyId: string | null
    readonly tokens: number
    readonly truncated: boolean
    readonly indexLines: number
    readonly bodies: number
    readonly identifiers: ReadonlyArray<string>
    readonly reasons: Record<string, number>
    readonly entries: ReadonlyArray<InjectionLogEntry>
    readonly text: string
    readonly now: number
  }) => Effect.Effect<void, StorageFailure>

  /**
   * The injection log, newest first, keyed by `createdAt` for a cursor.
   *
   * A cursor rather than an offset because these rows arrive while somebody is
   * reading the page, and an offset shifts underfoot the moment one does.
   */
  readonly listInjections: (
    organizationId: string,
    options?: { readonly limit?: number; readonly before?: string; readonly keyId?: string }
  ) => Effect.Effect<ReadonlyArray<InjectionLogRow>, StorageFailure>

  /** Every account the range covered, newest first. */
  readonly analytics: (
    organizationId: string,
    range: {
      readonly from: number
      readonly to: number
      readonly days: number
      /** The budget in force, so utilisation can be reported without a second read. */
      readonly budget: number
    }
  ) => Effect.Effect<AnalyticsReport, StorageFailure>

  readonly recordOutcome: (input: {
    readonly id: string
    readonly organizationId: string
    readonly domain: string
    readonly success: boolean
    readonly failurePattern?: string | undefined
    readonly strategy?: string | undefined
    readonly now: number
  }) => Effect.Effect<void, StorageFailure>

  readonly listOutcomes: (
    organizationId: string,
    options?: { readonly limit?: number; readonly domain?: string }
  ) => Effect.Effect<ReadonlyArray<OutcomeRow>, StorageFailure>

  /** Drop a domain's samples. The capability itself is removed by the engine. */
  readonly deleteOutcomeHistory: (organizationId: string, domain: string) => Effect.Effect<number, StorageFailure>

  /** Delete usage, injection and outcome rows older than the retention window. */
  readonly pruneHistory: (
    organizationId: string,
    retentionDays: number,
    now: number
  ) => Effect.Effect<{ readonly usage: number; readonly injections: number; readonly outcomes: number }, StorageFailure>

  readonly revokeEveryKey: (organizationId: string, now: number) => Effect.Effect<number, StorageFailure>
}

export class MemoryStore extends Context.Service<MemoryStore, StoreService>()("cognitive-memory/MemoryStore") {
  static readonly layer = Layer.effect(
    MemoryStore,
    Effect.gen(function*() {
      const { db, run } = yield* Database

      const listMemories: StoreService["listMemories"] = (organizationId, options = {}) =>
        run("MemoryStore.listMemories", () => {
          const limit = Math.min(Math.max(options.limit ?? 100, 1), 500)
          const conditions = [eq(memories.organizationId, organizationId)]
          if (options.tiers && options.tiers.length > 0) {
            conditions.push(inArray(memories.tier, [...options.tiers]))
          }
          if (options.sessionId) {
            conditions.push(eq(memories.sourceSessionId, options.sessionId))
          }
          return db
            .select()
            .from(memories)
            .where(and(...conditions))
            .orderBy(desc(memories.lastAccessedAt))
            .limit(limit)
            .all()
            .map(toItem)
        })

      const activeMemories: StoreService["activeMemories"] = (organizationId, limit) =>
        run("MemoryStore.activeMemories", () => {
          // L1 first (pre-staged, always relevant), then the warmest of the rest.
          return db
            .select()
            .from(memories)
            .where(eq(memories.organizationId, organizationId))
            .orderBy(desc(sql`CASE WHEN ${memories.tier} = 'L1' THEN 1 ELSE 0 END`), desc(memories.lastAccessedAt))
            .limit(Math.max(1, Math.min(limit, 500)))
            .all()
            .map(toItem)
        })

      const getMemory: StoreService["getMemory"] = (organizationId, id) =>
        Effect.gen(function*() {
          const row = yield* run("MemoryStore.getMemory", () =>
            db
              .select()
              .from(memories)
              .where(and(eq(memories.id, id), eq(memories.organizationId, organizationId)))
              .get()
          )
          if (!row) return yield* new NotFound({ resource: "memory", id })
          return toItem(row)
        })

      const insertMemory: StoreService["insertMemory"] = (organizationId, input) =>
        run("MemoryStore.insertMemory", () => {
          const timestamp = isoOf(input.now)
          const row = db
            .insert(memories)
            .values({
              id: input.id,
              organizationId,
              content: input.content,
              bookmark: input.bookmark,
              gist: input.gist ?? null,
              tier: input.tier,
              domains: [...input.domains],
              accessCount: 0,
              lastAccessedAt: timestamp,
              sourceSessionId: input.sessionId ?? null,
              source: input.source,
              createdAt: timestamp,
              updatedAt: timestamp
            })
            .returning()
            .get()
          return toItem(row!)
        })

      const updateContent: StoreService["updateContent"] = (organizationId, id, content, bookmark, now) =>
        run("MemoryStore.updateContent", () => {
          db.update(memories)
            .set({ content, bookmark, updatedAt: isoOf(now), lastAccessedAt: isoOf(now) })
            .where(and(eq(memories.id, id), eq(memories.organizationId, organizationId)))
            .run()
        })

      const setTier: StoreService["setTier"] = (organizationId, id, tier) =>
        run("MemoryStore.setTier", () => {
          db.update(memories).set({ tier }).where(and(eq(memories.id, id), eq(memories.organizationId, organizationId))).run()
        })

      const touch: StoreService["touch"] = (organizationId, id, now) =>
        run("MemoryStore.touch", () => {
          db.update(memories)
            .set({
              accessCount: sql`${memories.accessCount} + 1`,
              lastAccessedAt: isoOf(now)
            })
            .where(and(eq(memories.id, id), eq(memories.organizationId, organizationId)))
            .run()
        })

      const touchMany: StoreService["touchMany"] = (organizationId, ids, now) =>
        run("MemoryStore.touchMany", () => {
          const target = [...new Set(ids)].slice(0, 200)
          if (target.length === 0) return 0
          return db
            .update(memories)
            .set({
              accessCount: sql`${memories.accessCount} + 1`,
              lastAccessedAt: isoOf(now)
            })
            .where(and(eq(memories.organizationId, organizationId), inArray(memories.id, target)))
            .returning({ id: memories.id })
            .all().length
        })

      const deleteMemory: StoreService["deleteMemory"] = (organizationId, id) =>
        run("MemoryStore.deleteMemory", () => {
          const removed = db
            .delete(memories)
            .where(and(eq(memories.id, id), eq(memories.organizationId, organizationId)))
            .returning({ id: memories.id })
            .all()
          return removed.length > 0
        })

      const deleteByContent: StoreService["deleteByContent"] = (organizationId, contents) =>
        run("MemoryStore.deleteByContent", () => {
          if (contents.length === 0) return 0
          const normalised = contents.map((c) => c.trim().toLowerCase())
          const rows = db.select().from(memories).where(eq(memories.organizationId, organizationId)).all()
          const doomed = rows
            .filter((row) => normalised.includes(row.content.trim().toLowerCase()))
            .map((row) => row.id)
          if (doomed.length === 0) return 0
          db.delete(memories).where(and(eq(memories.organizationId, organizationId), inArray(memories.id, doomed))).run()
          return doomed.length
        })

      const findByContent: StoreService["findByContent"] = (organizationId, contents) =>
        run("MemoryStore.findByContent", () => {
          if (contents.length === 0) return []
          const normalised = new Set(contents.map((c) => c.trim().toLowerCase()))
          return db
            .select()
            .from(memories)
            .where(eq(memories.organizationId, organizationId))
            .all()
            .filter((row) => normalised.has(row.content.trim().toLowerCase()))
            .map(toItem)
        })

      const listTensions: StoreService["listTensions"] = (organizationId, status) =>
        run("MemoryStore.listTensions", () => {
          const conditions = [eq(tensions.organizationId, organizationId)]
          if (status) conditions.push(eq(tensions.status, status))
          return db
            .select()
            .from(tensions)
            .where(and(...conditions))
            .orderBy(desc(tensions.updatedAt))
            .all()
            .map(toTension)
        })

      const upsertTension: StoreService["upsertTension"] = (tension, now) =>
        run("MemoryStore.upsertTension", () => {
          const timestamp = isoOf(now)
          const row = db
            .insert(tensions)
            .values({
              id: tension.id,
              organizationId: tension.organizationId,
              status: tension.status,
              claimA: { ...tension.claimA },
              claimB: { ...tension.claimB },
              impact: tension.impact,
              taskRelevance: tension.taskRelevance,
              actionableQuestion: tension.actionableQuestion,
              resolution: tension.resolution ? { ...tension.resolution } : null,
              createdAt: timestamp,
              updatedAt: timestamp
            })
            .onConflictDoUpdate({
              target: tensions.id,
              set: {
                status: tension.status,
                impact: tension.impact,
                actionableQuestion: tension.actionableQuestion,
                resolution: tension.resolution ? { ...tension.resolution } : null,
                updatedAt: timestamp
              }
            })
            .returning()
            .get()
          return toTension(row!)
        })

      const resolveTension: StoreService["resolveTension"] = (organizationId, id, resolution) =>
        Effect.gen(function*() {
          const row = yield* run("MemoryStore.resolveTension", () =>
            db
              .update(tensions)
              .set({ status: "resolved", resolution, updatedAt: isoOf(resolution.resolvedAt) })
              .where(and(eq(tensions.id, id), eq(tensions.organizationId, organizationId)))
              .returning()
              .get()
          )
          if (!row) return yield* new NotFound({ resource: "tension", id })
          return toTension(row)
        })

      const deleteTension: StoreService["deleteTension"] = (organizationId, id) =>
        run("MemoryStore.deleteTension", () => {
          const removed = db
            .delete(tensions)
            .where(and(eq(tensions.id, id), eq(tensions.organizationId, organizationId)))
            .returning({ id: tensions.id })
            .all()
          return removed.length > 0
        })

      const getSelfModel: StoreService["getSelfModel"] = (organizationId) =>
        run("MemoryStore.getSelfModel", () => {
          const row = db.select().from(selfModels).where(eq(selfModels.organizationId, organizationId)).get()
          if (!row) {
            return new ProprioceptiveSelfModel({ domains: {}, calibrationFactor: 1, activeDomains: [] })
          }
          const domains: Record<string, DomainCapability> = {}
          for (const [domain, capability] of Object.entries(row.domains)) {
            const record = capability as {
              reliabilityScore: number
              sampleCount: number
              knownFailurePatterns: Array<string>
              recommendedStrategies: Array<string>
            }
            domains[domain] = new DomainCapability({
              reliabilityScore: record.reliabilityScore,
              sampleCount: record.sampleCount,
              knownFailurePatterns: record.knownFailurePatterns ?? [],
              recommendedStrategies: record.recommendedStrategies ?? []
            })
          }
          return new ProprioceptiveSelfModel({
            domains,
            calibrationFactor: row.calibrationFactor,
            activeDomains: row.activeDomains
          })
        })

      const putSelfModel: StoreService["putSelfModel"] = (organizationId, model, now) =>
        run("MemoryStore.putSelfModel", () => {
          const timestamp = isoOf(now)
          // Plain objects, not schema instances: this column is serialised to JSON
          // and a class instance would carry its prototype into the row.
          const domains: Record<string, DomainCapabilityShape> = {}
          for (const [domain, capability] of Object.entries(model.domains)) {
            domains[domain] = {
              reliabilityScore: capability.reliabilityScore,
              sampleCount: capability.sampleCount,
              knownFailurePatterns: [...capability.knownFailurePatterns],
              recommendedStrategies: [...capability.recommendedStrategies]
            }
          }
          db.insert(selfModels)
            .values({
              organizationId,
              domains,
              calibrationFactor: model.calibrationFactor,
              activeDomains: [...model.activeDomains],
              createdAt: timestamp,
              updatedAt: timestamp
            })
            .onConflictDoUpdate({
              target: selfModels.organizationId,
              set: { domains, calibrationFactor: model.calibrationFactor, activeDomains: [...model.activeDomains], updatedAt: timestamp }
            })
            .run()
        })

      const findKeyByPrefix: StoreService["findKeyByPrefix"] = (prefix) =>
        run("MemoryStore.findKeyByPrefix", () => {
          const row = db.select().from(apiKeys).where(eq(apiKeys.prefix, prefix)).get()
          if (!row) return null
          return {
            id: row.id,
            organizationId: row.organizationId,
            secretHash: row.secretHash,
            scopes: row.scopes,
            revokedAt: row.revokedAt,
            expiresAt: row.expiresAt
          }
        })

      const createKey: StoreService["createKey"] = (input) =>
        run("MemoryStore.createKey", () => {
          const timestamp = isoOf(input.now)
          db.insert(apiKeys)
            .values({
              id: input.id,
              organizationId: input.organizationId,
              name: input.name,
              prefix: input.prefix,
              secretHash: input.secretHash,
              scopes: [...input.scopes],
              lastUsedAt: null,
              revokedAt: null,
              expiresAt: input.expiresAt ?? null,
              createdAt: timestamp,
              updatedAt: timestamp
            })
            .run()
        })

      const listKeys: StoreService["listKeys"] = (organizationId) =>
        run("MemoryStore.listKeys", () =>
          db
            .select({
              id: apiKeys.id,
              name: apiKeys.name,
              prefix: apiKeys.prefix,
              scopes: apiKeys.scopes,
              lastUsedAt: apiKeys.lastUsedAt,
              revokedAt: apiKeys.revokedAt,
              expiresAt: apiKeys.expiresAt,
              createdAt: apiKeys.createdAt
            })
            .from(apiKeys)
            .where(eq(apiKeys.organizationId, organizationId))
            .orderBy(desc(apiKeys.createdAt))
            .all()
        )

      const revokeKey: StoreService["revokeKey"] = (organizationId, id, now) =>
        run("MemoryStore.revokeKey", () => {
          const removed = db
            .update(apiKeys)
            .set({ revokedAt: isoOf(now), updatedAt: isoOf(now) })
            .where(and(eq(apiKeys.id, id), eq(apiKeys.organizationId, organizationId)))
            .returning({ id: apiKeys.id })
            .all()
          return removed.length > 0
        })

      const markKeyUsed: StoreService["markKeyUsed"] = (id, now) =>
        run("MemoryStore.markKeyUsed", () => {
          db.update(apiKeys).set({ lastUsedAt: isoOf(now) }).where(eq(apiKeys.id, id)).run()
        })

      const recordUsage: StoreService["recordUsage"] = (input) =>
        run("MemoryStore.recordUsage", () => {
          db.insert(usageEvents)
            .values({
              id: input.id,
              organizationId: input.organizationId,
              apiKeyId: input.apiKeyId,
              route: input.route,
              injectedTokens: input.injectedTokens,
              createdAt: isoOf(input.now)
            })
            .run()
        })

      const stats: StoreService["stats"] = (organizationId) =>
        run("MemoryStore.stats", () => {
          const rows = db
            .select({
              tier: memories.tier,
              total: count(),
              earliest: sql<string>`MIN(${memories.createdAt})`,
              latest: sql<string>`MAX(${memories.lastAccessedAt})`,
              sessions: sql<number>`COUNT(DISTINCT ${memories.sourceSessionId})`
            })
            .from(memories)
            .where(eq(memories.organizationId, organizationId))
            .groupBy(memories.tier)
            .all()

          const byTier: Record<string, number> = { L0: 0, L1: 0, L2: 0, L3: 0 }
          let total = 0
          let sessions = 0
          let earliest: number | null = null
          let latest = 0
          for (const row of rows) {
            byTier[row.tier] = row.total
            total += row.total
            sessions = Math.max(sessions, row.sessions)
            const created = row.earliest ? msOf(row.earliest) : null
            if (created !== null && (earliest === null || created < earliest)) earliest = created
            const accessed = row.latest ? msOf(row.latest) : 0
            if (accessed > latest) latest = accessed
          }

          const tensionRows = db
            .select({ total: count() })
            .from(tensions)
            .where(and(eq(tensions.organizationId, organizationId), eq(tensions.status, "active")))
            .all()

          return {
            total,
            byTier,
            sessions,
            activeTensions: tensionRows[0]?.total ?? 0,
            createdAt: earliest ?? 0,
            lastAccessedAt: latest
          }
        })

      /**
       * Substring matching with `instr` rather than `LIKE`.
       *
       * `LIKE` reads `%` and `_` in the needle as wildcards, so a memory titled
       * "use 100% of the budget" would match every row in the tenant. `instr` is
       * a literal search, which is what a filter box means.
       */
      const memoryPage: StoreService["memoryPage"] = (organizationId, query) =>
        run("MemoryStore.memoryPage", () => {
          const conditions = [eq(memories.organizationId, organizationId)]
          const needle = query.text?.trim().toLowerCase()
          if (needle !== undefined && needle !== "") {
            // Parenthesised, and not as a stylistic choice: `and()` joins its
            // arguments without wrapping them, so a bare `a or b or c` here
            // parses as `(tenant and a) or b or c` — which matches rows in every
            // other tenant whose bookmark happens to contain the needle. That is
            // a cross-tenant read caused by operator precedence.
            conditions.push(
              sql`(${sql.join([memories.content, memories.bookmark, memories.gist].map((column) => sql`instr(lower(${column}), ${needle}) > 0`), sql` or `)})`
            )
          }
          if (query.tiers !== undefined && query.tiers.length > 0) {
            conditions.push(inArray(memories.tier, [...query.tiers]))
          }
          if (query.domain !== undefined && query.domain !== "") {
            // Domains are a JSON array of strings, so the quoted form matches a
            // whole element rather than a prefix of another domain's name.
            conditions.push(sql`instr(${memories.domains}, ${`"${query.domain}"`}) > 0`)
          }
          if (query.source !== undefined && query.source !== "") {
            conditions.push(eq(memories.source, query.source))
          }

          const order = (() => {
            switch (query.sort) {
              case "created":
                return desc(memories.createdAt)
              case "accessed":
                return desc(memories.accessCount)
              case "alpha":
                return memories.content
              default:
                return desc(memories.lastAccessedAt)
            }
          })()

          const limit = Math.min(Math.max(query.limit ?? 50, 1), 200)
          const offset = Math.max(query.offset ?? 0, 0)

          const rows = db
            .select()
            .from(memories)
            .where(and(...conditions))
            .orderBy(order)
            .limit(limit)
            .offset(offset)
            .all()
            .map(toItem)

          const total = db
            .select({ total: count() })
            .from(memories)
            .where(and(...conditions))
            .get()?.total ?? 0

          // Facets over the tenant rather than over the current filter, so the
          // counts answer "how many would I get if I clicked this" instead of
          // collapsing to the one row already selected.
          const grouped = db
            .select({ tier: memories.tier, source: memories.source, total: count() })
            .from(memories)
            .where(eq(memories.organizationId, organizationId))
            .groupBy(memories.tier, memories.source)
            .all()

          const tiers: Record<string, number> = {}
          const sources: Record<string, number> = {}
          for (const row of grouped) {
            tiers[row.tier] = (tiers[row.tier] ?? 0) + row.total
            sources[row.source] = (sources[row.source] ?? 0) + row.total
          }

          const domainCounts = new Map<string, number>()
          for (const row of db
            .select({ domains: memories.domains })
            .from(memories)
            .where(eq(memories.organizationId, organizationId))
            .all()) {
            for (const domain of row.domains) {
              domainCounts.set(domain, (domainCounts.get(domain) ?? 0) + 1)
            }
          }

          return {
            rows,
            total,
            offset,
            limit,
            facets: {
              tiers,
              sources,
              domains: [...domainCounts.entries()]
                .map(([name, count]) => ({ name, count }))
                .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
            }
          }
        })

      const editMemory: StoreService["editMemory"] = (organizationId, id, patch, now) =>
        Effect.gen(function* () {
          const row = yield* run("MemoryStore.editMemory", () =>
            db
              .update(memories)
              .set({
                ...(patch.content === undefined
                  ? {}
                  : { content: patch.content, bookmark: patch.content.slice(0, 200) }),
                ...(patch.gist === undefined ? {} : { gist: patch.gist }),
                ...(patch.domains === undefined ? {} : { domains: [...patch.domains] }),
                updatedAt: isoOf(now)
              })
              .where(and(eq(memories.id, id), eq(memories.organizationId, organizationId)))
              .returning()
              .get()
          )
          if (!row) return yield* new NotFound({ resource: "memory", id })
          return toItem(row)
        })

      const applyToMemories: StoreService["applyToMemories"] = (organizationId, ids, action) =>
        run("MemoryStore.applyToMemories", () => {
          // Bounded because the `IN` list is inlined into the statement; a
          // select-all over a large store would build a query nobody wants.
          const target = ids.slice(0, 500)
          if (target.length === 0) return 0
          const scoped = and(eq(memories.organizationId, organizationId), inArray(memories.id, target))
          if (action === "forget") {
            return db.delete(memories).where(scoped).returning({ id: memories.id }).all().length
          }
          return db
            .update(memories)
            .set({ tier: action.tier })
            .where(scoped)
            .returning({ id: memories.id })
            .all().length
        })

      const deleteEveryMemory: StoreService["deleteEveryMemory"] = (organizationId) =>
        run("MemoryStore.deleteEveryMemory", () =>
          db
            .delete(memories)
            .where(eq(memories.organizationId, organizationId))
            .returning({ id: memories.id })
            .all().length
        )

      const setTensionStatus: StoreService["setTensionStatus"] = (organizationId, id, status) =>
        Effect.gen(function* () {
          const row = yield* run("MemoryStore.setTensionStatus", () =>
            db
              .update(tensions)
              .set({ status, updatedAt: new Date().toISOString() })
              .where(and(eq(tensions.id, id), eq(tensions.organizationId, organizationId)))
              .returning()
              .get()
          )
          if (!row) return yield* new NotFound({ resource: "tension", id })
          return toTension(row)
        })

      const getSettings: StoreService["getSettings"] = (organizationId) =>
        run("MemoryStore.getSettings", () => {
          const row = db
            .select()
            .from(organizationSettings)
            .where(eq(organizationSettings.organizationId, organizationId))
            .get()
          if (!row) return null
          return {
            organizationId: row.organizationId,
            maxTotalTokens: row.maxTotalTokens,
            maxIndexItems: row.maxIndexItems,
            defaultRecallLimit: row.defaultRecallLimit,
            retentionDays: row.retentionDays,
            extraction: row.extraction as "auto" | "rules"
          }
        })

      const putSettings: StoreService["putSettings"] = (organizationId, patch) =>
        run("MemoryStore.putSettings", () => {
          const current = db
            .select()
            .from(organizationSettings)
            .where(eq(organizationSettings.organizationId, organizationId))
            .get()
          // Read-modify-write rather than an update of only the named columns:
          // the difference between "not supplied" and "set back to the default"
          // is a nullable column, and only a read can tell them apart.
          const next: SettingsRow = {
            organizationId,
            maxTotalTokens:
              patch.maxTotalTokens === undefined ? (current?.maxTotalTokens ?? null) : patch.maxTotalTokens,
            maxIndexItems:
              patch.maxIndexItems === undefined ? (current?.maxIndexItems ?? null) : patch.maxIndexItems,
            defaultRecallLimit:
              patch.defaultRecallLimit === undefined
                ? (current?.defaultRecallLimit ?? null)
                : patch.defaultRecallLimit,
            retentionDays: patch.retentionDays ?? current?.retentionDays ?? 90,
            extraction: (patch.extraction ?? current?.extraction ?? "auto") as "auto" | "rules"
          }
          const values = {
            organizationId: next.organizationId,
            maxTotalTokens: next.maxTotalTokens,
            maxIndexItems: next.maxIndexItems,
            defaultRecallLimit: next.defaultRecallLimit,
            retentionDays: next.retentionDays,
            extraction: next.extraction
          }
          db.insert(organizationSettings)
            .values(values)
            .onConflictDoUpdate({ target: organizationSettings.organizationId, set: values })
            .run()
          return next
        })

      const recordInjection: StoreService["recordInjection"] = (input) =>
        run("MemoryStore.recordInjection", () => {
          db.insert(injectionLogs)
            .values({
              id: input.id,
              organizationId: input.organizationId,
              apiKeyId: input.apiKeyId,
              tokens: input.tokens,
              truncated: input.truncated,
              indexLines: input.indexLines,
              bodies: input.bodies,
              identifiers: [...input.identifiers],
              reasons: { ...input.reasons },
              entries: input.entries.map((entry) => ({ ...entry })),
              text: input.text,
              createdAt: isoOf(input.now)
            })
            .run()
        })

      const listInjections: StoreService["listInjections"] = (organizationId, options = {}) =>
        run("MemoryStore.listInjections", () => {
          const conditions = [eq(injectionLogs.organizationId, organizationId)]
          if (options.before) conditions.push(lt(injectionLogs.createdAt, options.before))
          if (options.keyId) conditions.push(eq(injectionLogs.apiKeyId, options.keyId))
          return db
            .select()
            .from(injectionLogs)
            .where(and(...conditions))
            .orderBy(desc(injectionLogs.createdAt))
            .limit(Math.min(Math.max(options.limit ?? 25, 1), 100))
            .all()
            .map((row) => ({
              id: row.id,
              tokens: row.tokens,
              truncated: row.truncated,
              indexLines: row.indexLines,
              bodies: row.bodies,
              identifiers: row.identifiers,
              reasons: row.reasons,
              entries: row.entries,
              text: row.text,
              apiKeyId: row.apiKeyId,
              createdAt: row.createdAt
            }))
        })

      /**
       * The analytics report.
       *
       * Three cheap queries and a fold in JavaScript, rather than one large
       * `GROUP BY` per chart. SQLite would happily run either, but the reason
       * mix and the domain histogram only exist as JSON columns that have to be
       * opened anyway, so splitting the work makes the parts that *can* stay in
       * SQL stay there.
       */
      const analytics: StoreService["analytics"] = (organizationId, range) =>
        run("MemoryStore.analytics", () => {
          const fromIso = isoOf(range.from)
          const toIso = isoOf(range.to)
          const inRange = (value: string | null): boolean =>
            value !== null && value >= fromIso && value <= toIso

          const injections = db
            .select()
            .from(injectionLogs)
            .where(
              and(
                eq(injectionLogs.organizationId, organizationId),
                sql`${injectionLogs.createdAt} >= ${fromIso}`,
                sql`${injectionLogs.createdAt} <= ${toIso}`
              )
            )
            .all()

          const usage = db
            .select({
              route: usageEvents.route,
              apiKeyId: usageEvents.apiKeyId,
              tokens: usageEvents.injectedTokens
            })
            .from(usageEvents)
            .where(
              and(
                eq(usageEvents.organizationId, organizationId),
                sql`${usageEvents.createdAt} >= ${fromIso}`,
                sql`${usageEvents.createdAt} <= ${toIso}`
              )
            )
            .all()

          const keyRows = db
            .select({
              id: apiKeys.id,
              name: apiKeys.name,
              prefix: apiKeys.prefix,
              lastUsedAt: apiKeys.lastUsedAt,
              revokedAt: apiKeys.revokedAt
            })
            .from(apiKeys)
            .where(eq(apiKeys.organizationId, organizationId))
            .all()

          const stored = db
            .select({
              tier: memories.tier,
              source: memories.source,
              domains: memories.domains,
              createdAt: memories.createdAt
            })
            .from(memories)
            .where(eq(memories.organizationId, organizationId))
            .all()

          const tensionRows = db
            .select({ status: tensions.status, total: count() })
            .from(tensions)
            .where(eq(tensions.organizationId, organizationId))
            .groupBy(tensions.status)
            .all()

          const selfModel = db
            .select({ domains: selfModels.domains })
            .from(selfModels)
            .where(eq(selfModels.organizationId, organizationId))
            .get()

          /* ---- daily series, one bucket per day whether or not anything happened */

          // Mutable while counting, `DailyBucket` once handed out: a readonly
          // series that nobody can add to is not a series.
          type Bucket = { day: string; builds: number; tokens: number; truncated: number; added: number }

          const days: Array<Bucket> = []
          const byDay = new Map<string, Bucket>()
          for (let offset = range.days - 1; offset >= 0; offset -= 1) {
            const day = isoOf(range.to - offset * 86_400_000).slice(0, 10)
            const bucket: Bucket = { day, builds: 0, tokens: 0, truncated: 0, added: 0 }
            days.push(bucket)
            byDay.set(day, bucket)
          }
          const bucketFor = (day: string): Bucket | undefined => byDay.get(day)

          let tokens = 0
          let truncated = 0
          let guardrailBuilds = 0
          const reasonTotals = new Map<string, number>()
          const tokenSamples: Array<number> = []

          for (const row of injections) {
            const bucket = bucketFor(row.createdAt.slice(0, 10))
            if (bucket) {
              bucket.builds += 1
              bucket.tokens += row.tokens
              if (row.truncated) bucket.truncated += 1
            }
            tokens += row.tokens
            if (row.truncated) truncated += 1
            if ((row.reasons.guardrail ?? 0) > 0) guardrailBuilds += 1
            for (const [reason, count_] of Object.entries(row.reasons)) {
              reasonTotals.set(reason, (reasonTotals.get(reason) ?? 0) + count_)
            }
            tokenSamples.push(row.tokens)
          }

          let memoriesAdded = 0
          const tierTotals = new Map<string, number>()
          const sourceTotals = new Map<string, number>()
          const domainTotals = new Map<string, number>()
          for (const row of stored) {
            tierTotals.set(row.tier, (tierTotals.get(row.tier) ?? 0) + 1)
            sourceTotals.set(row.source, (sourceTotals.get(row.source) ?? 0) + 1)
            for (const domain of row.domains) {
              domainTotals.set(domain, (domainTotals.get(domain) ?? 0) + 1)
            }
            if (inRange(row.createdAt)) {
              memoriesAdded += 1
              const bucket = bucketFor(row.createdAt.slice(0, 10))
              if (bucket) bucket.added += 1
            }
          }

          const routeTotals = new Map<string, { calls: number; tokens: number }>()
          const keyTotals = new Map<string, { calls: number; tokens: number }>()
          for (const row of usage) {
            const route = routeTotals.get(row.route) ?? { calls: 0, tokens: 0 }
            route.calls += 1
            route.tokens += row.tokens ?? 0
            routeTotals.set(row.route, route)
            if (row.apiKeyId !== null) {
              const key = keyTotals.get(row.apiKeyId) ?? { calls: 0, tokens: 0 }
              key.calls += 1
              key.tokens += row.tokens ?? 0
              keyTotals.set(row.apiKeyId, key)
            }
          }

          tokenSamples.sort((a, b) => a - b)
          /**
           * Nearest-rank percentile, which is what latency reporting uses.
           *
           * With two samples the median is therefore the larger of the pair, not
           * their average. That is the conservative direction: a budget that looks
           * fine on an average is one that truncates.
           */
          const percentile = (fraction: number): number =>
            tokenSamples.length === 0
              ? 0
              : tokenSamples[Math.min(tokenSamples.length - 1, Math.floor(tokenSamples.length * fraction))] ?? 0
          const medianTokens = percentile(0.5)

          const tensionByStatus = (status: string): number =>
            tensionRows.find((row) => row.status === status)?.total ?? 0

          const weakDomains = Object.values(selfModel?.domains ?? {}).filter(
            (capability) => (capability as { reliabilityScore: number }).reliabilityScore < 0.75
          ).length

          const counted = (totals: Map<string, number>, limit = 12): ReadonlyArray<{ label: string; count: number }> =>
            [...totals.entries()]
              .map(([label, count_]) => ({ label, count: count_ }))
              .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label))
              .slice(0, limit)

          return {
            from: range.from,
            to: range.to,
            days: range.days,
            totals: {
              builds: injections.length,
              tokens,
              medianTokens,
              p95Tokens: percentile(0.95),
              truncated,
              truncatedShare: injections.length === 0 ? 0 : truncated / injections.length,
              utilisation: range.budget <= 0 ? 0 : medianTokens / range.budget,
              memories: stored.length,
              memoriesAdded,
              activeTensions: tensionByStatus("active"),
              resolvedTensions: tensionByStatus("resolved"),
              weakDomains,
              guardrailBuilds,
              activeKeys: keyRows.filter((key) => key.revokedAt === null).length
            },
            daily: days,
            routes: [...routeTotals.entries()]
              .map(([route, totals_]) => ({ route, ...totals_ }))
              .sort((a, b) => b.tokens - a.tokens || b.calls - a.calls),
            keys: keyRows
              .map((key) => ({
                id: key.id,
                name: key.name,
                prefix: key.prefix,
                calls: keyTotals.get(key.id)?.calls ?? 0,
                tokens: keyTotals.get(key.id)?.tokens ?? 0,
                lastUsedAt: key.lastUsedAt,
                revoked: key.revokedAt !== null
              }))
              .sort((a, b) => b.tokens - a.tokens || b.calls - a.calls),
            reasons: counted(reasonTotals, 8),
            tiers: counted(tierTotals),
            domains: counted(domainTotals),
            sources: counted(sourceTotals),
            largest: [...injections]
              .sort((a, b) => b.tokens - a.tokens)
              .slice(0, 5)
              .map((row) => {
                const lines = row.text.split("\n")
                // The first *bullet*, not the first line: the block starts with a
                // `## Memory` heading, which identifies the build as "memory" and
                // therefore tells you nothing about which build it was.
                const preview =
                  lines.find((line) => line.trimStart().startsWith("- ")) ??
                  lines.find((line) => line.trim().length > 0) ??
                  ""
                return {
                  id: row.id,
                  tokens: row.tokens,
                  bodies: row.bodies,
                  truncated: row.truncated,
                  createdAt: row.createdAt,
                  preview: preview.trim().slice(0, 120)
                }
              })
          }
        })

      const recordOutcome: StoreService["recordOutcome"] = (input) =>
        run("MemoryStore.recordOutcome", () => {
          db.insert(domainOutcomes)
            .values({
              id: input.id,
              organizationId: input.organizationId,
              domain: input.domain,
              success: input.success,
              failurePattern: input.failurePattern ?? null,
              strategy: input.strategy ?? null,
              createdAt: isoOf(input.now)
            })
            .run()
        })

      const listOutcomes: StoreService["listOutcomes"] = (organizationId, options = {}) =>
        run("MemoryStore.listOutcomes", () => {
          const conditions = [eq(domainOutcomes.organizationId, organizationId)]
          if (options.domain) conditions.push(eq(domainOutcomes.domain, options.domain))
          return db
            .select()
            .from(domainOutcomes)
            .where(and(...conditions))
            .orderBy(desc(domainOutcomes.createdAt))
            .limit(Math.min(Math.max(options.limit ?? 50, 1), 200))
            .all()
            .map((row) => ({
              id: row.id,
              domain: row.domain,
              success: row.success,
              failurePattern: row.failurePattern,
              strategy: row.strategy,
              createdAt: row.createdAt
            }))
        })

      const deleteOutcomeHistory: StoreService["deleteOutcomeHistory"] = (organizationId, domain) =>
        run("MemoryStore.deleteOutcomeHistory", () =>
          db
            .delete(domainOutcomes)
            .where(and(eq(domainOutcomes.organizationId, organizationId), eq(domainOutcomes.domain, domain)))
            .returning({ id: domainOutcomes.id })
            .all().length
        )

      const pruneHistory: StoreService["pruneHistory"] = (organizationId, retentionDays, now) =>
        run("MemoryStore.pruneHistory", () => {
          // 0 means keep everything, which is a real choice rather than an
          // accident: an audit trail someone needs should not silently vanish.
          if (retentionDays <= 0) return { usage: 0, injections: 0, outcomes: 0 }
          const cutoff = isoOf(now - retentionDays * 86_400_000)
          const usage = db
            .delete(usageEvents)
            .where(and(eq(usageEvents.organizationId, organizationId), lt(usageEvents.createdAt, cutoff)))
            .returning({ id: usageEvents.id })
            .all().length
          const injections = db
            .delete(injectionLogs)
            .where(and(eq(injectionLogs.organizationId, organizationId), lt(injectionLogs.createdAt, cutoff)))
            .returning({ id: injectionLogs.id })
            .all().length
          const outcomes = db
            .delete(domainOutcomes)
            .where(and(eq(domainOutcomes.organizationId, organizationId), lt(domainOutcomes.createdAt, cutoff)))
            .returning({ id: domainOutcomes.id })
            .all().length
          return { usage, injections, outcomes }
        })

      const revokeEveryKey: StoreService["revokeEveryKey"] = (organizationId, now) =>
        run("MemoryStore.revokeEveryKey", () => {
          const timestamp = isoOf(now)
          return db
            .update(apiKeys)
            .set({ revokedAt: timestamp, updatedAt: timestamp })
            .where(and(eq(apiKeys.organizationId, organizationId), sql`${apiKeys.revokedAt} IS NULL`))
            .returning({ id: apiKeys.id })
            .all().length
        })

      return MemoryStore.of({
        listMemories,
        activeMemories,
        getMemory,
        insertMemory,
        updateContent,
        setTier,
        touch,
        touchMany,
        deleteMemory,
        deleteByContent,
        findByContent,
        listTensions,
        upsertTension,
        resolveTension,
        deleteTension,
        getSelfModel,
        putSelfModel,
        findKeyByPrefix,
        createKey,
        listKeys,
        revokeKey,
        markKeyUsed,
        recordUsage,
        stats,
        memoryPage,
        editMemory,
        applyToMemories,
        deleteEveryMemory,
        setTensionStatus,
        getSettings,
        putSettings,
        recordInjection,
        listInjections,
        analytics,
        recordOutcome,
        listOutcomes,
        deleteOutcomeHistory,
        pruneHistory,
        revokeEveryKey
      })
    })
  )
}
