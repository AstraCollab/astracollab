import { migrate } from "drizzle-orm/better-sqlite3/migrator"

import { closeDb, getDb, migrationsFolder } from "../src/server/db/client"

/**
 * Apply pending migrations without starting the app.
 *
 * The app migrates itself on first use, so this exists for the cases where you
 * want the schema in place before anything serves a request: CI, a container
 * entrypoint, or checking a migration in before deploying it.
 *
 *   pnpm db:migrate
 */

migrate(getDb(), { migrationsFolder: migrationsFolder() })
closeDb()

process.stdout.write(`migrated ${process.env.COGNITIVE_MEMORY_DATABASE_PATH ?? ".cognitive-memory/CognitiveMemory.sqlite"}\n`)
