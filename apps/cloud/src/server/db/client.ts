import { existsSync } from "node:fs"
import { dirname, join } from "node:path"
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js"
import { migrate } from "drizzle-orm/postgres-js/migrator"
import postgres from "postgres"

import * as authTables from "./auth-tables"
import * as schema from "./schema"

/**
 * The one Postgres connection.
 *
 * A lazily-built module singleton, for the same reason the sibling app holds a
 * single SQLite handle: Better Auth and the Effect services below it must agree
 * on one pool, or every request pays for a second set of prepared statements.
 *
 * Lazy rather than eager, and this is not a stylistic choice. The Better Auth
 * CLI generates the Drizzle schema by importing this module through `jiti`, which
 * loads config in CJS mode — and `postgres` is ESM-only. Building the client on
 * first call means the CLI can import the auth config without ever constructing a
 * driver, and the same trick keeps `next build` runnable on a fresh clone that
 * has no `DATABASE_URL`.
 *
 * Migrations run when the connection is first built, not in a service
 * initialiser. Better Auth's endpoints are reachable without touching any Effect
 * service, so a migration that waited for one would make the first request of a
 * fresh deployment a sign-up — which fails with "relation does not exist" and
 * looks like a broken app rather than an unrun migration.
 */

export type CloudDatabase = PostgresJsDatabase<typeof schema & typeof authTables>

let client: postgres.Sql | null = null
let database: CloudDatabase | null = null
let migrationWarning: string | null = null

export const getClient = (): postgres.Sql => {
  client ??= postgres(process.env.DATABASE_URL!, {
    // A pooler gives you few long-lived connections; a direct connection wants
    // roughly one per concurrent request. Default to the smaller number so a
    // local DATABASE_URL is not mistaken for permission to open 50 sockets.
    max: Number(process.env.DATABASE_POOL_MAX ?? 10),
    idle_timeout: 20,
    connect_timeout: 10,
    // Unnamed prepared statements, for poolers in transaction mode that cannot
    // keep a session-bound prepared statement alive across connections.
    prepare: false
  })
  return client
}

/**
 * Locate the generated migrations.
 *
 * Searched upward rather than hard-coded, because this module is loaded by the
 * dev server (cwd = the app), by `next start` (cwd = wherever it was started) and
 * by scripts under `scripts/`. A path that assumes one of those is a build that
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
    "Could not find the drizzle migrations folder. Run `pnpm db:generate`, or set NAH_CLOUD_MIGRATIONS_FOLDER."
  )
}

export const migrationsFolderFromEnv = (): string =>
  process.env.NAH_CLOUD_MIGRATIONS_FOLDER?.trim() || migrationsFolder()

const applyMigrations = (db: CloudDatabase): void => {
  try {
    migrate(db, { migrationsFolder: migrationsFolderFromEnv() })
  } catch (error) {
    // Worth surviving: a build-time process with no reachable database should
    // still produce a build, and the next writable process migrates on startup.
    // Loud, because the alternative is a confusing "relation does not exist" on
    // the first real request.
    const message = error instanceof Error ? error.message : String(error)
    if (migrationWarning !== message) {
      migrationWarning = message
      process.emitWarning(
        `nah-cloud: could not apply migrations (${message}). The database must be migrated before serving.`
      )
    }
  }
}

export const getDb = (): CloudDatabase => {
  if (database === null) {
    database = drizzle(getClient(), { schema: { ...schema, ...authTables } })
    applyMigrations(database)
  }
  return database
}

/** A separate, migrated connection. For tests. */
export const openMigratedDb = (url: string): CloudDatabase => {
  const db = drizzle(postgres(url, { max: 1, prepare: false }), {
    schema: { ...schema, ...authTables }
  })
  migrate(db, { migrationsFolder: migrationsFolderFromEnv() })
  return db
}

/** Drop the connection. Used by tests, and by anything that swaps the URL. */
export const closeDb = async (): Promise<void> => {
  await client?.end({ timeout: 5 })
  client = null
  database = null
}