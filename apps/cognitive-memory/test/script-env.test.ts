import { afterEach, describe, expect, it } from "vitest"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { loadEnv } from "../scripts/env"

/**
 * The environment a script under `scripts/` runs with.
 *
 * Next.js loads `.env` for the app; tsx loads nothing. A migration that ran
 * without them applied the schema to the local file the app falls back to,
 * while the deployment talked to Turso — the schema in one place, looked for in
 * another, with nothing to say so.
 */

const KEYS = ["COGNITIVE_MEMORY_DATABASE_URL", "DATABASE_URL", "TURSO_AUTH_TOKEN"] as const

const directoryWith = (files: Record<string, string>): string => {
  const dir = mkdtempSync(join(tmpdir(), "cognitive-memory-env-"))
  for (const [name, contents] of Object.entries(files)) writeFileSync(join(dir, name), contents)
  return dir
}

afterEach(() => {
  for (const key of KEYS) delete process.env[key]
})

describe("the environment a script runs with", () => {
  it("reads .env, which tsx does not", () => {
    const dir = directoryWith({
      ".env": "COGNITIVE_MEMORY_DATABASE_URL=libsql://from-the-env-file\n"
    })

    loadEnv(dir)

    expect(process.env.COGNITIVE_MEMORY_DATABASE_URL).toBe("libsql://from-the-env-file")
  })

  it("reads .env.local over .env", () => {
    const dir = directoryWith({
      ".env": "COGNITIVE_MEMORY_DATABASE_URL=libsql://from-env\n",
      ".env.local": "COGNITIVE_MEMORY_DATABASE_URL=libsql://from-env-local\n"
    })

    loadEnv(dir)

    expect(process.env.COGNITIVE_MEMORY_DATABASE_URL).toBe("libsql://from-env-local")
  })

  it("lets a real environment variable win over both", () => {
    // A deployment sets the address in the environment. A file left over from a
    // local run must not send the migration somewhere else.
    process.env.COGNITIVE_MEMORY_DATABASE_URL = "libsql://from-the-environment"
    const dir = directoryWith({
      ".env": "COGNITIVE_MEMORY_DATABASE_URL=libsql://from-env\n",
      ".env.local": "COGNITIVE_MEMORY_DATABASE_URL=libsql://from-env-local\n"
    })

    loadEnv(dir)

    expect(process.env.COGNITIVE_MEMORY_DATABASE_URL).toBe("libsql://from-the-environment")
  })

  it("does nothing when there is no file to read", () => {
    const dir = directoryWith({})

    loadEnv(dir)

    expect(process.env.COGNITIVE_MEMORY_DATABASE_URL).toBeUndefined()
  })
})
