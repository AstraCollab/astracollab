import { existsSync, rmSync } from "node:fs"
import { afterEach, describe, expect, it, vi } from "vitest"

/**
 * Opening the database.
 *
 * The failure this guards against was `ENOENT: no such file or directory,
 * mkdir 'libsql:/'` on the first request of a deployment pointed at a Turso
 * database. The URL was read as a path, the path was read as a directory to
 * create, and the request died before it reached the database at all.
 *
 * A remote database is asked over HTTP. It has no file and therefore no
 * directory, so the client must not try to make one.
 */

const mkdirSync = vi.hoisted(() => vi.fn())

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>()
  // The real call still happens: the mock is here to count the calls, not to
  // stop them, because a local database that has no directory to sit in cannot
  // be opened at all.
  return {
    ...actual,
    default: actual,
    mkdirSync: (...args: Parameters<typeof actual.mkdirSync>) => {
      mkdirSync(...args)
      return actual.mkdirSync(...args)
    }
  }
})

afterEach(() => {
  delete process.env.COGNITIVE_MEMORY_DATABASE_URL
  delete process.env.DATABASE_URL
  delete process.env.TURSO_AUTH_TOKEN
  mkdirSync.mockClear()
})

describe("opening a remote database", () => {
  it("creates no directory for it", async () => {
    process.env.COGNITIVE_MEMORY_DATABASE_URL = "libsql://cogmem-helixhex.aws-us-west-2.turso.io"
    process.env.TURSO_AUTH_TOKEN = "a-token"

    const { closeDb, getClient } = await import("@/server/db/client")
    const client = getClient()

    expect(client).toBeDefined()
    expect(mkdirSync).not.toHaveBeenCalled()
    expect(existsSync("libsql:")).toBe(false)

    closeDb()
  })
})

describe("opening a local database", () => {
  it("creates the directory the file sits in", async () => {
    const directory = `.cognitive-memory-test-${Date.now()}`
    process.env.COGNITIVE_MEMORY_DATABASE_URL = `file:${directory}/cognitive-memory.sqlite`

    const { closeDb, getClient } = await import("@/server/db/client")
    getClient()

    expect(mkdirSync).toHaveBeenCalled()
    expect(existsSync(directory)).toBe(true)

    closeDb()
    rmSync(directory, { recursive: true, force: true })
  })
})

describe("preparing a remote database", () => {
  it("says what is missing rather than letting every query come back 401", async () => {
    // The deployment this exists for: a Turso database with no token set. Every
    // query answers 401 and the operator sees a driver stack trace.
    process.env.COGNITIVE_MEMORY_DATABASE_URL = "libsql://cogmem-helixhex.aws-us-west-2.turso.io"

    const { closeDb, prepareDb } = await import("@/server/db/client")

    await expect(prepareDb()).rejects.toThrow(/no auth token was found/)

    closeDb()
  })

  it("accepts a token carried by the address", async () => {
    // The Turso CLI prints the URL with the token in it; pasting that whole
    // string is the path of least resistance.
    process.env.COGNITIVE_MEMORY_DATABASE_URL = "libsql://127.0.0.1:1?authToken=a-token"

    const { closeDb, prepareDb } = await import("@/server/db/client")

    // Nothing is listening on that port, so the preparation fails — but it
    // fails on the connection, not on a missing token.
    await expect(prepareDb()).rejects.not.toThrow(/no auth token was found/)

    closeDb()
  })
})
