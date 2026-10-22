import { readCognitiveMemorySettings } from "../src/server/config"
import { closeDb, migrateDb } from "../src/server/db/client"
import { loadEnv } from "./env"

/**
 * Apply pending migrations without starting the app.
 *
 * The app migrates itself on first use, so this exists for the cases where you
 * want the schema in place before anything serves a request: CI, a container
 * entrypoint, or checking a migration in before deploying it.
 *
 *   pnpm db:migrate
 *
 * Unlike the startup path, this one fails when the migration fails. A script
 * that reports success while the schema is still missing is worse than no
 * script.
 */

const main = async (): Promise<void> => {
  // tsx loads no environment of its own, and a migration that runs against a
  // different database than the app is the one thing this script must not do.
  loadEnv()
  const { databaseUrl } = readCognitiveMemorySettings()
  // The driver is asynchronous now, so the schema is applied by a promise the
  // caller awaits rather than by the connection being built.
  await migrateDb()
  closeDb()
  process.stdout.write(`migrated ${databaseUrl}\n`)
}

main().catch((error: unknown) => {
  process.stderr.write(`FAILED: ${error instanceof Error ? error.stack : String(error)}\n`)
  process.exitCode = 1
})
