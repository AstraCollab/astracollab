import { Effect } from "effect"
import { describe, expect, it } from "vitest"

import { mergeBudgets, readCognitiveMemorySettings } from "@/server/config"
import { MemoryEngine } from "@/server/engine/memory-engine"
import { MemoryStore } from "@/server/services/memory-store"
import {
  Database,
  MemoryStore as Store,
  makeTestRuntime,
  seedOrganization
} from "./harness"

/**
 * The dashboard's server side: budgets, the injection log, and the analytics
 * fold that turns a pile of rows into the numbers the charts draw.
 *
 * The failures worth catching here are the ones a chart cannot: an override that
 * silently reverts, a bucket that is missing a day, a total that counts a build
 * outside the range. Each case below is one of those, checked against the same
 * in-memory SQLite the engine uses rather than against a mock.
 */

const runtime = makeTestRuntime()

type Services = Database | MemoryEngine | Store

const run = <A, E>(effect: Effect.Effect<A, E, Services>): Promise<A> => runtime.runPromise(effect)

const DAY = 86_400_000

/**
 * A fresh tenant per test.
 *
 * The runtime shares one in-memory database, so a fixed id would let the last
 * test's memories, builds and outcomes into this one. Seeded here rather than in
 * a `beforeEach` for a specific id for the same reason the other suite does it:
 * isolation has to be per case, not per file.
 */
let tenants = 0
const freshTenant = async (): Promise<string> => {
  tenants += 1
  const id = `org_test_${tenants}`
  await run(seedOrganization(id))
  return id
}

/** One context build, as the `/v1/context` route would record it. */
const recordBuild = (
  organizationId: string,
  options: {
    readonly tokens: number
    readonly truncated?: boolean
    readonly bodies?: number
    readonly reasons?: Record<string, number>
    readonly at: number
  }
) =>
  Effect.gen(function* () {
    const store = yield* Store
    yield* store.recordInjection({
      id: `inj-${options.at}-${options.tokens}`,
      organizationId,
      apiKeyId: null,
      tokens: options.tokens,
      truncated: options.truncated ?? false,
      indexLines: 3,
      bodies: options.bodies ?? 0,
      identifiers: ["ZQ7X4M2K"],
      reasons: options.reasons ?? { index: 3 },
      entries: [{ id: "mem-1", tier: "L1", reason: "index", gist: "a fact", tokens: options.tokens }],
      text: "## Memory\n- a fact",
      now: options.at
    })
  })

describe("budgets", () => {
  it("falls back to the deployment default until an organisation overrides it", async () => {
    const organizationId = await freshTenant()
    const effective = await run(
      Effect.gen(function* () {
        const engine = yield* MemoryEngine
        return yield* engine.budgets(organizationId)
      })
    )
    expect(effective.maxTotalTokens).toBe(readCognitiveMemorySettings().maxTotalTokens)

    const overridden = await run(
      Effect.gen(function* () {
        const store = yield* Store
        yield* store.putSettings(organizationId, { maxTotalTokens: 120 })
        const engine = yield* MemoryEngine
        return yield* engine.budgets(organizationId)
      })
    )
    expect(overridden.maxTotalTokens).toBe(120)
    // The other two are still inherited, which is the point of nullable columns.
    expect(overridden.maxIndexItems).toBe(readCognitiveMemorySettings().maxIndexItems)
  })

  it("treats null as 'inherit again', not as zero", async () => {
    const organizationId = await freshTenant()
    const restored = await run(
      Effect.gen(function* () {
        const store = yield* Store
        yield* store.putSettings(organizationId, { maxTotalTokens: 120 })
        const row = yield* store.putSettings(organizationId, { maxTotalTokens: null })
        const engine = yield* MemoryEngine
        return { row, effective: yield* engine.budgets(organizationId) }
      })
    )
    expect(restored.row.maxTotalTokens).toBeNull()
    expect(restored.effective.maxTotalTokens).toBe(readCognitiveMemorySettings().maxTotalTokens)
  })

  it("merges overrides over the deployment, preferring each independently", () => {
    const config = readCognitiveMemorySettings()
    const merged = mergeBudgets(config, {
      maxTotalTokens: 900,
      maxIndexItems: null,
      defaultRecallLimit: null
    })
    expect(merged).toEqual({
      maxTotalTokens: 900,
      maxIndexItems: config.maxIndexItems,
      defaultRecallLimit: config.defaultRecallLimit
    })
  })

  it("actually enforces the override on the next context build", async () => {
    const organizationId = await freshTenant()
    const report = await run(
      Effect.gen(function* () {
        const store = yield* Store
        const engine = yield* MemoryEngine
        yield* store.putSettings(organizationId, { maxTotalTokens: 12 })
        yield* engine.remember({
          organizationId: organizationId,
          items: [
            { content: "The staging build id is ZQ7X4M2K", domains: ["deployment"] },
            { content: "File naming is kebab-case in this repository", domains: ["naming"] },
            { content: "Deployments happen on Tuesdays", domains: ["deployment"] }
          ]
        })
        return yield* engine.planContext({ organizationId: organizationId, userMessage: "ship it" })
      })
    )
    expect(report.totalTokens).toBeLessThanOrEqual(12)
    expect(report.truncated).toBe(true)
  })
})

