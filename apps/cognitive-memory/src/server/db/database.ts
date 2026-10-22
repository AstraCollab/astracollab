import { Context, Effect, Layer } from "effect"

import { getDb, openMigratedDb, prepareDb, type CognitiveMemoryDatabase } from "./client"
import { StorageFailure } from "../domain/errors"

/**
 * The database, as an Effect service.
 *
 * Every query is a promise, because the database may be a Turso database
 * reached over HTTP. A driver error becomes a typed `StorageFailure` at the
 * call site instead of an unhandled rejection inside a route handler.
 *
 * The connection itself lives in `./client` because Better Auth needs it too,
 * before any Effect program runs.
 */

export interface DatabaseService {
  readonly db: CognitiveMemoryDatabase
  /** Run a query, mapping a driver failure to a typed failure. */
  readonly run: <A>(operation: string, query: () => A | Promise<A>) => Effect.Effect<A, StorageFailure>
}

export class Database extends Context.Service<Database, DatabaseService>()("cognitive-memory/Database") {
  static readonly layer = Layer.effect(
    Database,
    Effect.gen(function* () {
      // The schema is applied before anything is served; see `./client` for why
      // that happens there rather than in this initialiser.
      yield* Effect.promise(() => prepareDb())

      const run = <A>(operation: string, query: () => A | Promise<A>): Effect.Effect<A, StorageFailure> =>
        Effect.tryPromise({
          // `async` rather than `Promise.resolve(query())`: a query that throws
          // before it returns a promise has to be caught here too.
          try: async () => (await query()) as A,
          catch: (cause) => new StorageFailure({ operation, cause })
        })

      return Database.of({ db: getDb(), run })
    })
  )

  /** An isolated, migrated in-memory database. Used by the tests. */
  static readonly testLayer = (filename = ":memory:") =>
    Layer.effect(
      Database,
      Effect.gen(function* () {
        const db = yield* Effect.promise(() => openMigratedDb(filename))
        const run = <A>(operation: string, query: () => A | Promise<A>): Effect.Effect<A, StorageFailure> =>
          Effect.tryPromise({
            try: async () => (await query()) as A,
            catch: (cause) => new StorageFailure({ operation, cause })
          })
        return Database.of({ db, run })
      })
    )
}
