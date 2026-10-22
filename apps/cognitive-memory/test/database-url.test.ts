import { afterEach, describe, expect, it } from "vitest"
import { resolve } from "node:path"

import { readCognitiveMemorySettings } from "@/server/config"
import {
  isRemoteDatabaseUrl,
  localDatabasePath,
  readDatabaseAuthToken,
  toDatabaseUrl
} from "@/server/db/database-url"

/**
 * Where the database lives.
 *
 * The deployment this was written for runs on a serverless function with no
 * filesystem worth writing to, so its database is a Turso database reached over
 * HTTP. The address of that database is a URL, and the service used to treat it
 * as a path: the first request of a deployment with `DATABASE_URL` set died
 * with `ENOENT: mkdir 'libsql:/'`, because the code tried to create the
 * directory the URL named.
 *
 * So the shape of the address decides what happens to it, and these are the
 * cases that decide it.
 */

const KEYS = [
  "COGNITIVE_MEMORY_DATABASE_URL",
  "COGNITIVE_MEMORY_DATABASE_PATH",
  "DATABASE_URL",
  "TURSO_AUTH_TOKEN",
  "DATABASE_AUTH_TOKEN",
  "COGNITIVE_MEMORY_DATABASE_AUTH_TOKEN"
] as const

afterEach(() => {
  for (const key of KEYS) delete process.env[key]
})

describe("the database address", () => {
  it("keeps a Turso URL as a URL", () => {
    const url = "libsql://cogmem-helixhex.aws-us-west-2.turso.io"

    expect(toDatabaseUrl(url)).toBe(url)
    expect(isRemoteDatabaseUrl(url)).toBe(true)
  })

  it("has no directory to create for a remote database", () => {
    // This is the bug: a remote database is asked over HTTP, so there is no
    // file, and therefore no directory to make.
    expect(localDatabasePath("libsql://cogmem-helixhex.aws-us-west-2.turso.io")).toBeNull()
  })

  it("turns a bare path into a file URL, because a path is still a path", () => {
    const url = toDatabaseUrl(".cognitive-memory/cognitive-memory.sqlite")

    expect(url.startsWith("file:")).toBe(true)
    expect(url.endsWith(".cognitive-memory/cognitive-memory.sqlite")).toBe(true)
    // Absolute, because a bundled serverless function does not necessarily run
    // from the directory the path was written for.
    expect(localDatabasePath(url)).toBe(resolve(".cognitive-memory/cognitive-memory.sqlite"))
  })

  it("keeps a file URL as it is", () => {
    const url = "file:/tmp/cognitive-memory.sqlite"

    expect(toDatabaseUrl(url)).toBe(url)
    expect(localDatabasePath(url)).toBe("/tmp/cognitive-memory.sqlite")
  })

  it("has no file for an in-memory database", () => {
    expect(toDatabaseUrl(":memory:")).toBe("file::memory:")
    expect(localDatabasePath("file::memory:")).toBeNull()
  })
})

describe("the token a remote database is reached with", () => {
  it("reads Turso's own name for it first", () => {
    expect(readDatabaseAuthToken({ TURSO_AUTH_TOKEN: "turso-token" })).toBe("turso-token")
  })

  it("falls back to the other two names for it", () => {
    expect(readDatabaseAuthToken({ DATABASE_AUTH_TOKEN: "database-token" })).toBe("database-token")
    expect(readDatabaseAuthToken({ COGNITIVE_MEMORY_DATABASE_AUTH_TOKEN: "own-token" })).toBe("own-token")
  })

  it("has none for a local file", () => {
    expect(readDatabaseAuthToken({})).toBeNull()
  })
})

describe("the settings a deployment is read from", () => {
  it("reads a remote database from DATABASE_URL", () => {
    process.env.DATABASE_URL = "libsql://cogmem-helixhex.aws-us-west-2.turso.io"
    process.env.TURSO_AUTH_TOKEN = "turso-token"

    const config = readCognitiveMemorySettings()

    expect(config.databaseUrl).toBe("libsql://cogmem-helixhex.aws-us-west-2.turso.io")
    expect(config.databaseAuthToken).toBe("turso-token")
    expect(config.problems).toEqual([])
  })

  it("lets the app's own variable win over DATABASE_URL", () => {
    process.env.COGNITIVE_MEMORY_DATABASE_URL = "libsql://first.turso.io"
    process.env.DATABASE_URL = "libsql://second.turso.io"

    expect(readCognitiveMemorySettings().databaseUrl).toBe("libsql://first.turso.io")
  })

  it("lets DATABASE_URL win over a local path left over from a copied .env", () => {
    // A deployment that sets DATABASE_URL means "this one has a remote
    // database". A path that was copied into .env.local must not quietly
    // send it back to a file it cannot write.
    process.env.DATABASE_URL = "libsql://cogmem-helixhex.aws-us-west-2.turso.io"
    process.env.COGNITIVE_MEMORY_DATABASE_PATH = ".cognitive-memory/cognitive-memory.sqlite"

    expect(readCognitiveMemorySettings().databaseUrl).toBe("libsql://cogmem-helixhex.aws-us-west-2.turso.io")
  })

  it("falls back to the local path when no URL is set", () => {
    process.env.COGNITIVE_MEMORY_DATABASE_PATH = ".cognitive-memory/cognitive-memory.sqlite"

    expect(readCognitiveMemorySettings().databaseUrl).toBe(
      `file:${resolve(".cognitive-memory/cognitive-memory.sqlite")}`
    )
  })

  it("says so when a remote database has no token", () => {
    // Without one every query comes back unauthorised, which is a great deal
    // harder to read than a sentence about a missing variable.
    process.env.DATABASE_URL = "libsql://cogmem-helixhex.aws-us-west-2.turso.io"

    const config = readCognitiveMemorySettings()

    expect(config.databaseAuthToken).toBeNull()
    expect(config.problems.join(" ")).toMatch(/no auth token was found/)
  })
})
