import { Cause, Effect, Exit, Result } from "effect"

import { getAuth } from "../src/server/auth/better-auth"
import { MemoryEngine } from "../src/server/engine/memory-engine"
import { Keys, Scope } from "../src/server/services/keys"
import { MemoryStore } from "../src/server/services/memory-store"
import { run } from "../src/server/runtime"

/**
 * A smoke run against a throwaway database: does Better Auth compose with the
 * layer graph, and do the engine's decisions come out the way they are meant to?
 *
 *   npx tsx scripts/smoke.ts
 *
 * The organisation is created through Better Auth rather than inserted directly,
 * so the foreign key from `api_keys` to `organization` is exercised the same way
 * a real sign-up would exercise it.
 */

process.env.COGNITIVE_MEMORY_DATABASE_PATH ??= "/tmp/cognitive-memory-smoke.sqlite"

const stamp = Date.now().toString(36)
const email = `smoke-${stamp}@example.test`
const password = "smoke-test-password-1234"

const signUpAndCreateOrganization = async (): Promise<{ organizationId: string; cookie: string }> => {
  const signup = await getAuth().api.signUpEmail({
    body: { email, password, name: "Smoke" },
    asResponse: true
  })
  const setCookie = signup.headers.get("set-cookie")
  if (!setCookie) throw new Error("signUpEmail did not return a session cookie")

  const organization = await getAuth().api.createOrganization({
    body: { name: `smoke-${stamp}`, slug: `smoke-${stamp}` },
    headers: new Headers({ cookie: setCookie.split(";").map((c) => c.trim()).join("; ") })
  })
  return { organizationId: organization.id, cookie: setCookie }
}

const program = Effect.gen(function* () {
  const { organizationId } = yield* Effect.promise(signUpAndCreateOrganization)
  const engine = yield* MemoryEngine
  const keys = yield* Keys

  const issued = yield* keys.issue({
    organizationId,
    name: "smoke",
    scopes: [Scope.Read, Scope.Write, Scope.Stats]
  })
  console.log(`1. key issued: ${issued.prefix} (${issued.secret.length} chars, shown once)`)

  const caller = yield* keys.authenticate(issued.secret)
  console.log(`2. authenticates: ${caller.organizationId === organizationId} | scopes: ${caller.scopes.join(", ")}`)

  const wrongKey = yield* keys
    .authenticate(`${issued.prefix}_not-the-secret-at-all-here`)
    .pipe(Effect.result)
  console.log(
    `3. wrong secret rejected: ${
      Result.isFailure(wrongKey) && wrongKey.failure._tag === "Unauthorized"
    }`
  )

  const learned = yield* engine.learnFromTurn({
    organizationId,
    userMessage:
      "The staging build id is ZQ7X4M2K and the internal staging host is internal-hbr-2291.pineapple.example. " +
      "Always run migrations through drizzle-kit.",
    assistantResponse: "Noted. I will use drizzle-kit for migrations."
  })
  console.log(`4. learned ${learned.stored.length}, merged ${learned.merged}, rejected ${learned.rejected}`)
  for (const item of learned.stored) console.log(`     [${item.source}] ${item.content}`)

  const restated = yield* engine.learnFromTurn({
    organizationId,
    userMessage: "Remember that file naming is kebab-case in this repo.",
    assistantResponse: "Understood."
  })
  console.log(`5. second turn stored ${restated.stored.length}`)

  const recall = yield* engine.recall({ organizationId, query: "staging build id", limit: 5 })
  console.log("6. recall:")
  for (const hit of recall) {
    console.log(`     ${hit.score.toFixed(2)} [${hit.item.tier}] ${hit.item.content.slice(0, 70)}`)
  }

  const plan = yield* engine.planContext({
    organizationId,
    userMessage: "deploy ZQ7X4M2K to the internal staging host please"
  })
  const triggered = plan.entries.filter((entry) => entry.reason === "trigger")
  console.log(
    `7. context: ${plan.totalTokens} tokens, ${plan.entries.length} entries, ` +
      `${triggered.length} earned a full body`
  )

  const outcome = yield* engine.recordDomainOutcome({
    organizationId,
    domain: "database",
    success: false,
    failurePattern: "ran a migration without taking a backup"
  })
  console.log(`8. database reliability ${outcome.reliabilityScore} over ${outcome.sampleCount} tasks`)
  const second = yield* engine.recordDomainOutcome({ organizationId, domain: "database", success: false })
  console.log(`   after a second failure: ${second.reliabilityScore}`)

  const guarded = yield* engine.planContext({ organizationId, userMessage: "add a column" })
  const hasGuardrail = guarded.entries.some((entry) => entry.reason === "guardrail")
  console.log(`9. guardrail injected: ${hasGuardrail}`)

  const store = yield* MemoryStore
  console.log(`10. stats: ${JSON.stringify(yield* store.stats(organizationId))}`)
})

// `Effect.exit` yields a *success* carrying an Exit, so it has to be matched as
// a value. Matching it as an effect would report every run as a pass.
const main = program.pipe(
  Effect.exit,
  Effect.flatMap((exit) =>
    Exit.match(exit, {
      onFailure: (cause) =>
        Effect.sync(() => {
          process.stdout.write(`FAILED: ${Cause.pretty(cause)}\n`)
          process.exitCode = 1
        }),
      onSuccess: () =>
        Effect.sync(() => {
          process.stdout.write("\nsmoke OK\n")
        })
    })
  )
)

void run(main)