describe("analytics", () => {

  it("buckets every day in the range, including the quiet ones", async () => {
    const organizationId = await freshTenant()
    const report = await run(
      Effect.gen(function* () {
        const store = yield* Store
        const to = Date.now()
        yield* recordBuild(organizationId, { tokens: 100, at: to - DAY })
        yield* recordBuild(organizationId, { tokens: 250, at: to })
        return yield* store.analytics(organizationId, {
          from: to - 6 * DAY,
          to,
          days: 7,
          budget: 2000
        })
      })
    )

    expect(report.daily).toHaveLength(7)
    expect(report.daily.every((bucket) => bucket.builds >= 0)).toBe(true)
    expect(report.totals.builds).toBe(2)
    expect(report.totals.tokens).toBe(350)
    // Only the buckets that actually had a build may be non-zero, and the total
    // has to agree with them — a chart that draws more than the sum is a lie.
    expect(report.daily.reduce((sum, bucket) => sum + bucket.tokens, 0)).toBe(350)
  })

  it("counts only what is inside the range", async () => {
    const organizationId = await freshTenant()
    const report = await run(
      Effect.gen(function* () {
        const store = yield* Store
        const to = Date.now()
        yield* recordBuild(organizationId, { tokens: 100, at: to })
        yield* recordBuild(organizationId, { tokens: 999, at: to - 40 * DAY })
        return yield* store.analytics(organizationId, { from: to - 7 * DAY, to, days: 7, budget: 2000 })
      })
    )
    expect(report.totals.builds).toBe(1)
    expect(report.totals.tokens).toBe(100)
  })

  it("aggregates the reason mix and the truncation rate", async () => {
    const organizationId = await freshTenant()
    const report = await run(
      Effect.gen(function* () {
        const store = yield* Store
        const to = Date.now()
        // Three builds, so the median is a real middle value rather than the
        // upper of two — the percentile convention is nearest-rank, the one
        // latency reporting uses, and two samples is where that shows.
        yield* recordBuild(organizationId, {
          tokens: 900,
          truncated: true,
          bodies: 2,
          reasons: { index: 3, trigger: 2, guardrail: 1 },
          at: to
        })
        yield* recordBuild(organizationId, { tokens: 100, reasons: { index: 3 }, at: to - DAY })
        yield* recordBuild(organizationId, { tokens: 100, reasons: { index: 3 }, at: to - 2 * DAY })
        return yield* store.analytics(organizationId, { from: to - 6 * DAY, to, days: 7, budget: 1000 })
      })
    )

    const byReason = Object.fromEntries(report.reasons.map((row) => [row.label, row.count]))
    expect(byReason.index).toBe(9)
    expect(byReason.trigger).toBe(2)
    expect(byReason.guardrail).toBe(1)
    expect(report.totals.builds).toBe(3)
    expect(report.totals.tokens).toBe(1100)
    expect(report.totals.truncated).toBe(1)
    expect(report.totals.truncatedShare).toBeCloseTo(1 / 3)
    expect(report.totals.guardrailBuilds).toBe(1)
    // Median against the budget the caller was told is in force, so "90% of the
    // ceiling" and "a median turn this big" cannot disagree.
    expect(report.totals.medianTokens).toBe(100)
    expect(report.totals.utilisation).toBeCloseTo(0.1)
    expect(report.totals.p95Tokens).toBe(900)
    expect(report.largest[0]?.tokens).toBe(900)
  })

  it("never counts another organisation's builds", async () => {
    const organizationId = await freshTenant()
    const elsewhere = await freshTenant()
    const report = await run(
      Effect.gen(function* () {
        const store = yield* Store
        const to = Date.now()
        yield* recordBuild(elsewhere, { tokens: 5000, at: to })
        yield* recordBuild(organizationId, { tokens: 50, at: to })
        return yield* store.analytics(organizationId, { from: to - DAY, to, days: 1, budget: 2000 })
      })
    )
    expect(report.totals.builds).toBe(1)
    expect(report.totals.tokens).toBe(50)
  })

  it("prunes history but never memory, and keeps everything at zero days", async () => {
    const organizationId = await freshTenant()
    const result = await run(
      Effect.gen(function* () {
        const store = yield* Store
        const engine = yield* MemoryEngine
        const now = Date.now()
        yield* engine.remember({
          organizationId: organizationId,
          items: [{ content: "The staging build id is ZQ7X4M2K" }]
        })
        yield* recordBuild(organizationId, { tokens: 100, at: now - 200 * DAY })

        const pruned = yield* store.pruneHistory(organizationId, 90, now)
        const keptEverything = yield* store.pruneHistory(organizationId, 0, now)
        const stats = yield* store.stats(organizationId)
        return { pruned, keptEverything, total: stats.total }
      })
    )

    expect(result.pruned.injections).toBe(1)
    expect(result.keptEverything).toEqual({ usage: 0, injections: 0, outcomes: 0 })
    expect(result.total).toBe(1)
  })
})

