import { organization } from "better-auth/plugins"
import { apiKey } from "@better-auth/api-key"
import { createAccessControl } from "better-auth/plugins/access"
import { betterAuth } from "better-auth"
import { drizzleAdapter } from "better-auth/adapters/drizzle"
import { toNextJsHandler } from "better-auth/next-js"

import { authTables } from "../db/auth-tables"
import { getDb } from "../db/client"

/**
 * Better Auth owns identity, both halves of it.
 *
 * Humans arrive with a session cookie and belong to an `organization`. Machines
 * — and `nah` is a machine — present an API key that is owned by that same
 * organization. Splitting tenancy across two systems (a cookie here, an opaque
 * token resolved by hand there) is how "which org does this key belong to" ends
 * up answered in two places that disagree, so both live in Better Auth and
 * resolve to the same `organizationId`.
 */
/**
 * What a role may do, declared in one place.
 *
 * `apiKey` and `agent` are Better Auth's own `apiKey` plugin and our own
 * resource respectively; both are enforced against the organisation's active
 * access-control config above.
 */
const ac = createAccessControl({
  apiKey: ["create", "read", "update", "delete"],
  agent: ["create", "read", "update", "delete"],
  run: ["create", "read", "cancel"]
} as const)

const createAuth = () => {
  const configured = process.env.BETTER_AUTH_SECRET?.trim()
  if (!configured && process.env.NODE_ENV === "production") {
    throw new Error(
      "BETTER_AUTH_SECRET is required in production. Generate one with: openssl rand -base64 32"
    )
  }

  // Accept GITHUB_CLIENT_ID and GITHUB_SECRET (the user-facing var names),
  // with fallbacks for the longer forms used in docs.
  const githubId =
    process.env.GITHUB_CLIENT_ID?.trim() || process.env.github_client_id?.trim()
  const githubSecret =
    process.env.GITHUB_SECRET?.trim() ||
    process.env.GITHUB_CLIENT_SECRET?.trim() ||
    process.env.github_client_secret?.trim()

  return betterAuth({
    secret: configured || "nah-cloud-development-secret-do-not-use-in-production",
    baseURL: process.env.BETTER_AUTH_URL?.trim() || `http://localhost:${process.env.PORT ?? 3000}`,
    database: drizzleAdapter(getDb(), {
      provider: "pg",
      schema: authTables
    }),
    emailAndPassword: {
      enabled: true,
      requireEmailVerification: false,
      minPasswordLength: 12
    },
    account: {
      accountLinking: {
        enabled: true,
        requireLocalEmailVerified: false,
      }
    },
    session: {
      expiresIn: 60 * 60 * 24 * 30,
      updateAge: 60 * 60 * 24
    },
    plugins: [
      organization({
        allowUserToCreateOrganization: true,
        organizationLimit: 20,
        // Only the roles that need to mint machine credentials get `apiKey:create`.
        // A plain member can run agents with a key that already exists, but cannot
        // create more — otherwise joining an org silently grants billing-relevant
        // authority.
        ac,
        roles: {
          owner: ac.newRole({
            apiKey: ["create", "read", "update", "delete"],
            agent: ["create", "read", "update", "delete"]
          }),
          admin: ac.newRole({
            apiKey: ["create", "read", "update", "delete"],
            agent: ["create", "read", "update", "delete"]
          }),
          member: ac.newRole({
            agent: ["create", "read"]
          })
        }
      }),
      // Machine credentials, owned by the organisation rather than by a person.
      // `references: "organization"` is the point: `nah` authenticates once and
      // then runs for an hour, and a key that dies with a person's session is a
      // key that kills running jobs.
      //
      // Two configs, because the two kinds of key want opposite lifetimes. Agent
      // keys are long-lived and revocable; the runner key is short-lived,
      // count-limited, and self-expiring so a leaked build token cannot be
      // replayed forever.
      apiKey([
        {
          configId: "agent",
          defaultPrefix: "nah_agent_",
          references: "organization"
        },
        {
          configId: "runner",
          defaultPrefix: "nah_run_",
          references: "organization",
          // A run is not allowed to fan out into other runs.
          rateLimit: { enabled: true, timeWindow: 60_000, maxRequests: 120 },
          // Per-run keys self-expire in a day. A leaked key cannot be replayed
          // forever, and keys-page copy that claims self-expiry stays truthful.
          keyExpiration: { defaultExpiresIn: 86_400 }
        }
      ])
    ],
    /**
     * GitHub social provider for sign-in and account linking.
     *
     * Better Auth's built-in GitHub provider is used rather than genericOAuth.
     * GitHub returns `email: null` when the profile email is private; the
     * built-in provider then fetches `/user/emails` as a fallback, which is
     * what the GitHub docs describe. With genericOAuth, Better Auth's
     * callback handler requires a non-null email and the flow failed with
     * `OAUTH_ACCOUNT_SUBJECT_INVALID` / `EMAIL_NOT_FOUND` for private-email
     * users.
     */
    socialProviders: {
      github: {
        clientId: githubId!,
        clientSecret: githubSecret!,
        scopes: ["read:user", "user:email"],
        linkAccount: true,
        redirectURI: `${process.env.BETTER_AUTH_URL?.trim() || "http://localhost:3000"}/api/auth/callback/github`,
        // Allow linking to existing accounts even if email doesn't match exactly
        // (Better Auth uses email as the primary matching key)
      }
    }
  })
}

