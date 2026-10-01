import { and, count, desc, eq, inArray, sql } from "drizzle-orm"
import { Context, Effect, Layer } from "effect"

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
import { apiKeys, memories, selfModels, tensions, usageEvents } from "../db/schema"
import type { DomainCapability as DomainCapabilityShape } from "../db/schema"

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

      return MemoryStore.of({
        listMemories,
        activeMemories,
        getMemory,
        insertMemory,
        updateContent,
        setTier,
        touch,
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
        stats
      })
    })
  )
}
