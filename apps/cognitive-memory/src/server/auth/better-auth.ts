import { organization } from "better-auth/plugins"
import { betterAuth } from "better-auth"
import { drizzleAdapter } from "better-auth/adapters/drizzle"
import { toNextJsHandler } from "better-auth/next-js"

import { authTables } from "../db/auth-tables"
import { getDb } from "../db/client"

/**
 * Better Auth owns the human half of identity: who someone is, their session,
 * and which organisation their memory belongs to.
 *
 * It does not own machine credentials. There is no API-key plugin in Better Auth
 * 1.7, so keys stay in `src/server/services/keys.ts` — an opaque
 * `cmi_<env>_<id>_<secret>` resolved to a Better Auth `organizationId`. That split
 * is deliberate: sessions are cookies that expire and rotate, and an agent that
 * has to re-auth mid-run is a broken agent. Keys are revocable, scope-limited,
 * and independent of a browser.
 */

/**
 * Built on first use rather than at import.
 *
 * A module-scope `betterAuth(...)` demands `BETTER_AUTH_SECRET` while `next
 * build` is collecting page data, so a fresh clone with no configuration could
 * not be built at all. Deferring it means the requirement is enforced where it
 * actually matters — when a request arrives — and the build stays runnable.
 *
 * The requirement itself is not negotiable in production: a generated secret
 * would invalidate every session on restart and, with more than one instance,
 * let any instance mint a session for any other. Both failure modes are quiet,
 * which is exactly why they are prevented rather than documented.
 */
const createAuth = () => {
  const configured = process.env.BETTER_AUTH_SECRET?.trim()
  if (!configured && process.env.NODE_ENV === "production") {
    throw new Error(
      "BETTER_AUTH_SECRET is required in production. Generate one with: openssl rand -base64 32"
    )
  }

  return betterAuth({
    // A fixed development value, so restarting `next dev` does not sign you out
    // and a second local instance can still verify your session.
    secret: configured || "cognitive-memory-development-secret-do-not-use-in-production",
    baseURL: process.env.BETTER_AUTH_URL?.trim() || `http://localhost:${process.env.PORT ?? 3000}`,
    database: drizzleAdapter(getDb(), {
      provider: "sqlite",
      schema: authTables
    }),
    emailAndPassword: {
      enabled: true,
      // No verification step: requiring an email round-trip before someone can try
      // the API is friction with no security benefit when there is no billing or
      // email sending behind it.
      requireEmailVerification: false,
      minPasswordLength: 12
    },
    session: {
      expiresIn: 60 * 60 * 24 * 30,
      updateAge: 60 * 60 * 24
    },
    plugins: [
      organization({
        allowUserToCreateOrganization: true,
        organizationLimit: 20
      })
    ]
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

/**
 * Dispatch one Better Auth request.
 *
 * `toNextJsHandler` returns one function per verb rather than a single
 * dispatcher, so the method is read off the request. An unsupported verb gets a
 * 405 with an `Allow` header instead of Better Auth's own handling, which would
 * be a 404 and read like a wrong URL.
 */
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
