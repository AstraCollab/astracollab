import { getAuth, verifyApiKey } from "../src/server/auth/better-auth"

/**
 * End-to-end check of the machine-credential seam `nah` will authenticate with.
 *
 * Run against a real database (`pnpm smoke:auth`) because the properties being
 * tested — that a key verifies, that a revoked one stops, that the configs are
 * genuinely separate — are properties of the plugin plus Postgres, and a mock
 * would only assert that the call site is shaped correctly.
 */
const main = async (): Promise<void> => {
  const auth = getAuth()
  let failures = 0
  const check = (name: string, ok: boolean, detail = ""): void => {
    console.log(`${ok ? "  ok  " : "  FAIL"} ${name}${detail ? ` — ${detail}` : ""}`)
    if (!ok) failures += 1
  }

  const email = `agent-${Date.now()}@example.test`
  const user = await auth.api.signUpEmail({
    body: { email, password: "a-long-enough-password", name: "Agent Tester" }
  })

  // A real session cookie, because `deleteApiKey` is defined as acting "from the
  // perspective of the user" and checks the session's user against the key owner.
  // It takes no server-only `userId` escape hatch — deleting a key is a human
  // action, deliberately, so a leaked agent token cannot revoke its siblings.
  const signIn = await auth.api.signInEmail({
    body: { email, password: "a-long-enough-password" },
    returnHeaders: true
  })
  const setCookie = (signIn.headers as Headers).getSetCookie()
  const cookieHeader = setCookie.map((c) => c.split(";")[0]).join("; ")
  const sessionHeaders = new Headers({ cookie: cookieHeader })
  check("sign-up", Boolean(user.user?.id), email)

  const userId = user.user?.id as string

  const org = await auth.api.createOrganization({
    body: { name: "Test Org", slug: `test-${Date.now()}`, userId }
  })
  const organizationId = org.id
  check("organization created", Boolean(organizationId), organizationId)

  const agentKey = await auth.api.createApiKey({
    body: { configId: "agent", name: "ci", organizationId, userId }
  })
  const runnerKey = await auth.api.createApiKey({
    body: { configId: "runner", name: "build", organizationId, userId }
  })
  check("agent key minted", typeof agentKey.key === "string", agentKey.key?.slice(0, 16))
  check("runner key minted", typeof runnerKey.key === "string")

  const verified = await verifyApiKey(agentKey.key ?? null, "agent")
  check("agent key verifies", verified?.organizationId === organizationId, verified?.organizationId)

  // The reason `configId` is not defaulted: a runner token must not pass as an
  // agent token.
  const crossed = await verifyApiKey(runnerKey.key ?? null, "agent")
  check("runner key rejected for 'agent' config", crossed === null)

  const runnerOk = await verifyApiKey(runnerKey.key ?? null, "runner")
  check("runner key verifies as 'runner'", runnerOk?.organizationId === organizationId)

  check("garbage rejected", (await verifyApiKey("nah_agent_nonsense", "agent")) === null)
  check("null rejected", (await verifyApiKey(null, "agent")) === null)

  // `configId` is required on every lookup because the plugin is configured with
// two named configs and no `configId: "default"`; omitting it fails with
// NO_DEFAULT_API_KEY_CONFIGURATION_FOUND rather than picking one.
await auth.api.deleteApiKey({ body: { keyId: agentKey.id, configId: "agent" }, headers: sessionHeaders })
  const afterRevoke = await verifyApiKey(agentKey.key ?? null, "agent")
  check("deleted key no longer verifies", afterRevoke === null)

  console.log(failures === 0 ? "\nall auth checks passed" : `\n${failures} check(s) failed`)
  if (failures > 0) process.exit(1)
}

main().catch((error: unknown) => {
  console.error(error)
  process.exit(1)
})