describe("the memory library query", () => {

  it("filters by text, tier and domain, and counts the whole tenant behind the filters", async () => {
    const organizationId = await freshTenant()
    const page = await run(
      Effect.gen(function* () {
        const engine = yield* MemoryEngine
        yield* engine.remember({
          organizationId: organizationId,
          items: [
            { content: "The staging build id is ZQ7X4M2K", domains: ["deployment"] },
            { content: "File naming is kebab-case in this repository", domains: ["naming"] },
            { content: "Deployments happen on Tuesdays", domains: ["deployment"] }
          ]
        })

        const byText = yield* engine.page(organizationId, { text: "staging" })
        const byDomain = yield* engine.page(organizationId, { domain: "deployment" })
        const byTier = yield* engine.page(organizationId, { tiers: ["L1"] })
        return { byText, byDomain, byTier }
      })
    )

    expect(page.byText.total).toBe(1)
    expect(page.byDomain.total).toBe(2)
    expect(page.byTier.total).toBe(3)
    // Facets describe the tenant, not the current filter, so the sidebar can
    // answer "how many would I get if I clicked this".
    expect(Object.keys(page.byTier.facets.tiers)).toContain("L1")
    expect(page.byTier.facets.domains.map((entry) => entry.name).sort()).toEqual([
      "deployment",
      "naming"
    ])
  })

  it("cannot reach another tenant's rows through the text filter", async () => {
    // The three OR branches of the search have to stay inside the tenant
    // predicate. Unparenthesised, `tenant and a or b or c` matches another
    // organisation's memories, because `and()` does not wrap its arguments.
    const [organizationId, elsewhere] = [await freshTenant(), await freshTenant()]
    const page = await run(
      Effect.gen(function* () {
        const engine = yield* MemoryEngine
        for (const tenant of [organizationId, elsewhere]) {
          yield* engine.remember({
            organizationId: tenant,
            items: [
              { content: "The staging build id is ZQ7X4M2K", domains: ["deployment"] },
              { content: "File naming is kebab-case in this repository", domains: ["naming"] }
            ]
          })
        }
        return yield* engine.page(organizationId, { text: "staging" })
      })
    )
    expect(page.total).toBe(1)
    expect(page.rows).toHaveLength(1)
  })

  it("treats a % in the query as a character rather than a wildcard", async () => {
    const organizationId = await freshTenant()
    const page = await run(
      Effect.gen(function* () {
        const engine = yield* MemoryEngine
        yield* engine.remember({
          organizationId: organizationId,
          items: [
            { content: "Use 100% of the budget only in staging" },
            { content: "File naming is kebab-case in this repository" }
          ]
        })
        return yield* engine.page(organizationId, { text: "100%" })
      })
    )
    expect(page.total).toBe(1)
  })

  it("keeps identity and counters when a memory is edited", async () => {
    const organizationId = await freshTenant()
    const edited = await run(
      Effect.gen(function* () {
        const engine = yield* MemoryEngine
        const stored = yield* engine.remember({
          organizationId: organizationId,
          items: [{ content: "The staging build id is ZQ7X4M2K", domains: ["deployment"] }]
        })
        const before = stored.stored[0]!
        const after = yield* engine.edit(organizationId, before.id, {
          content: "The staging build id is ZQ7X4M2K and the port is 8443",
          domains: ["deployment", "networking"]
        })
        return { before, after }
      })
    )

    expect(edited.after.id).toBe(edited.before.id)
    expect(edited.after.metadata.domains).toEqual(["deployment", "networking"])
    expect(edited.after.metadata.accessCount).toBe(edited.before.metadata.accessCount)
    // `updatedAt` moving is the only thing an edit is allowed to change.
    expect(edited.after.content).toContain("8443")
  })

  it("counts a use once per build, and only for real rows", async () => {
    const organizationId = await freshTenant()
    // The context route calls touchMany with every id in the report, including
    // the planner's synthetic guardrail placeholders. Those must not create or
    // inflate anything.
    const counters = await run(
      Effect.gen(function* () {
        const engine = yield* MemoryEngine
        const store = yield* Store
        yield* engine.recordDomainOutcome({
          organizationId,
          domain: "database",
          success: false,
          failurePattern: "migrated without a backup"
        })
        const stored = yield* engine.remember({
          organizationId,
          items: [{ content: "The staging build id is ZQ7X4M2K" }]
        })
        const id = stored.stored[0]!.id

        const report = yield* engine.planContext({ organizationId, userMessage: "ship ZQ7X4M2K" })
        const touched = yield* store.touchMany(
          organizationId,
          [...report.entries.map((entry) => entry.id), "guardrail-database"],
          Date.now()
        )
        const after = yield* store.getMemory(organizationId, id)
        const again = yield* store.touchMany(organizationId, [id], Date.now())
        return { touched, again, accessCount: after.metadata.accessCount, id }
      })
    )

    // One real memory, two ids that resolve to nothing.
    expect(counters.touched).toBe(1)
    expect(counters.again).toBe(1)
    expect(counters.accessCount).toBe(1)
  })

  it("applies a tier change and a forget across a selection", async () => {
    const organizationId = await freshTenant()
    const result = await run(
      Effect.gen(function* () {
        const engine = yield* MemoryEngine
        const stored = yield* engine.remember({
          organizationId: organizationId,
          items: [
            { content: "The staging build id is ZQ7X4M2K" },
            { content: "File naming is kebab-case in this repository" }
          ]
        })
        const ids = stored.stored.map((item) => item.id)
        const promoted = yield* engine.applyTo(organizationId, [ids[0]!], { tier: "L3" })
        const forgotten = yield* engine.applyTo(organizationId, ids, "forget")
        const stats = yield* (yield* MemoryStore).stats(organizationId)
        return { promoted, forgotten, total: stats.total }
      })
    )

    expect(result.promoted).toBe(1)
    expect(result.forgotten).toBe(2)
    expect(result.total).toBe(0)
  })
})

