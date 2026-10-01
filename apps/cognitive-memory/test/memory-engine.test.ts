import { Effect, Exit } from "effect"
import { beforeEach, describe, expect, it } from "vitest"

import { ALL_SCOPES } from "@/server/services/keys"
import {
  Database,
  Keys,
  MemoryEngine,
  MemoryStore,
  TurnExtractor,
  makeTestRuntime,
  ORGANIZATION_ID,
  seedOrganization
} from "./harness"

/**
 * The engine, against a real database.
 *
 * Every case here is a decision that can lose a fact or leak one. The bar for a
 * change in this file is that a test fails for the reason the change was made,
 * not merely that a number moved.
 */

const runtime = makeTestRuntime()

/** What this runtime provides, so the helpers can accept any subset of it. */
type Services = Database | MemoryEngine | MemoryStore | Keys | TurnExtractor

const run = <A, E>(effect: Effect.Effect<A, E, Services>): Promise<A> => runtime.runPromise(effect)

const runExit = <A, E>(effect: Effect.Effect<A, E, Services>) => runtime.runPromiseExit(effect)

describe("cognitive memory engine", () => {
  beforeEach(async () => {
    // A fresh runtime per test file is not enough: state persists in the shared
    // in-memory database, so each test seeds its own organisation and scopes
    // every assertion to it.
    await run(seedOrganization(ORGANIZATION_ID))
  })

  it("stores a stated fact and recalls it", async () => {
    const stored = await run(
      Effect.gen(function* () {
        const engine = yield* MemoryEngine
        return yield* engine.remember({
          organizationId: ORGANIZATION_ID,
          items: [{ content: "The staging build id is ZQ7X4M2K", domains: ["deployment"] }]
        })
      })
    )
    expect(stored.stored).toHaveLength(1)
    expect(stored.stored[0]?.content).toContain("ZQ7X4M2K")

    const hits = await run(
      Effect.gen(function* () {
        const engine = yield* MemoryEngine
        return yield* engine.recall({ organizationId: ORGANIZATION_ID, query: "staging build id" })
      })
    )
    expect(hits.length).toBeGreaterThan(0)
    expect(hits[0]?.item.content).toContain("ZQ7X4M2K")
  })

  it("reports a restatement as merged, with the survivor, and stores no second row", async () => {
    const result = await run(
      Effect.gen(function* () {
        const engine = yield* MemoryEngine
        return yield* engine.remember({
          organizationId: ORGANIZATION_ID,
          items: [{ content: "File naming is kebab-case in this repository" }]
        })
      })
    )
    const first = result.stored[0]!

    const again = await run(
      Effect.gen(function* () {
        const engine = yield* MemoryEngine
        return yield* engine.remember({
          organizationId: ORGANIZATION_ID,
          items: [{ content: "File naming is kebab-case in this repository" }]
        })
      })
    )

    expect(again.stored).toHaveLength(0)
    expect(again.merged).toBe(1)
    expect(again.mergedInto[0]?.id).toBe(first.id)
  })

  it("refuses interaction-scoped text and says why", async () => {
    const result = await run(
      Effect.gen(function* () {
        const engine = yield* MemoryEngine
        return yield* engine.remember({
          organizationId: ORGANIZATION_ID,
          items: [{ content: "do not verify this against the repo" }]
        })
      })
    )
    expect(result.stored).toHaveLength(0)
    expect(result.rejected).toHaveLength(1)
    expect(result.rejected[0]?.reason).toMatch(/conversation/i)
  })

  it("never returns another organisation's memory", async () => {
    await run(seedOrganization("org_other"))
    await run(
      Effect.gen(function* () {
        const engine = yield* MemoryEngine
        yield* engine.remember({
          organizationId: ORGANIZATION_ID,
          items: [{ content: "The internal staging host is hbr-2291.pineapple.example" }]
        })
      })
    )

    const otherRecall = await run(
      Effect.gen(function* () {
        const engine = yield* MemoryEngine
        return yield* engine.recall({ organizationId: "org_other", query: "staging host" })
      })
    )
    expect(otherRecall).toHaveLength(0)

    const all = await run(
      Effect.gen(function* () {
        const engine = yield* MemoryEngine
        return yield* engine.list("org_other")
      })
    )
    expect(all).toHaveLength(0)
  })

  it("gives a named identifier a full body and everything else an index line", async () => {
    await run(
      Effect.gen(function* () {
        const engine = yield* MemoryEngine
        yield* engine.remember({
          organizationId: ORGANIZATION_ID,
          items: [
            { content: "The staging build id is ZQ7X4M2K" },
            { content: "File naming is kebab-case in this repository" }
          ]
        })
      })
    )

    const report = await run(
      Effect.gen(function* () {
        const engine = yield* MemoryEngine
        return yield* engine.planContext({
          organizationId: ORGANIZATION_ID,
          userMessage: "please ship build ZQ7X4M2K"
        })
      })
    )

    const triggered = report.entries.filter((entry) => entry.reason === "trigger")
    const indexed = report.entries.filter((entry) => entry.reason === "index")
    expect(triggered).toHaveLength(1)
    expect(triggered[0]?.body).toContain("ZQ7X4M2K")
    expect(indexed.length).toBeGreaterThan(0)
    expect(indexed.every((entry) => entry.body === undefined)).toBe(true)
  })

  it("keeps injection inside the token budget and says it was truncated", async () => {
    const many = Array.from({ length: 40 }, (_, index) => ({
      content: `A durable project fact number ${index} that a user stated explicitly`
    }))
    await run(
      Effect.gen(function* () {
        const engine = yield* MemoryEngine
        yield* engine.remember({ organizationId: ORGANIZATION_ID, items: many })
      })
    )

    const report = await run(
      Effect.gen(function* () {
        const engine = yield* MemoryEngine
        return yield* engine.planContext({ organizationId: ORGANIZATION_ID, maxTokens: 60 })
      })
    )
    expect(report.totalTokens).toBeLessThanOrEqual(60)
    expect(report.truncated).toBe(true)
  })

  it("learns from a turn but not from a question", async () => {
    const learned = await run(
      Effect.gen(function* () {
        const engine = yield* MemoryEngine
        return yield* engine.learnFromTurn({
          organizationId: ORGANIZATION_ID,
          userMessage: "Always run migrations through drizzle-kit",
          assistantResponse: "Understood."
        })
      })
    )
    expect(learned.stored.length).toBeGreaterThan(0)

    const asked = await run(
      Effect.gen(function* () {
        const engine = yield* MemoryEngine
        return yield* engine.learnFromTurn({
          organizationId: ORGANIZATION_ID,
          userMessage: "what database do we use?",
          assistantResponse: "You use Postgres."
        })
      })
    )
    expect(asked.stored).toHaveLength(0)
  })

  it("pays a weak domain a guardrail, and one failure is not conclusive", async () => {
    const first = await run(
      Effect.gen(function* () {
        const engine = yield* MemoryEngine
        return yield* engine.recordDomainOutcome({
          organizationId: ORGANIZATION_ID,
          domain: "database",
          success: false,
          failurePattern: "migrated without a backup"
        })
      })
    )
    // A single failure should not zero the domain, or every later prompt would
    // carry a permanent "be careful with databases" notice.
    expect(first.sampleCount).toBe(1)
    expect(first.reliabilityScore).toBeGreaterThan(0)

    const report = await run(
      Effect.gen(function* () {
        const engine = yield* MemoryEngine
        return yield* engine.planContext({ organizationId: ORGANIZATION_ID, userMessage: "add a column" })
      })
    )
    const guardrails = report.entries.filter((entry) => entry.reason === "guardrail")
    expect(guardrails).toHaveLength(1)
    expect(guardrails[0]?.body).toContain("migrated without a backup")
  })

  it("keeps an unresolved contradiction in every prompt until it is resolved", async () => {
    const tension = await run(
      Effect.gen(function* () {
        const engine = yield* MemoryEngine
        return yield* engine.addTension({
          organizationId: ORGANIZATION_ID,
          claimA: "We deploy on Fridays",
          claimB: "We never deploy on Fridays",
          impact: "critical",
          actionableQuestion: "Which is it?"
        })
      })
    )

    const report = await run(
      Effect.gen(function* () {
        const engine = yield* MemoryEngine
        return yield* engine.planContext({ organizationId: ORGANIZATION_ID, userMessage: "ship it" })
      })
    )
    const entries = report.entries.filter((entry) => entry.reason === "tension")
    expect(entries).toHaveLength(1)
    expect(entries[0]?.body).toContain("Which is it?")

    await run(
      Effect.gen(function* () {
        const engine = yield* MemoryEngine
        yield* engine.resolveTension({
          organizationId: ORGANIZATION_ID,
          id: tension.id,
          resolvedBy: "user",
          pattern: "Friday deploys are frozen"
        })
      })
    )

    const after = await run(
      Effect.gen(function* () {
        const engine = yield* MemoryEngine
        return yield* engine.planContext({ organizationId: ORGANIZATION_ID, userMessage: "ship it" })
      })
    )
    expect(after.entries.filter((entry) => entry.reason === "tension")).toHaveLength(0)
  })

  it("lets two organisations hold the same contradiction independently", async () => {
    // The same disagreement in two tenants must be two rows. Ids derived from the
    // claims alone collided on the primary key, and whichever wrote second took
    // over the first one's row — silently losing one tenant's tension.
    await run(seedOrganization("org_two"))
    const claim = {
      claimA: "We deploy on Fridays",
      claimB: "We never deploy on Fridays",
      actionableQuestion: "Which is it?"
    }

    const first = await run(
      Effect.gen(function* () {
        const engine = yield* MemoryEngine
        return yield* engine.addTension({ organizationId: ORGANIZATION_ID, ...claim })
      })
    )
    const second = await run(
      Effect.gen(function* () {
        const engine = yield* MemoryEngine
        return yield* engine.addTension({ organizationId: "org_two", ...claim })
      })
    )

    expect(first.id).not.toBe(second.id)

    for (const organizationId of [ORGANIZATION_ID, "org_two"]) {
      const tensions = await run(
        Effect.gen(function* () {
          const engine = yield* MemoryEngine
          return yield* engine.listTensions(organizationId, "active")
        })
      )
      expect(tensions).toHaveLength(1)
    }
  })

  it("flags a correction in the user's message without a model call", async () => {
    const report = await run(
      Effect.gen(function* () {
        const engine = yield* MemoryEngine
        return yield* engine.planContext({
          organizationId: ORGANIZATION_ID,
          userMessage: "Actually, we switched to Postgres last week"
        })
      })
    )
    expect(report.text).toContain("Premise Correction Notice")
  })
})