export type Auth = ReturnType<typeof createAuth>

type AuthHandler = ReturnType<typeof toNextJsHandler>

let cached: { auth: Auth; handler: AuthHandler } | null = null

const instance = () => {
  cached ??= (() => {
    const auth = createAuth()
    return { auth, handler: toNextJsHandler(auth) }
  })()
  return cached
}

/** The configured Better Auth instance, built on first use. */
export const getAuth = (): Auth => instance().auth

/** Dispatch one Better Auth request. */
export const handleAuthRequest = (request: Request): Promise<Response> => {
  const verb = request.method.toUpperCase() as keyof AuthHandler
  const handler = instance().handler[verb]
  if (typeof handler !== "function") {
    return Promise.resolve(
      new Response(JSON.stringify({ error: "MethodNotAllowed" }), {
        status: 405,
        headers: { "content-type": "application/json", allow: "GET, POST, PATCH, PUT, DELETE" }
      })
    )
  }
  return handler(request)
}

/** Whether the deployment has the secret it needs. Reported by the health check. */
export const authConfigured = (): boolean =>
  Boolean(process.env.BETTER_AUTH_SECRET?.trim()) || process.env.NODE_ENV !== "production"

/**
 * The organisation an API key speaks for.
 *
 * The whole authorization seam, and deliberately small: a verified key yields an
 * `organizationId` and nothing else. No user, no session, no role — because
 * `nah` is not a person and pretending otherwise is what leads to a CLI holding a
 * cookie-shaped identity it cannot meaningfully refresh.
 *
 * `configId` is required rather than defaulted. "agent" and "runner" keys have
 * different permissions and different rate limits, and defaulting would mean a
 * runner token silently accepted wherever an agent token was expected.
 *
 * Returns `null` for every failure — absent, malformed, expired, wrong config,
 * rate-limited — because the caller cannot act on *which* of those it was, and
 * distinguishing them in the response only helps someone probing.
 */
export const verifyApiKey = async (
  key: string | null,
  configId: "agent" | "runner"
): Promise<{ readonly keyId: string; readonly organizationId: string } | null> => {
  if (!key) return null
  try {
    const result = await getAuth().api.verifyApiKey({ body: { key, configId } })
    if (!result.valid || !result.key) return null
    // `referenceId` is the organizationId *only* under `references: "organization"`,
    // which is configured above for both configs. The plugin does not report which
    // kind of owner it found, so this is asserted by construction, not checked.
    return { keyId: result.key.id, organizationId: result.key.referenceId }
  } catch {
    return null
  }
}