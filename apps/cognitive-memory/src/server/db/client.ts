import { existsSync, mkdirSync } from "node:fs"
import { dirname, join } from "node:path"
import BetterSqlite3 from "better-sqlite3"
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3"
import { migrate } from "drizzle-orm/better-sqlite3/migrator"

import { readCognitiveMemorySettings } from "../config"
import { schema } from "./schema"

/**
 * The one SQLite connection.
 *
 * A module-level singleton rather than a per-request one, because there are two
 * consumers that must agree: Better Auth, which is constructed at module scope,
 * and the Effect services below it. Two connections to the same file would mean
 * two sets of prepared statements and two chances to deadlock on a write.
 *
 * Migrations run here, synchronously, the first time the connection is built —
 * not in a service initialiser. Better Auth's endpoints are reachable without
 * ever touching an Effect service, so a migration that waited for one would let
 * the very first request of a fresh deployment be `sign-up`, which fails with
 * "no such table: user" and looks like a broken app rather than an unrun
 * migration.
 */

export type CognitiveMemoryDatabase = BetterSQLite3Database<typeof schema>

let client: BetterSqlite3.Database | null = null
let database: CognitiveMemoryDatabase | null = null
let migrationWarning: string | null = null

const openClient = (): BetterSqlite3.Database => {
  const { databasePath } = readCognitiveMemorySettings()
  if (databasePath !== ":memory:") {
    // A fresh clone has no `.cognitive-memory/`, and better-sqlite3 creates the file, not
    // the directory holding it.
    mkdirSync(dirname(databasePath), { recursive: true })
  }
  const opened = new BetterSqlite3(databasePath)
  // WAL keeps a reader from blocking the writer, which matters as soon as two
  // agents share an organisation.
  if (databasePath !== ":memory:") opened.pragma("journal_mode = WAL")
  opened.pragma("foreign_keys = ON")
  opened.pragma("busy_timeout = 5000")
  return opened
}

export const getClient = (): BetterSqlite3.Database => {
  client ??= openClient()
  return client
}

/**
 * Locate the generated migrations.
 *
 * Searched rather than hard-coded, because the same module is loaded by the dev
 * server (cwd = the app), by `next start` (cwd = wherever it was started) and by
 * a script under `scripts/`. A path that assumes one of those is a build that
 * works locally and fails in a container.
 */
export const migrationsFolder = (): string => {
  let dir = process.cwd()
  for (let depth = 0; depth < 6; depth += 1) {
    const candidate = join(dir, "drizzle")
    if (existsSync(join(candidate, "meta", "_journal.json"))) return candidate
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  throw new Error(
    "Could not find the drizzle migrations folder. Run `pnpm db:generate`, or set COGNITIVE_MEMORY_MIGRATIONS_FOLDER."
  )
}

/**
 * Apply pending migrations. Idempotent: drizzle skips whatever the
 * `__drizzle_migrations` table already records, so this costs one read on a warm
 * database.
 */
const applyMigrations = (db: BetterSQLite3Database<typeof schema>): void => {
  try {
    migrate(db, { migrationsFolder: migrationsFolder() })
  } catch (error) {
    // Worth surviving: a read-only filesystem at build time should still produce
    // a build, and the next writable process migrates on startup. Loud, because
    // the alternative is a confusing "no such table" on the first request.
    const message = error instanceof Error ? error.message : String(error)
    if (migrationWarning !== message) {
      migrationWarning = message
      process.emitWarning(
        `cognitive-memory: could not apply migrations (${message}). The database must be migrated before serving.`
      )
    }
  }
}

export const getDb = (): CognitiveMemoryDatabase => {
  if (database === null) {
    database = drizzle(getClient(), { schema })
    applyMigrations(database)
  }
  return database
}

/**
 * A separate, migrated connection.
 *
 * For tests, which want their own database while leaving the process-wide one
 * untouched. Migrations are applied for the same reason they are on the main
 * path: a test that runs against an empty schema fails for a reason that has
 * nothing to do with what it is testing.
 */
export const openMigratedDb = (filename: string): BetterSQLite3Database<typeof schema> => {
  const db = drizzle(new BetterSqlite3(filename), { schema })
  migrate(db, { migrationsFolder: migrationsFolder() })
  return db
}

/** Drop the connection. Used by tests, and by anything that swaps the path. */
export const closeDb = (): void => {
  client?.close()
  client = null
  database = null
}
