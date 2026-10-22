import { organization } from "better-auth/plugins"
import { betterAuth } from "better-auth"
import { drizzleAdapter } from "better-auth/adapters/drizzle"
import { toNextJsHandler } from "better-auth/next-js"

import { authTables } from "../db/auth-tables"
import { getDb, prepareDb } from "../db/client"
import { resolveOrigin } from "./origin"

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
const createAuth = (baseURL: string) => {
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
    baseURL,
    database: drizzleAdapter(getDb(), {
      provider: "sqlite",
      schema: authTables
    }),
    advanced: {
      // The session cookie is named after the scheme it was issued on, so the
      // name must follow the origin this instance was built for and not the
      // environment: a deployment served over TLS gets a `Secure` cookie, a
      // developer on http does not.
      useSecureCookies: baseURL.startsWith("https://")
    },
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

/**
 * One Better Auth instance per origin.
 *
 * The origin decides the trusted origins and the base URL of every callback
 * the instance builds, so an instance belongs to one host. A deployment
 * normally has one; a preview and a custom domain served by the same process
 * have two, and each gets the instance that matches the host it was asked on.
 */
const instances = new Map<string, { auth: Auth; handler: AuthHandler }>()

const instanceFor = (baseURL: string): { auth: Auth; handler: AuthHandler } => {
  const cached = instances.get(baseURL)
  if (cached) return cached
  const auth = createAuth(baseURL)
  const created = { auth, handler: toNextJsHandler(auth) }
  instances.set(baseURL, created)
  return created
}

/**
 * The configured Better Auth instance, built on first use.
 *
 * `headers` are the headers of the request being served, when there is one:
 * they are what says which host this deployment answers on.
 */
export const getAuth = (headers?: Headers): Auth => instanceFor(resolveOrigin(headers)).auth

/**
 * Dispatch one Better Auth request.
 *
 * `toNextJsHandler` returns one function per verb rather than a single
 * dispatcher, so the method is read off the request. An unsupported verb gets a
 * 405 with an `Allow` header instead of Better Auth's own handling, which would
 * be a 404 and read like a wrong URL.
 */
export const handleAuthRequest = async (request: Request): Promise<Response> => {
  const verb = request.method.toUpperCase() as keyof AuthHandler
  const handler = instanceFor(resolveOrigin(request.headers)).handler[verb]
  if (typeof handler !== "function") {
    return new Response(JSON.stringify({ error: "MethodNotAllowed" }), {
      status: 405,
      headers: { "content-type": "application/json", allow: "GET, POST, PATCH, PUT, DELETE" }
    })
  }
  // Better Auth reads the user and session tables the moment it handles a
  // request, so the schema has to be in place first. The startup hook has
  // usually done it already; this covers the paths it does not run on.
  await prepareDb()
  return handler(request)
}

/** Whether the deployment has the secret it needs. Reported by the health check. */
export const authConfigured = (): boolean =>
  Boolean(process.env.BETTER_AUTH_SECRET?.trim()) || process.env.NODE_ENV !== "production"
