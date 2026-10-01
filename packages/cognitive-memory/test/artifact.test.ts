import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { readFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

/**
 * The built package, consumed the way a user consumes it.
 *
 * Everything else in this suite imports from `src`, which means it cannot catch
 * the failures that only exist in the artifact: an `exports` map pointing at
 * files that were never emitted, a peer dependency that is not really external,
 * or a minifier quietly renaming an error class so monitoring groups on `"h"`.
 *
 * Each check here failed for real during development, which is the argument for
 * having them.
 */

const root = resolve(import.meta.dirname, "..")
const dist = join(root, "dist")

// Inside the package, not in the OS temp directory: the consumer has to resolve
// `ofetch` from this package's own node_modules, which is also how a real
// consumer resolves it — and a scratch dir under /tmp would resolve nothing.
const pkgName = (JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { name: string }).name

const cache = join(root, "node_modules", ".cache")
mkdirSync(cache, { recursive: true })
const scratch = mkdtempSync(join(cache, "artifact-"))

beforeAll(async () => {
  // The artifact under test, built the same way `pnpm build` does it.
  execFileSync("npx", ["vite", "build"], { cwd: root, stdio: "ignore" })

  const consumer = join(scratch, "consumer")
  mkdirSync(consumer, { recursive: true })
  writeFileSync(
    join(consumer, "package.json"),
    JSON.stringify({ name: "consumer", private: true, type: "module", dependencies: {} })
  )

  // Imported by package name, not by path. Node's self-reference rule resolves it
  // from inside the package, so this exercises the `name` and the `exports` map
  // together with the emitted files — a rename that left either stale would fail
  // here rather than on someone's `npm install`.
  writeFileSync(
    join(consumer, "check.mjs"),
    `
import {
  Cogmem,
  CognitiveMemory,
  CognitiveMemoryError,
  createClient,
  createHttpClient,
  runTurn,
  recallOrExplain,
  seedMemories
} from "${pkgName}"

const out = []
const record = (label, value) => out.push([label, value])

record("client class exported", typeof Cogmem === "function")
record("engine exported", typeof CognitiveMemory === "function")
record("factory exported", typeof createClient === "function")
record("http factory exported", typeof createHttpClient === "function")
record("helpers exported",
  typeof runTurn === "function" && typeof recallOrExplain === "function" && typeof seedMemories === "function")

// A minifier renames classes, and monitoring identifies an error class by
// \`constructor.name\`. This is the only place that can be observed.
record("error class keeps its name", CognitiveMemoryError.name === "CognitiveMemoryError")

const instance = new CognitiveMemoryError("boom", { status: 429, code: "TooManyRequests" })
record("error predicates work", instance.isRateLimitError() && !instance.isAuthError())
record("error carries its fields", instance.status === 429 && instance.code === "TooManyRequests")

const client = createClient({ apiKey: "cmi_dev_00000000_secret", baseUrl: "http://127.0.0.1:1" })
record("createClient builds a Cogmem", client instanceof Cogmem)

// The engine must be constructible with no configuration at all: it is the
// fallback path for anyone running memory without a service.
const engine = new CognitiveMemory()
record("engine runs with no options", engine.getPromptContext() === "")
record("resources present",
  Boolean(client.memories && client.context && client.recall && client.turns &&
    client.tensions && client.selfModel && client.stats))

// A transport failure has no response, so it must not be dressed up as an API
// error: the difference between "the network is down" and "your key is wrong" is
// the difference between a retry and a support ticket.
try {
  await client.memories.list()
  record("transport failure throws", false)
} catch (error) {
  record("transport failure stays a transport failure", !(error instanceof CognitiveMemoryError))
}

process.stdout.write(JSON.stringify(out))
`
  )

  execFileSync("npx", ["esbuild", "--bundle", "--platform=node", "--format=esm", "--external:ofetch", "check.mjs", "--outfile=bundle.mjs"], {
    cwd: consumer,
    stdio: "ignore"
  })
}, 300_000)

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true })
})

/** Run the bundled consumer and return its recorded results. */
const runConsumer = (): Array<[string, boolean]> => {
  const output = execFileSync("node", ["bundle.mjs"], { cwd: join(scratch, "consumer"), encoding: "utf8" })
  return JSON.parse(output) as Array<[string, boolean]>
}

describe("the published artifact", () => {
  it("exports what the README tells people to import", () => {
    const results = new Map(runConsumer())
    for (const label of [
      "client class exported",
      "engine exported",
      "createClient builds a Cogmem",
      "engine runs with no options",
      "factory exported",
      "http factory exported",
      "helpers exported",
      "error class keeps its name",
      "error predicates work",
      "error carries its fields",
      "resources present",
      "transport failure stays a transport failure"
    ]) {
      expect(results.get(label), label).toBe(true)
    }
  })

  it("emits the files its exports map points at", () => {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
      exports: { ".": { import: string; require: string; types: string } }
    }
    for (const [condition, target] of Object.entries(pkg.exports["."])) {
      expect(() => execFileSync("test", ["-f", join(root, target)]), condition).not.toThrow()
    }
  })
})
