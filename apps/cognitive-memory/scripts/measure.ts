import { getAuth } from "../src/server/auth/better-auth"
import { MemoryEngine } from "../src/server/engine/memory-engine"
import { Keys, Scope } from "../src/server/services/keys"
import { runtime } from "../src/server/runtime"

/**
 * Measure what the service actually costs, so the numbers on the site are
 * measurements rather than aspirations.
 *
 * Everything here is a claim the landing page makes: recall latency, context
 * build cost, and what that cost buys. If a number cannot be measured it does
 * not go on the page.
 *
 *   npx tsx scripts/measure.ts
 */

process.env.COGNITIVE_MEMORY_DATABASE_PATH ??= "/tmp/cognitive-memory-measure.sqlite"

const percentiles = (samples: Array<number>): Record<string, number> => {
  const sorted = [...samples].sort((a, b) => a - b)
  const at = (p: number): number => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? 0
  return { p50: Number(at(0.5).toFixed(2)), p95: Number(at(0.95).toFixed(2)), p99: Number(at(0.99).toFixed(2)) }
}

const run = runtime.runPromise

async function measure(): Promise<void> {
  const stamp = Date.now().toString(36)
  const signup = await getAuth().api.signUpEmail({
    body: {
      email: `measure-${stamp}@example.test`,
      password: "measure-password-1234",
      name: "Measure"
    },
    asResponse: true
  })
  const setCookie = signup.headers.get("set-cookie") ?? ""
  const cookie = setCookie
    .split(",")
    .map((part) => part.split(";")[0]?.trim())
    .filter(Boolean)
    .join("; ")
  const organization = await getAuth().api.createOrganization({
    body: { name: `measure-${stamp}`, slug: `measure-${stamp}` },
    headers: new Headers({ cookie })
  })
  const organizationId = organization.id

  const engine = await run(MemoryEngine)
  const keys = await run(Keys)
  await run(
    keys.issue({
      organizationId,
      name: "measure",
      scopes: [Scope.Read, Scope.Write, Scope.Stats]
    })
  )

  // A realistic starting point: 200 statements, roughly a few weeks of a busy
  // project's worth of facts.
  const services = ["staging", "billing", "auth", "search", "export"] as const
  const aspects = ["endpoint", "schema", "policy", "index", "job"] as const
  const values = ["ZQ7X4M2K", "PL8HN3XR", "internal-hbr-2291", "acme-tenant-77", "runbook-4412"] as const
  const facts = Array.from({ length: 200 }, (_, index) => ({
    content: `Project fact ${index}: the ${services[index % 5]} service ${
      aspects[index % 5]
    } is configured as ${values[index % 5]}`
  }))

  const seedStart = performance.now()
  const seeded = await run(engine.remember({ organizationId, items: facts }))
  const seedMs = performance.now() - seedStart

  const recallSamples: Array<number> = []
  for (let round = 0; round < 200; round += 1) {
    const query = facts[(round * 7) % facts.length]!.content.split(": ")[1] ?? "staging service"
    const started = performance.now()
    await run(engine.recall({ organizationId, query, limit: 8 }))
    recallSamples.push(performance.now() - started)
  }

  const contextSamples: Array<number> = []
  const tokenSamples: Array<number> = []
  for (let round = 0; round < 100; round += 1) {
    const started = performance.now()
    const report = await run(
      engine.planContext({ organizationId, userMessage: facts[round % facts.length]!.content })
    )
    contextSamples.push(performance.now() - started)
    tokenSamples.push(report.totalTokens)
  }

  // What the same 200 facts would cost if every body were injected rather than
  // indexed. This is the number the "index by default" claim rests on.
  const allTokens = Math.ceil(facts.map((fact) => fact.content).join("\n").length / 4)
  const indexTokens = Math.ceil(facts.map((fact) => fact.content.split(":")[0]!).join("\n").length / 4)

  process.stdout.write(
    `${JSON.stringify(
      {
        memories: facts.length,
        seed: { ms: Number(seedMs.toFixed(1)), stored: seeded.stored.length },
        recallMs: percentiles(recallSamples),
        contextMs: percentiles(contextSamples),
        contextTokens: percentiles(tokenSamples),
        budget: {
          allBodiesTokens: allTokens,
          indexOnlyTokens: indexTokens,
          savedPercent: Number((100 - (indexTokens / allTokens) * 100).toFixed(1))
        }
      },
      null,
      2
    )}\n`
  )
}

measure().catch((error: unknown) => {
  process.stdout.write(`FAILED: ${error instanceof Error ? error.stack : String(error)}\n`)
  process.exitCode = 1
})
