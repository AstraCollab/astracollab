import { copyFileSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

/**
 * Copy the cognitive layer from the published package into the harness.
 *
 * `not-another-harness` ships as a binary and deliberately does not depend on
 * `@astracollab/cogmem`: a published binary that pulls its memory layer from
 * another package inherits that package's release cadence and semver. It carries
 * its own copy instead.
 *
 * A vendored copy is only defensible if it cannot quietly rot, so this script
 * makes the copy mechanical and `test/cognitive-layer-sync.test.ts` fails the
 * build when the two differ. The alternative — a dependency — is worse for a
 * binary; the alternative to a dependency *and* to a check is code that changes
 * in one place and not the other.
 *
 *   pnpm --filter @astracollab/not-another-harness sync:cognitive   # copy
 *   pnpm --filter @astracollab/not-another-harness check:cognitive  # verify
 */

const here = dirname(fileURLToPath(import.meta.url))
const packageRoot = resolve(here, "..")
const repoRoot = resolve(packageRoot, "..", "..")

export const SOURCE = resolve(repoRoot, "packages/cognitive-memory/src/cognitive")
export const TARGET = resolve(packageRoot, "src/cognitive-memory")

/**
 * Every file in the layer, listed from the source directory rather than a
 * hand-maintained array: a file added upstream and forgotten here is precisely
 * the drift this exists to prevent.
 */
const names = (): Array<string> =>
  readdirSync(SOURCE)
    .filter((name) => name.endsWith(".ts") && statSync(join(SOURCE, name)).isFile())
    .sort()

export const copies = (): Array<[from: string, to: string]> =>
  names().map((name) => [join(SOURCE, name), join(TARGET, name)])

/** Files present in the copy but no longer in the source, which must be removed. */
export const orphaned = (): Array<string> => {
  const known = new Set(names())
  return readdirSync(TARGET)
    .filter((name) => name.endsWith(".ts") && !known.has(name) && statSync(join(TARGET, name)).isFile())
    .sort()
}

/** Which files differ, by name. Empty means the vendored copy is current. */
export const driftedFiles = (): Array<string> => {
  const drifted: Array<string> = []
  for (const [from, to] of copies()) {
    const want = readFileSync(from, "utf8")
    if (want.trim() !== readFileSync(to, "utf8").trim()) drifted.push(from.split("/").pop() ?? from)
  }
  return drifted
}

export const sync = (): Array<string> => {
  mkdirSync(TARGET, { recursive: true })
  const copied: Array<string> = []
  for (const [from, to] of copies()) {
    // Clean first: a file removed upstream must not survive in the copy, which
    // is how a vendored directory quietly grows a second history.
    rmSync(to, { force: true })
    copyFileSync(from, to)
    copied.push(to.split("/").pop() ?? to)
  }
  for (const name of orphaned()) rmSync(join(TARGET, name), { force: true })
  return copied
}

const invokedDirectly =
  process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))

if (invokedDirectly) {
  const copied = sync()
  process.stdout.write(`synced ${copied.length} files into src/cognitive-memory:\n`)
  for (const name of copied) process.stdout.write(`  ${name}\n`)
}
