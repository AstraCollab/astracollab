import { Effect, Layer, ManagedRuntime } from "effect"

import { organization } from "@/server/db/auth-tables"
import { Database } from "@/server/db/database"
import { MemoryEngine, engineLayer } from "@/server/engine/memory-engine"
import { TurnExtractor } from "@/server/engine/turn-extractor"
import { Keys } from "@/server/services/keys"
import { MemoryStore } from "@/server/services/memory-store"

/**
 * Test wiring.
 *
 * Every test runs against a real SQLite database and the real service graph, in
 * memory. A fake store would test the fake: the failures worth catching here are
 * SQL-level — a missing tenant filter, a JSON column that does not round-trip, a
 * foreign key that is not enforced — and none of them survive a mock.
 *
 * The model extractor is stubbed so the tests describe the engine rather than a
 * provider's behaviour, and so they never touch the network.
 */

export const ORGANIZATION_ID = "org_test"

/** A runtime over a fresh in-memory database, with the tenant seeded. */
export const makeTestRuntime = () => {
  const extractor = TurnExtractor.of({
    extract: Effect.fnUntraced(function* () {
      return { memories: [], tensions: [] }
    }),
    reconcile: Effect.fnUntraced(function* (input: {
      readonly items: ReadonlyArray<{ readonly candidate: string; readonly remember: ReadonlyArray<string> }>
    }) {
      return input.items.map(() => ({ action: "add" as const }))
    }),
    mode: Effect.succeed("rules-only" as const)
  })

  const layer = Layer.mergeAll(
    engineLayer,
    Keys.layer,
    Layer.succeed(TurnExtractor, extractor)
  ).pipe(
    Layer.provideMerge(MemoryStore.layer),
    // provideMerge, not provide: the tests seed the organisation row themselves,
    // so they need `Database` in context as well as in the store.
    Layer.provideMerge(Database.testLayer())
  )

  return ManagedRuntime.make(layer, { memoMap: Layer.makeMemoMapUnsafe() })
}

/**
 * Insert the organisation row that `api_keys.organization_id` and every memory
 * table point at.
 *
 * Seeds a real row rather than disabling foreign keys: the constraint is part of
 * the isolation guarantee, and a test suite that turns it off stops testing it.
 */
export const seedOrganization = Effect.fnUntraced(function* (id: string) {
  const db = yield* Database
  yield* db.run("test.seedOrganization", () => {
    db.db
      .insert(organization)
      .values({ id, name: "Test Org", slug: `test-${id}`, createdAt: new Date() })
      .onConflictDoNothing()
      .run()
  })
})

export { Database, Keys, MemoryEngine, MemoryStore, TurnExtractor }
