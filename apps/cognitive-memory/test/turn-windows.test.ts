import { describe, expect, it } from "vitest"

import { windows } from "@/server/engine/turn-extractor"

/**
 * How a long turn is read.
 *
 * The bug these pin down is not a crash, it is a quiet omission: a turn was
 * truncated to its first 2000 characters, so the conclusion of a long answer —
 * the confirmed port, the decision, the correction — was dropped while the wire
 * happily accepted 20000 of them. Reading the tail is the whole point, so the
 * property tested here is coverage, not formatting.
 */

const MAX_WINDOWS = 4

/**
 * A string in which every position is identifiable, so `indexOf` can say *where*
 * a window came from. A run of identical characters would map every window to
 * offset 0 and the coverage check would pass or fail for the wrong reason.
 */
const unique = (length: number): string =>
  Array.from({ length }, (_, index) => String.fromCodePoint(0x4e00 + index)).join("")

/** Every character index the windows show, so coverage is checked and not assumed. */
const covered = (value: string, parts: ReadonlyArray<string>): Set<number> => {
  const seen = new Set<number>()
  for (const part of parts) {
    const start = value.indexOf(part)
    if (start >= 0) for (let i = start; i < start + part.length; i++) seen.add(i)
  }
  return seen
}

describe("turn windows", () => {
  it("passes a short field through whole, as one window", () => {
    expect(windows("we deploy on Fridays")).toEqual(["we deploy on Fridays"])
  })

  it("shows the end of a long answer, which head-only truncation lost", () => {
    const answer = `${"a".repeat(9000)}and staging runs on port 5433.`

    const shown = windows(answer).join("")

    expect(shown).toContain("staging runs on port 5433")
  })

  it("tiles a field that fits in the window budget, so nothing is dropped", () => {
    // Every length that crosses a window boundary, up to the budget.
    for (const length of [2001, 4000, 4001, 6000, 8000]) {
      const value = unique(length)
      const parts = windows(value)

      expect(covered(value, parts).size, `length ${length}`).toBe(length)
    }
  })

  it("keeps the cost of a turn bounded however long it is", () => {
    for (const length of [8001, 50000, 200000]) {
      expect(windows("x".repeat(length)).length, `length ${length}`).toBe(MAX_WINDOWS)
    }
  })

  it("spreads a huge turn over the whole of it rather than the start", () => {
    const value = `${"h".repeat(50000)}THE-TAIL-MARKER${"t".repeat(50000)}`

    const first = windows(value)[0]!
    const last = windows(value).at(-1)!

    expect(first).toMatch(/^h/)
    expect(last).toMatch(/t$/)
  })

  it("never returns an empty window, which would spend a call on nothing", () => {
    for (const length of [1, 2000, 2001, 5000, 200000]) {
      expect(windows("y".repeat(length)).every((part) => part.length > 0)).toBe(true)
    }
  })

  it("is deterministic, so a retried turn extracts the same thing", () => {
    const value = "z".repeat(9500)
    expect(windows(value)).toEqual(windows(value))
  })
})
