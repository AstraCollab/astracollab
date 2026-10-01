import { getAuth } from "../src/server/auth/better-auth"

/**
 * End-to-end check of the HTTP surface, against a throwaway database.
 *
 * Every request goes through the same code path a client's would: real
 * `Request` objects, the real auth, the real status mapping. A route that only
 * works when called from a test harness is not a route.
 *
 *   npx tsx scripts/smoke-http.ts
 */

process.env.COGNITIVE_MEMORY_DATABASE_PATH ??= "/tmp/cognitive-memory-http-smoke.sqlite"

const BASE = process.env.COGNITIVE_MEMORY_SMOKE_BASE_URL ?? "http://127.0.0.1:3999"

/*
 * This script signs up in-process to get a session cookie, so it must share
 * BETTER_AUTH_SECRET with the server it is testing. With a different secret the
 * cookie does not verify and every check fails with a 401 that looks exactly
 * like an application bug — which is the sort of thing that costs an afternoon.
 */
if (process.env.BETTER_AUTH_SECRET === undefined) {
  process.stderr.write(
    "warning: BETTER_AUTH_SECRET is not set. Run this against a server started with the same secret.\n"
  )
}

let passed = 0
let failed = 0

/** Read a nested object out of a loosely-typed response, tolerating anything. */
const obj = (value: unknown): Json =>
  typeof value === "object" && value !== null ? (value as Json) : {}
const arr = (value: unknown): Array<Json> => (Array.isArray(value) ? (value as Json[]) : [])
/** A list of plain strings — `weakDomains`, `domains`, and similar. */
const strs = (value: unknown): Array<string> =>
  Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : []
const str = (value: unknown): string => (typeof value === "string" ? value : "")
const num = (value: unknown): number => (typeof value === "number" ? value : Number.NaN)

const check = (label: string, condition: boolean, detail?: unknown): void => {
  if (condition) {
    passed += 1
    process.stdout.write(`  ok   ${label}\n`)
  } else {
    failed += 1
    process.stdout.write(`  FAIL ${label}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}\n`)
  }
}

/**
 * A JSON body as an opaque value.
 *
 * The checks below read fields off these responses, so they are typed as a loose
 * record rather than `any`: the harness reads a dozen different shapes, and
 * modelling each one would be noise around the assertions that matter.
 */
type Json = Record<string, unknown>

const call = async (
  method: string,
  path: string,
  options: { readonly key?: string; readonly cookie?: string; readonly body?: unknown } = {}
): Promise<{ status: number; body: Json }> => {
  const headers: Record<string, string> = { "content-type": "application/json" }
  if (options.key) headers.authorization = `Bearer ${options.key}`
  if (options.cookie) headers.cookie = options.cookie
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers,
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) })
  })
  const text = await response.text()
  // Every endpoint here answers with JSON; an empty body is an empty object
  // rather than a null the assertions would each have to guard.
  return { status: response.status, body: text ? (JSON.parse(text) as Json) : {} }
}

