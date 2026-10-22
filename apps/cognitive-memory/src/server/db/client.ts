import { existsSync, mkdirSync } from "node:fs"
import { dirname, join } from "node:path"
import { createClient, type Client } from "@libsql/client"
import { drizzle, type LibSQLDatabase } from "drizzle-orm/libsql"
import { migrate } from "drizzle-orm/libsql/migrator"

import { readCognitiveMemorySettings } from "../config"
import { isRemoteDatabaseUrl, localDatabasePath, toDatabaseUrl } from "./database-url"
import { schema } from "./schema"

/**
 * The one database connection.
 *
 * A module-level singleton rather than a per-request one, because there are two
 * consumers that must agree: Better Auth, which is constructed at module scope,
 * and the Effect services below it. Two connections to the same database would
 * mean two sets of prepared statements and two chances to deadlock on a write.
 *
 * The driver is `@libsql/client`, which speaks to a local file and to a remote
 * Turso database over the same interface. That matters because the two are not
 * interchangeable at the call site: a local file is opened synchronously by the
 * old driver, a Turso database is not opened at all, it is asked over HTTP. One
 * driver means the query surface is written once and works in both places.
 *
 * Everything that touches the database is therefore asynchronous, and the
 * schema is applied by `prepareDb` — see the note there for why that is not
 * done while the connection is built.
 */

export type CognitiveMemoryDatabase = LibSQLDatabase<typeof schema>

let client: Client | null = null
let database: CognitiveMemoryDatabase | null = null
let preparation: Promise<void> | null = null
let preparationWarning: string | null = null

const openClient = (): Client => {
  const { databaseUrl, databaseAuthToken } = readCognitiveMemorySettings()
  // The client creates the file, not the directory holding it.
  const path = localDatabasePath(databaseUrl)
  if (path !== null) mkdirSync(dirname(path), { recursive: true })
  return createClient({
    url: databaseUrl,
    // A remote database needs one; a local file must not be handed a token.
    ...(databaseAuthToken !== null && isRemoteDatabaseUrl(databaseUrl)
      ? { authToken: databaseAuthToken }
      : {})
  })
}

export const getClient = (): Client => {
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

export const getDb = (): CognitiveMemoryDatabase => {
  if (database === null) {
    database = drizzle(getClient(), { schema })
  }
  return database
}

/**
 * Prepare the connection: pragmas first, then the pending migrations.
 *
 * This used to happen while the connection was built, which was safe when the
 * database was a file and the driver was synchronous. It is not safe now: a
 * Turso database is asked over HTTP, so the migration is a promise, and Better
 * Auth's endpoints are reachable without ever touching an Effect service. A
 * migration that waited for a service initialiser would let the very first
 * request of a fresh deployment be `sign-up`, which fails with "no such table:
 * user" and looks like a broken app rather than an unrun migration.
 *
 * So the work is done here, awaited by everything that can reach the database:
 * the startup hook, the Effect layer, and the auth handler. The promise is
 * memoised, so it runs once per process however many of those ask.
 */
export const prepareDb = (): Promise<void> => {
  preparation ??= applyPragmasAndMigrations(false)
  return preparation
}

/**
 * Apply the pending migrations, and fail if they do not apply.
 *
 * `prepareDb` is the forgiving version: a build on a read-only filesystem still
 * builds, and the first writable process migrates on startup. A migration run
 * on purpose — `pnpm db:migrate` — is not that. It either applies the schema or
 * it says why it could not.
 */
export const migrateDb = async (): Promise<void> => {
  // The memoised attempt may have failed and been swallowed; a deliberate run
  // gets its own try.
  preparation = null
  await applyPragmasAndMigrations(true)
}

const applyPragmasAndMigrations = async (strict: boolean): Promise<void> => {
  const { databaseUrl } = readCognitiveMemorySettings()
  try {
    if (!isRemoteDatabaseUrl(databaseUrl)) {
      const opened = getClient()
      // WAL keeps a reader from blocking the writer, which matters as soon as
      // two agents share an organisation.
      await opened.execute("PRAGMA journal_mode = WAL")
      // Foreign keys are off by default in SQLite. The migrator turns them off
      // around its own transaction and back on afterwards, but a database that
      // has never been migrated still has to enforce them.
      await opened.execute("PRAGMA foreign_keys = ON")
    }
    // Idempotent: drizzle skips whatever the `__drizzle_migrations` table
    // already records, so this costs one read on a warm database.
    await migrate(getDb(), { migrationsFolder: migrationsFolder() })
  } catch (error) {
    // Worth surviving: a read-only filesystem at build time should still produce
    // a build, and the next writable process migrates on startup. Loud, because
    // the alternative is a confusing "no such table" on the first request.
    if (strict) throw error
    const message = error instanceof Error ? error.message : String(error)
    if (preparationWarning !== message) {
      preparationWarning = message
      process.emitWarning(
        `cognitive-memory: could not prepare the database (${message}). The database must be migrated before serving.`
      )
    }
  }
}

/**
 * A separate, migrated connection.
 *
 * For tests, which want their own database while leaving the process-wide one
 * untouched. Migrations are applied for the same reason they are on the main
 * path: a test that runs against an empty schema fails for a reason that has
 * nothing to do with what it is testing.
 */
export const openMigratedDb = async (filename = ":memory:"): Promise<CognitiveMemoryDatabase> => {
  const opened = drizzle(createClient({ url: toDatabaseUrl(filename) }), { schema })
  await migrate(opened, { migrationsFolder: migrationsFolder() })
  return opened
}

/** Drop the connection. Used by tests, and by anything that swaps the database. */
export const closeDb = (): void => {
  client?.close()
  client = null
  database = null
  preparation = null
}