describe("api keys", () => {
  beforeEach(async () => {
    await run(seedOrganization(ORGANIZATION_ID))
  })

  it("authenticates a key it issued, and only that key", async () => {
    const issued = await run(
      Effect.gen(function* () {
        const keys = yield* Keys
        return yield* keys.issue({
          organizationId: ORGANIZATION_ID,
          name: "test",
          scopes: [ALL_SCOPES[0]!, ALL_SCOPES[1]!]
        })
      })
    )

    const caller = await run(
      Effect.gen(function* () {
        const keys = yield* Keys
        return yield* keys.authenticate(issued.secret)
      })
    )
    expect(caller.organizationId).toBe(ORGANIZATION_ID)

    const forged = await runExit(
      Effect.gen(function* () {
        const keys = yield* Keys
        return yield* keys.authenticate(`${issued.prefix}_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`)
      })
    )
    expect(Exit.isFailure(forged)).toBe(true)
  })

  it("stops working the moment it is revoked", async () => {
    const issued = await run(
      Effect.gen(function* () {
        const keys = yield* Keys
        return yield* keys.issue({
          organizationId: ORGANIZATION_ID,
          name: "revoke me",
          scopes: [ALL_SCOPES[0]!]
        })
      })
    )

    await run(
      Effect.gen(function* () {
        const keys = yield* Keys
        return yield* keys.revoke(ORGANIZATION_ID, issued.id)
      })
    )

    const after = await runExit(
      Effect.gen(function* () {
        const keys = yield* Keys
        return yield* keys.authenticate(issued.secret)
      })
    )
    expect(Exit.isFailure(after)).toBe(true)
  })

  it("rejects a key minted for a scope it cannot justify", async () => {
    const outcome = await runExit(
      Effect.gen(function* () {
        const keys = yield* Keys
        return yield* keys.issue({
          organizationId: ORGANIZATION_ID,
          name: "nonsense",
          scopes: ["root:everything"]
        })
      })
    )
    expect(Exit.isFailure(outcome)).toBe(true)
  })
})