async function main(): Promise<void> {
  const stamp = Date.now().toString(36)
  const password = "smoke-test-password-1234"

  // 1. Sign up and create an organisation through Better Auth.
  const signup = await getAuth().api.signUpEmail({
    body: { email: `http-${stamp}@example.test`, password, name: "HTTP Smoke" },
    asResponse: true
  })
  const setCookie = signup.headers.get("set-cookie")
  if (!setCookie) throw new Error("no session cookie")
  const cookie = setCookie
    .split(",")
    .map((part) => part.split(";")[0]?.trim())
    .filter(Boolean)
    .join("; ")

  const created = await getAuth().api.createOrganization({
    body: { name: `http-${stamp}`, slug: `http-${stamp}` },
    headers: new Headers({ cookie })
  })

  process.stdout.write(`\norganisation ${created.id}\n\n`)

  // 2. Health is public; everything else is not.
  const health = await call("GET", "/api/v1/health")
  check("GET /v1/health is public", health.status === 200 && health.body.ok === true, health.body)

  const anonymous = await call("GET", "/api/v1/memories")
  check("GET /v1/memories without a key is 401", anonymous.status === 401, anonymous.body)

  const badKey = await call("GET", "/api/v1/memories", { key: "cmi_dev_deadbeef_nope" })
  check("a malformed key is 401", badKey.status === 401, badKey.body)

  // 3. Mint a key with the session, which is the only way to get one.
  const keysWithoutSession = await call("GET", "/api/v1/keys")
  check("GET /v1/keys without a session is 401", keysWithoutSession.status === 401, keysWithoutSession.body)

  const issued = await call("POST", "/api/v1/keys", {
    cookie,
    body: { name: "smoke", scopes: ["memories:read", "memories:write", "stats:read"] }
  })
  check("POST /v1/keys with a session issues a key", issued.status === 201 && typeof str(issued.body.key) === "string", issued.body)
  const apiKey = str(issued.body.key)

  const listed = await call("GET", "/api/v1/keys", { cookie })
  check("GET /v1/keys lists it by prefix", listed.status === 200 && arr(listed.body.keys).length === 1, listed.body)
  check("the stored row never contains the secret", !JSON.stringify(listed.body).includes(apiKey.slice(20)))

  // 4. A key cannot mint keys.
  const keyMint = await call("POST", "/api/v1/keys", { key: apiKey, body: { name: "escalate" } })
  check("an API key cannot mint keys", keyMint.status === 401, keyMint.body)

  // 5. Store, recall, and build context.
  const stored = await call("POST", "/api/v1/memories", {
    key: apiKey,
    body: {
      items: [
        { content: "The staging build id is ZQ7X4M2K", domains: ["deployment"] },
        { content: "File naming is kebab-case in this repository", domains: ["naming"] }
      ]
    }
  })
  check("POST /v1/memories stores two", stored.status === 201 && obj(stored.body.counts).stored === 2, stored.body)

  const restated = await call("POST", "/api/v1/memories", {
    key: apiKey,
    body: { items: [{ content: "The staging build id is ZQ7X4M2K", domains: ["deployment"] }] }
  })
  check(
    "an identical restatement is merged, not duplicated",
    restated.status === 201 &&
      obj(restated.body.counts).merged === 1 &&
      obj(restated.body.counts).stored === 0 &&
      arr(restated.body.mergedInto).length === 1,
    restated.body
  )

  const refused = await call("POST", "/api/v1/memories", {
    key: apiKey,
    body: { items: [{ content: "just remember this for now" }] }
  })
  check(
    "interaction-scoped text is refused with a reason",
    refused.status === 201 && arr(refused.body.rejected).length === 1,
    refused.body
  )

  const invalid = await call("POST", "/api/v1/memories", { key: apiKey, body: { items: "not-an-array" } })
  check("a malformed body is 400 with an issue", invalid.status === 400 && Array.isArray(invalid.body.issues), invalid.body)

  const recall = await call("POST", "/api/v1/recall", { key: apiKey, body: { query: "staging build id" } })
  check("POST /v1/recall finds it", recall.status === 200 && arr(recall.body.results).length >= 1, recall.body)
  check(
    "the match is the right one",
    str(obj(arr(recall.body.results)[0]?.memory).content).includes("ZQ7X4M2K"),
    arr(recall.body.results)[0]
  )

  const nothing = await call("POST", "/api/v1/recall", { key: apiKey, body: { query: "quarterly revenue" } })
  check("a query with no match says so", nothing.status === 200 && nothing.body.empty === true, nothing.body)

  const context = await call("POST", "/api/v1/context", {
    key: apiKey,
    body: { userMessage: "please ship build ZQ7X4M2K" }
  })
  check("POST /v1/context returns a prompt block", context.status === 200 && str(context.body.text).length > 0, context.body)
  check(
    "a named identifier earns a full body",
    arr(context.body.entries).some((entry) => entry.reason === "trigger" && entry.body !== undefined),
    context.body.entries
  )
  check("the rest is index-only", arr(context.body.entries).some((entry) => entry.reason === "index"))

  // 6. Learning from a turn.
  const learned = await call("POST", "/api/v1/turns", {
    key: apiKey,
    body: {
      userMessage: "Always deploy via the canary pipeline and the staging host is internal-hbr-2291.pineapple.example",
      assistantResponse: "Understood."
    }
  })
  check("POST /v1/turns learns without a model", learned.status === 200 && num(obj(obj(learned.body).counts).stored) >= 1, learned.body)

  const question = await call("POST", "/api/v1/turns", {
    key: apiKey,
    body: { userMessage: "what was the staging build id?", assistantResponse: "ZQ7X4M2K" }
  })
  check("a question is a lookup, not a lesson", question.status === 200 && obj(question.body.counts).stored === 0, question.body)

  // 7. Tensions and the self-model.
  const tension = await call("POST", "/api/v1/tensions", {
    key: apiKey,
    body: {
      claimA: "We deploy on Fridays",
      claimB: "We never deploy on Fridays",
      impact: "critical",
      actionableQuestion: "Which is it?"
    }
  })
  check("POST /v1/tensions records it", tension.status === 201, tension.body)

  const withTension = await call("POST", "/api/v1/context", { key: apiKey, body: { userMessage: "ship it" } })
  check(
    "an active tension is injected in full",
    arr(withTension.body.entries).some((entry) => entry.reason === "tension"),
    withTension.body.entries
  )

  const outcome = await call("POST", "/api/v1/self-model/outcome", {
    key: apiKey,
    body: { domain: "database", success: false, failurePattern: "migrated without a backup" }
  })
  check(
    "a recorded failure lands the domain in weakDomains",
    outcome.status === 200 && strs(obj(outcome.body).weakDomains).includes("database"),
    outcome.body
  )

  const guarded = await call("POST", "/api/v1/context", { key: apiKey, body: { userMessage: "add an index" } })
  check(
    "a weak domain becomes a guardrail",
    arr(guarded.body.entries).some((entry) => entry.reason === "guardrail"),
    guarded.body.entries
  )

  // 8. Scopes are enforced, not decorative.
  const readOnly = await call("POST", "/api/v1/keys", {
    cookie,
    body: { name: "read only", scopes: ["memories:read"] }
  })
  const readOnlyKey: string = str(readOnly.body.key)
  const denied = await call("POST", "/api/v1/memories", {
    key: readOnlyKey,
    body: { items: [{ content: "should not be stored" }] }
  })
  check("a read-only key cannot write", denied.status === 403, denied.body)
  check("the 403 names the scope it needed", denied.body.requiredScope === "memories:write", denied.body)

  // 9. Revocation is immediate.
  const keys = await call("GET", "/api/v1/keys", { cookie })
  const rows = arr(keys.body.keys)
  const readOnlyId = str(rows.find((row) => row.prefix === str(readOnly.body.prefix))?.id)
  const revoked = await call("DELETE", `/api/v1/keys/${readOnlyId}`, { cookie })
  check("DELETE /v1/keys/:id revokes", revoked.status === 200, revoked.body)
  const afterRevoke = await call("POST", "/api/v1/recall", { key: readOnlyKey, body: { query: "build" } })
  check("a revoked key stops working immediately", afterRevoke.status === 401, afterRevoke.body)

  // 10. Stats, and isolation between organisations.
  const stats = await call("GET", "/api/v1/stats", { key: apiKey })
  check("GET /v1/stats counts the memories", stats.status === 200 && num(obj(obj(stats.body).memories).total) >= 2, stats.body)
  check("GET /v1/stats reports the active tension", num(obj(obj(stats.body).tensions).active) >= 1, stats.body)

  const other = await getAuth().api.signUpEmail({
    body: { email: `other-${stamp}@example.test`, password, name: "Other" },
    asResponse: true
  })
  const otherCookie = (other.headers.get("set-cookie") ?? "")
    .split(",")
    .map((part) => part.split(";")[0]?.trim())
    .filter(Boolean)
    .join("; ")
  const otherOrg = await getAuth().api.createOrganization({
    body: { name: `other-${stamp}`, slug: `other-${stamp}` },
    headers: new Headers({ cookie: otherCookie })
  })
  const otherKey = await call("POST", "/api/v1/keys", { cookie: otherCookie, body: { name: "other" } })
  const otherMemories = await call("GET", "/api/v1/memories", { key: str(otherKey.body.key) })
  check("a new organisation starts empty", arr(otherMemories.body.memories).length === 0, otherMemories.body)

  const crossRead = await call("GET", `/api/v1/memories/${str(obj(arr(stored.body.stored)[0]).id)}`, { key: str(otherKey.body.key) })
  check("one organisation cannot read another's memory by id", crossRead.status === 404, crossRead.body)
  void otherOrg
}

main()
  .then(() => {
    process.stdout.write(`\n${passed} passed, ${failed} failed\n`)
    if (failed > 0) process.exitCode = 1
  })
  .catch((error: unknown) => {
    process.stdout.write(`\nHARNESS ERROR: ${error instanceof Error ? error.stack : String(error)}\n`)
    process.exitCode = 1
  })