describe("explaining a recall", () => {

  it("names the terms that matched, using the ranking's own tokenizer", async () => {
    const organizationId = await freshTenant()
    const explained = await run(
      Effect.gen(function* () {
        const engine = yield* MemoryEngine
        yield* engine.remember({
          organizationId: organizationId,
          items: [
            { content: "The staging build id is ZQ7X4M2K", domains: ["deployment"] },
            { content: "File naming is kebab-case in this repository", domains: ["naming"] }
          ]
        })
        return yield* engine.explainRecall({
          organizationId: organizationId,
          query: "what is the staging build id"
        })
      })
    )

    expect(explained[0]?.item.content).toContain("ZQ7X4M2K")
    expect(explained[0]?.matched).toContain("staging")
    expect(explained[0]?.matched).toContain("build")
    expect(explained[0]?.score).toBeGreaterThan(0)
  })

  it("returns nothing for a query with no usable terms", async () => {
    const organizationId = await freshTenant()
    const explained = await run(
      Effect.gen(function* () {
        const engine = yield* MemoryEngine
        return yield* engine.explainRecall({ organizationId: organizationId, query: "   " })
      })
    )
    expect(explained).toEqual([])
  })
})

describe("the self-model's history", () => {

  it("keeps each sample, so a trend can be drawn rather than inferred", async () => {
    const organizationId = await freshTenant()
    const outcomes = await run(
      Effect.gen(function* () {
        const engine = yield* MemoryEngine
        const store = yield* Store
        yield* engine.recordDomainOutcome({
          organizationId: organizationId,
          domain: "database",
          success: false,
          failurePattern: "migrated without a backup"
        })
        yield* engine.recordDomainOutcome({
          organizationId: organizationId,
          domain: "database",
          success: true,
          strategy: "dry run first"
        })
        return yield* store.listOutcomes(organizationId, { domain: "database" })
      })
    )

    expect(outcomes).toHaveLength(2)
    expect(outcomes.map((outcome) => outcome.success)).toEqual([true, false])
    expect(outcomes.some((outcome) => outcome.failurePattern === "migrated without a backup")).toBe(true)
  })

  it("forgetting a domain drops its score and its samples together", async () => {
    const organizationId = await freshTenant()
    const result = await run(
      Effect.gen(function* () {
        const engine = yield* MemoryEngine
        const store = yield* Store
        yield* engine.recordDomainOutcome({
          organizationId: organizationId,
          domain: "database",
          success: false,
          failurePattern: "migrated without a backup"
        })
        const forgotten = yield* engine.forgetDomain(organizationId, "database")
        const model = yield* engine.selfModel(organizationId)
        const outcomes = yield* store.listOutcomes(organizationId, {})
        return { forgotten, model, outcomes }
      })
    )

    expect(result.forgotten.samples).toBe(1)
    expect(result.model.domains.database).toBeUndefined()
    expect(result.model.activeDomains).not.toContain("database")
    expect(result.outcomes).toHaveLength(0)
  })
})