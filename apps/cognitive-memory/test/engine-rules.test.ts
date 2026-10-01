import { describe, expect, it } from "vitest"

import {
  extractIdentifiers,
  isInteractionScoped,
  isLossyRewrite,
  overlapScore,
  relevanceTokens,
  similarity
} from "@/server/engine/relevance"
import { extractDeterministic } from "@/server/engine/rules"
import { extractDomains, runFastGate } from "@/server/engine/fast-gate"

/**
 * The deterministic layer.
 *
 * These are the rules that decide what gets stored, what gets a body, and what
 * gets folded into what. Every one of them is a decision that can quietly lose a
 * fact, so the cases below are the ones where losing one used to happen.
 */

describe("relevanceTokens", () => {
  it("keeps content words and drops function words", () => {
    const tokens = relevanceTokens("the staging build is for our project")
    expect(tokens.has("staging")).toBe(true)
    expect(tokens.has("build")).toBe(true)
    expect(tokens.has("the")).toBe(false)
    expect(tokens.has("for")).toBe(false)
  })

  it("ignores words too short to identify anything", () => {
    expect(relevanceTokens("a b c db up").has("db")).toBe(false)
  })
})

describe("overlapScore", () => {
  it("normalises by the smaller set, so a short query is not punished", () => {
    const query = relevanceTokens("staging")
    const candidate = relevanceTokens("the staging build id is ZQ7X4M2K")
    expect(overlapScore(query, candidate)).toBe(1)
  })

  it("is zero when either side is empty", () => {
    expect(overlapScore(new Set(), new Set(["a"]))).toBe(0)
    expect(overlapScore(new Set(["a"]), new Set())).toBe(0)
  })
})

describe("extractIdentifiers", () => {
  it("finds the concrete things a user names", () => {
    const found = extractIdentifiers(
      "deploy ZQ7X4M2K to internal-hbr-2291.pineapple.example using runMigrations and the path src/server/db"
    )
    expect(found).toContain("ZQ7X4M2K")
    expect(found).toContain("internal-hbr-2291.pineapple.example")
    expect(found).toContain("runMigrations")
    expect(found).toContain("src/server/db")
  })

  it("does not treat ordinary prose as an identifier", () => {
    const found = extractIdentifiers("please deploy this when you can")
    expect(found).toEqual([])
  })
})

describe("isLossyRewrite", () => {
  it("accepts a merge that keeps every distinctive token", () => {
    expect(
      isLossyRewrite(
        "The staging build ID is ZQ7X4M2K",
        "The staging build ID is ZQ7X4M2K for the internal host"
      )
    ).toBe(false)
  })

  it("refuses a merge that drops a qualifier", () => {
    // The difference between these two is the whole point of the memory.
    expect(
      isLossyRewrite(
        "Always run migrations against staging, never production",
        "Always run migrations against staging"
      )
    ).toBe(true)
  })

  it("refuses a merge that drops a number", () => {
    expect(isLossyRewrite("The port is 2291", "The port is unknown")).toBe(true)
  })

  it("folds trailing plurals so a wording change is not read as a deletion", () => {
    expect(isLossyRewrite("deploys use drizzle-kit", "deploy uses drizzle-kit")).toBe(false)
  })
})

describe("similarity", () => {
  it("collapses paraphrases of one fact", () => {
    expect(similarity("file naming is kebab-case", "file naming should be kebab-case")).toBeGreaterThan(0.8)
  })

  it("keeps facts that differ by an identifier apart", () => {
    expect(similarity("staging build id is ZQ7X4M2K", "staging build id is PL8HN3XR")).toBeLessThan(0.8)
  })
})

describe("isInteractionScoped", () => {
  it("rejects instructions about this conversation, not about the project", () => {
    expect(isInteractionScoped("Do not verify this against the repository")).toBe(true)
    expect(isInteractionScoped("just remember this for now")).toBe(true)
    expect(isInteractionScoped("ok")).toBe(true)
  })

  it("keeps durable project facts", () => {
    expect(isInteractionScoped("The staging host is internal-hbr-2291.pineapple.example")).toBe(false)
    expect(isInteractionScoped("Never run migrations against production")).toBe(false)
  })
})

describe("extractDeterministic", () => {
  it("captures a stated fact without a model", () => {
    const found = extractDeterministic("The staging build id is ZQ7X4M2K")
    expect(found.map((item) => item.content).join(" ")).toContain("ZQ7X4M2K")
  })

  it("does not truncate a dotted hostname at the first period", () => {
    const found = extractDeterministic("The internal staging host is internal-hbr-2291.pineapple.example today")
    expect(found.some((item) => item.content.includes("internal-hbr-2291.pineapple.example"))).toBe(true)
  })

  it("keeps a positive requirement in the user's own words", () => {
    const found = extractDeterministic("Never force push to main")
    expect(found.some((item) => item.content.toLowerCase().includes("force push"))).toBe(true)
  })

  it("never inverts a negation into a requirement", () => {
    const found = extractDeterministic("Do not verify it against the repo")
    const inverted = found.filter((item) =>
      /requires?[:\s]+verify/i.test(item.content)
    )
    expect(inverted).toEqual([])
  })

  it("does not emit two rows for one sentence", () => {
    // "Always run the canary pipeline for staging" is caught as a requirement
    // *and* as an assignment; the truncated assignment copy used to be stored
    // alongside it.
    const found = extractDeterministic(
      "Always run the canary pipeline for the staging cluster"
    )
    expect(found.length).toBeLessThanOrEqual(2)
    const contents = found.map((item) => item.content)
    for (const content of contents) {
      const others = contents.filter((other) => other !== content)
      for (const other of others) {
        if (other.length <= content.length) continue
        const have = new Set(other.toLowerCase().split(/[^a-z0-9]+/))
        const words = content.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 4)
        expect(words.every((word) => have.has(word))).toBe(false)
      }
    }
  })

  it("ignores acknowledgements", () => {
    expect(extractDeterministic("thanks, got it")).toEqual([])
  })
})

describe("runFastGate", () => {
  it("catches an explicit correction of a prior premise", () => {
    const result = runFastGate("Actually, we switched to Postgres last week")
    expect(result.action).toBe("inject_caution")
    expect(result.cautionNote).toBeDefined()
  })

  it("passes an ordinary message through", () => {
    expect(runFastGate("add a column to the users table").action).toBe("proceed")
  })

  it("names the domains a message is about, without a model", () => {
    expect(extractDomains("fix the auth middleware")).toContain("auth")
    expect(extractDomains("write a drizzle migration")).toContain("database")
  })
})
