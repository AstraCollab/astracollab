import { Context, Effect, Layer } from "effect"

import { getDb, openMigratedDb, type CognitiveMemoryDatabase } from "./client"
import { StorageFailure } from "../domain/errors"

/**
 * The database, as an Effect service.
 *
 * better-sqlite3 is synchronous, so every call is wrapped in `Effect.try`
 * rather than `Effect.tryPromise`: there is no promise to await, and a thrown
 * driver error becomes a typed `StorageFailure` at the call site instead of an
 * unhandled rejection inside a route handler.
 *
 * The connection itself lives in `./client` because Better Auth needs it too,
 * before any Effect program runs.
 */

export interface DatabaseService {
  readonly db: CognitiveMemoryDatabase
  /** Run a synchronous query, mapping a driver throw to a typed failure. */
  readonly run: <A>(operation: string, query: () => A) => Effect.Effect<A, StorageFailure>
}

export class Database extends Context.Service<Database, DatabaseService>()("cognitive-memory/Database") {
  static readonly layer = Layer.effect(
    Database,
    Effect.gen(function* () {
      // Migrations were already applied when the connection was built; see
      // `./client` for why that happens here rather than in this initialiser.
      yield* Effect.sync(() => getDb())

      const run = <A>(operation: string, query: () => A): Effect.Effect<A, StorageFailure> =>
        Effect.try({
          try: query,
          catch: (cause) => new StorageFailure({ operation, cause })
        })

      return Database.of({ db: getDb(), run })
    })
  )

  /** An isolated, migrated in-memory database. Used by the tests. */
  static readonly testLayer = (filename = ":memory:") =>
    Layer.sync(Database, () => {
      const db = openMigratedDb(filename)
      const run = <A>(operation: string, query: () => A): Effect.Effect<A, StorageFailure> =>
        Effect.try({
          try: query,
          catch: (cause) => new StorageFailure({ operation, cause })
        })
      return Database.of({ db, run })
    })
}
