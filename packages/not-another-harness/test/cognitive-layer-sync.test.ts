import { describe, expect, it } from "vitest"

import { copies, driftedFiles, orphaned, SOURCE, TARGET } from "../scripts/sync-cognitive.js"

/**
 * The vendored copy has to be exactly the published one.
 *
 * This package ships as a binary and does not depend on `@astracollab/cogmem` on
 * purpose, which means the layer exists in two places. A vendored copy is only
 * defensible if the build catches it when the two disagree — otherwise the two
 * implementations drift and the CLI quietly ranks memories differently from the
 * service that is supposed to agree with it.
 *
 * Fix a failure here with `pnpm sync:cognitive`, never by hand-editing
 * `src/cognitive-memory/`.
 */
describe("vendored cognitive layer", () => {
  it("has a source to copy from", () => {
    expect(copies().length).toBeGreaterThan(0)
  })

  it("is identical to packages/cognitive-memory/src/cognitive", () => {
    expect(driftedFiles()).toEqual([])
  })

  it("has no files the source no longer has", () => {
    expect(orphaned()).toEqual([])
  })

  it("does not import the package it vendors", () => {
    // A dependency would defeat the point: the binary would inherit another
    // package's release cadence and semver.
    const source = copies()
      .map(([from]) => from)
      .map((path) => SOURCE.slice(0, 0) + path)
    expect(source.length).toBeGreaterThan(0)
    for (const path of source) {
      const { readFileSync } = require("node:fs") as typeof import("node:fs")
      expect(readFileSync(path, "utf8")).not.toContain("@astracollab/cogmem")
    }
  })

  it("keeps the copy in this package, not somewhere surprising", () => {
    expect(TARGET).toContain("src/cognitive-memory")
  })
})
