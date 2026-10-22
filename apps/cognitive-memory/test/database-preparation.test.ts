import { afterEach, describe, expect, it, vi } from "vitest"

/**
 * Preparing the database.
 *
 * The preparation applies the schema before anything is served, and it is
 * memoised so that it runs once per process however many things ask for it. A
 * *failed* preparation is not memoised: a deployment whose database was
 * briefly unreachable would otherwise stay broken — every later request would
 * be handed the first failure — until the instance was replaced.
 *
 * The migrator is the one piece mocked, because it is the only part that
 * talks to the database: the point of the test is how often the preparation is
 * attempted, not what the schema looks like afterwards.
 */

const migrate = vi.hoisted(() => vi.fn())

vi.mock("drizzle-orm/libsql/migrator", () => ({ migrate }))

const KEYS = ["COGNITIVE_MEMORY_DATABASE_URL", "DATABASE_URL", "TURSO_AUTH_TOKEN"] as const

afterEach(() => {
  for (const key of KEYS) delete process.env[key]
  migrate.mockReset()
})

describe("preparing the database", () => {
  it("tries again after a failed preparation", async () => {
    process.env.COGNITIVE_MEMORY_DATABASE_URL = "libsql://cogmem-helixhex.aws-us-west-2.turso.io"
    process.env.TURSO_AUTH_TOKEN = "a-token"
    migrate.mockRejectedValueOnce(new Error("the database is unreachable")).mockResolvedValueOnce(undefined)

    const { closeDb, prepareDb } = await import("@/server/db/client")

    await expect(prepareDb()).rejects.toThrow(/unreachable/)
    // The second attempt is a new one, not the first failure handed out again.
    await expect(prepareDb()).resolves.toBeUndefined()

    expect(migrate).toHaveBeenCalledTimes(2)

    closeDb()
  })
})
