/**
 * nah's memory store: SQLite, with no dependency.
 *
 * `node:sqlite` is built in from Node 22.5 and nah already requires 22.19, so
 * this is a zero-dependency upgrade over the JSON file it replaces — no native
 * module to compile, nothing to download at install, no `postinstall` in a
 * package that ships a binary.
 *
 * Rows rather than one blob per directory, because the thing that made the JSON
 * file awkward was not its size: it was that you could not ask a question of it.
 * Which memories exist for a directory, what is in which tier, when a memory was
 * last used — all one-liners now, and the same SQLite file survives a rebuild
 * where a hashed path might not.
 *
 * The engine's contract is unchanged. It still hands over a
 * `CognitiveMemoryStateSnapshot` and gets one back; the difference is that the
 * snapshot is projected onto rows rather than written as one document, so a
 * future query does not have to deserialise the entire history to use it.
 */
import { createHash } from "node:crypto"
import { DatabaseSync } from "node:sqlite"
import { existsSync, mkdirSync, readFileSync, renameSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

import type { CognitiveMemoryStateSnapshot } from "@astracollab/not-another-harness"

export type MemoryDb = DatabaseSync

const SCHEMA_VERSION = 1

/**
 * One database per working directory, keyed by a hash of its real path.
 *
 * Hashed because a directory name can contain anything, and because the same
 * project reached through a symlink should not end up with two memories.
 */
export const memoryDbPath = (cwd: string): string => {
  const key = createHash("sha1").update(cwd).digest("hex").slice(0, 12)
  return join(homedir(), ".nah", "memory", `${key}.sqlite`)
}

/** The pre-SQLite location, kept so an existing install can be brought forward. */
export const legacyMemoryJsonPath = (cwd: string): string => {
  const key = createHash("sha1").update(cwd).digest("hex").slice(0, 12)
  return join(homedir(), ".nah", "memory", `${key}.json`)
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS memories (
  id              TEXT PRIMARY KEY,
  tier            TEXT NOT NULL,
  content         TEXT NOT NULL,
  bookmark        TEXT NOT NULL,
  gist            TEXT,
  domains         TEXT NOT NULL DEFAULT '[]',
  access_count    INTEGER NOT NULL DEFAULT 0,
  created_at      INTEGER NOT NULL,
  last_accessed_at INTEGER NOT NULL,
  source_session_id TEXT,
  position        INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS memories_tier_idx ON memories (tier);

CREATE TABLE IF NOT EXISTS tensions (
  id                  TEXT PRIMARY KEY,
  status              TEXT NOT NULL,
  claim_a             TEXT NOT NULL,
  claim_b             TEXT NOT NULL,
  impact              TEXT NOT NULL,
  task_relevance      REAL NOT NULL,
  actionable_question TEXT NOT NULL,
  resolution          TEXT
);

CREATE INDEX IF NOT EXISTS tensions_status_idx ON tensions (status);

CREATE TABLE IF NOT EXISTS self_model (
  id                 INTEGER PRIMARY KEY CHECK (id = 1),
  domains            TEXT NOT NULL DEFAULT '{}',
  calibration_factor REAL NOT NULL DEFAULT 1,
  active_domains     TEXT NOT NULL DEFAULT '[]'
);

CREATE TABLE IF NOT EXISTS stats (
  id                 INTEGER PRIMARY KEY CHECK (id = 1),
  total_turns        INTEGER NOT NULL DEFAULT 0,
  predictions_hit    INTEGER NOT NULL DEFAULT 0,
  predictions_total  INTEGER NOT NULL DEFAULT 0,
  tensions_detected  INTEGER NOT NULL DEFAULT 0
);
`

export interface MemoryStoreOptions {
  /** `:memory:` for tests. */
  readonly path: string
}

/**
 * A snapshot read from disk, or `null` when there is nothing yet.
 *
 * `null` and "an empty snapshot" are different: the first means a first run, the
 * second means memory that was deliberately cleared, and conflating them would
 * make a reset impossible.
 */
export class MemoryStore {
  private readonly db: DatabaseSync
  readonly path: string

  constructor(options: MemoryStoreOptions) {
    this.path = options.path
    if (options.path !== ":memory:") {
      mkdirSync(dirname(options.path), { recursive: true })
    }
    this.db = new DatabaseSync(options.path)

    if (options.path !== ":memory:") this.db.exec("PRAGMA journal_mode = WAL")
    this.db.exec("PRAGMA foreign_keys = ON")
    this.db.exec("PRAGMA busy_timeout = 5000")
    this.db.exec(SCHEMA)
    this.db
      .prepare("INSERT OR IGNORE INTO meta (key, value) VALUES ('schema_version', ?)")
      .run(String(SCHEMA_VERSION))
  }

  /** True when this store holds nothing. */
  isEmpty(): boolean {
    const row = this.db.prepare("SELECT COUNT(*) AS n FROM memories").get() as { n: number } | undefined
    return (row?.n ?? 0) === 0
  }

  /**
   * Replace the stored state with a snapshot.
   *
   * Delete-then-insert inside one transaction rather than a diff: the snapshot is
   * the whole truth, the volume is a few hundred rows, and a diff would be two
   * code paths to keep correct for a saving that happens once per turn.
   */
  save(snapshot: CognitiveMemoryStateSnapshot): void {
    this.db.exec("BEGIN IMMEDIATE")
    try {
      this.db.exec("DELETE FROM memories")
      this.db.exec("DELETE FROM tensions")
      this.db.exec("DELETE FROM self_model")
      this.db.exec("DELETE FROM stats")

      const insertMemory = this.db.prepare(
        `INSERT INTO memories
           (id, tier, content, bookmark, gist, domains, access_count, created_at, last_accessed_at, source_session_id, position)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      let position = 0
      for (const item of [...snapshot.l1, ...snapshot.l2, ...snapshot.l3]) {
        insertMemory.run(
          item.id,
          item.tier,
          item.content,
          item.bookmark,
          item.gist ?? null,
          JSON.stringify(item.metadata.domains),
          item.metadata.accessCount,
          item.metadata.createdAt,
          item.metadata.lastAccessedAt,
          item.metadata.sourceSessionId ?? null,
          position
        )
        position += 1
      }

      const insertTension = this.db.prepare(
        `INSERT INTO tensions
           (id, status, claim_a, claim_b, impact, task_relevance, actionable_question, resolution)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      for (const tension of snapshot.l0.tensions) {
        insertTension.run(
          tension.id,
          tension.status,
          JSON.stringify(tension.claimA),
          JSON.stringify(tension.claimB),
          tension.impact,
          tension.taskRelevance,
          tension.actionableQuestion,
          tension.resolution ? JSON.stringify(tension.resolution) : null
        )
      }

      this.db
        .prepare("INSERT INTO self_model (id, domains, calibration_factor, active_domains) VALUES (1, ?, ?, ?)")
        .run(
          JSON.stringify(snapshot.l0.selfModel.domains),
          snapshot.l0.selfModel.calibrationFactor,
          JSON.stringify(snapshot.l0.selfModel.activeDomains)
        )

      this.db
        .prepare("INSERT INTO stats (id, total_turns, predictions_hit, predictions_total, tensions_detected) VALUES (1, ?, ?, ?, ?)")
        .run(
          snapshot.stats.totalTurnsProcessed,
          snapshot.stats.predictionsHit,
          snapshot.stats.predictionsTotal,
          snapshot.stats.tensionsDetected
        )

      this.db
        .prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('active_task_trace', ?)")
        .run(snapshot.l0.activeTaskTrace)

      this.db.exec("COMMIT")
    } catch (error) {
      this.db.exec("ROLLBACK")
      throw error
    }
  }

  /** Read the stored state, or `null` when the store is empty. */
  load(): CognitiveMemoryStateSnapshot | null {
    if (this.isEmpty()) {
      // A store with no memories can still hold self-model state and stats, so
      // only report "nothing here" when there is genuinely nothing anywhere.
      const selfModel = this.db.prepare("SELECT id FROM self_model").get()
      if (!selfModel) return null
    }

    const rows = this.db
      .prepare("SELECT * FROM memories ORDER BY position ASC, last_accessed_at DESC")
      .all() as Array<{
      id: string
      tier: string
      content: string
      bookmark: string
      gist: string | null
      domains: string
      access_count: number
      created_at: number
      last_accessed_at: number
      source_session_id: string | null
    }>

    const toItem = (row: (typeof rows)[number]) => ({
      id: row.id,
      content: row.content,
      bookmark: row.bookmark,
      ...(row.gist === null ? {} : { gist: row.gist }),
      tier: row.tier as "L0" | "L1" | "L2" | "L3",
      metadata: {
        domains: JSON.parse(row.domains) as string[],
        createdAt: row.created_at,
        lastAccessedAt: row.last_accessed_at,
        accessCount: row.access_count,
        ...(row.source_session_id === null ? {} : { sourceSessionId: row.source_session_id })
      }
    })

    const byTier = { L1: [] as ReturnType<typeof toItem>[], L2: [] as ReturnType<typeof toItem>[], L3: [] as ReturnType<typeof toItem>[] }
    for (const row of rows) {
      const item = toItem(row)
      // L0 is not a memory tier: it holds tensions and the self-model, which
      // have their own tables. An L0 row here would mean a bug upstream, so it is
      // dropped rather than smuggled into a tier it does not belong to.
      if (item.tier === "L1") byTier.L1.push(item)
      else if (item.tier === "L2") byTier.L2.push(item)
      else if (item.tier === "L3") byTier.L3.push(item)
    }

    const selfModelRow = this.db.prepare("SELECT * FROM self_model WHERE id = 1").get() as
      | { domains: string; calibration_factor: number; active_domains: string }
      | undefined

    const tensionRows = this.db.prepare("SELECT * FROM tensions").all() as Array<{
      id: string
      status: string
      claim_a: string
      claim_b: string
      impact: string
      task_relevance: number
      actionable_question: string
      resolution: string | null
    }>

    const statsRow = this.db.prepare("SELECT * FROM stats WHERE id = 1").get() as
      | { total_turns: number; predictions_hit: number; predictions_total: number; tensions_detected: number }
      | undefined

    const traceRow = this.db.prepare("SELECT value FROM meta WHERE key = 'active_task_trace'").get() as
      | { value: string }
      | undefined

    return {
      l0: {
        tensions: tensionRows.map((row) => ({
          id: row.id,
          status: row.status as "active" | "latent" | "resolved",
          claimA: JSON.parse(row.claim_a),
          claimB: JSON.parse(row.claim_b),
          impact: row.impact as "low" | "medium" | "critical",
          taskRelevance: row.task_relevance,
          actionableQuestion: row.actionable_question,
          ...(row.resolution === null ? {} : { resolution: JSON.parse(row.resolution) })
        })),
        selfModel: {
          domains: (selfModelRow ? (JSON.parse(selfModelRow.domains) as object) : {}) as never,
          calibrationFactor: selfModelRow?.calibration_factor ?? 1,
          activeDomains: (selfModelRow ? (JSON.parse(selfModelRow.active_domains) as string[]) : [])
        },
        activeTaskTrace: traceRow?.value ?? ""
      },
      l1: byTier.L1,
      l2: byTier.L2,
      l3: byTier.L3,
      stats: {
        totalTurnsProcessed: statsRow?.total_turns ?? 0,
        predictionsHit: statsRow?.predictions_hit ?? 0,
        predictionsTotal: statsRow?.predictions_total ?? 0,
        tensionsDetected: statsRow?.tensions_detected ?? 0
      }
    }
  }

  /**
   * Bring a pre-SQLite JSON memory forward.
   *
   * The original file is renamed rather than deleted. It is the only copy of
   * someone's memory, and a migration that removes the source of truth before the
   * destination is known to be readable is not a migration, it is a coin flip.
   */
  importLegacyJson(cwd: string): { imported: boolean; path?: string } {
    const legacy = legacyMemoryJsonPath(cwd)
    if (!existsSync(legacy)) return { imported: false }

    let snapshot: CognitiveMemoryStateSnapshot
    try {
      snapshot = JSON.parse(readFileSync(legacy, "utf8")) as CognitiveMemoryStateSnapshot
    } catch {
      return { imported: false, path: legacy }
    }
    if (typeof snapshot !== "object" || snapshot === null || !Array.isArray(snapshot.l1)) {
      return { imported: false, path: legacy }
    }

    this.save(snapshot)
    // Only a successful save earns the rename.
    if (this.load() === null) return { imported: false, path: legacy }
    renameSync(legacy, `${legacy}.imported`)
    return { imported: true, path: `${legacy}.imported` }
  }

  /** Count rows per tier, for `/memory` and the status line. */
  counts(): Record<string, number> {
    const rows = this.db
      .prepare("SELECT tier, COUNT(*) AS n FROM memories GROUP BY tier")
      .all() as Array<{ tier: string; n: number }>
    return Object.fromEntries(rows.map((row) => [row.tier, row.n]))
  }

  close(): void {
    this.db.close()
  }
}

/** Open the store for a directory, creating it if needed. */
export const openMemoryStore = (cwd: string): MemoryStore => new MemoryStore({ path: memoryDbPath(cwd) })

/** Test helper: a throwaway in-memory store. */
export const openEphemeralStore = (): MemoryStore => new MemoryStore({ path: ":memory:" })

/** Whether a store file already exists for a directory. */
export const hasStoredMemory = (cwd: string): boolean => {
  const path = memoryDbPath(cwd)
  return existsSync(path) && statSync(path).size > 0
}
