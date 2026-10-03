import { drizzle } from "drizzle-orm/postgres-js"
import { migrate } from "drizzle-orm/postgres-js/migrator"
import postgres from "postgres"

import * as authTables from "../src/server/db/auth-tables"
import * as schema from "../src/server/db/schema"
import { migrationsFolderFromEnv } from "../src/server/db/client"

/**
 * Apply pending migrations and exit.
 *
 * Separate from `next build` on purpose: a deploy should migrate exactly once,
 * before new code starts, rather than having every instance race to do it on
 * first request. The runtime still migrates lazily as a fallback for local
 * development.
 *
 * Wrapped in an async `main` rather than using top-level await, because this
 * file runs under `tsx` outside the Next.js ESM pipeline and so compiles as CJS,
 * where top-level await is a syntax error.
 */
const main = async (): Promise<void> => {
  const url = process.env.DATABASE_URL
  if (!url) throw new Error("DATABASE_URL is required to migrate.")

  const client = postgres(url, { max: 1, prepare: false })
  try {
    // The migrator reads migrations off the database object, so it needs a
    // Drizzle instance — passing the raw postgres.js client fails at runtime with
    // "Cannot read properties of undefined (reading 'migrate')". The schema is
    // not read by `migrate`, but is required for the instance to type-check.
    await migrate(drizzle(client, { schema: { ...schema, ...authTables } }), {
      migrationsFolder: migrationsFolderFromEnv()
    })
    console.log("migrations applied")
  } finally {
    await client.end({ timeout: 5 })
  }
}

main().catch((error: unknown) => {
  console.error(error)
  process.exit(1)
})
