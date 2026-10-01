import { handleAuthRequest } from "@/server/auth/better-auth"

/**
 * Better Auth's own endpoints: sign up, sign in, session, organisations.
 *
 * Mounted at the conventional path so the client SDKs work unchanged. Nothing
 * here goes through the Effect runtime — Better Auth owns its request lifecycle,
 * and wrapping it would only add a layer that has to be kept in sync.
 *
 * Both verbs delegate to one lazily-built handler, so a missing
 * `BETTER_AUTH_SECRET` fails the request that needs it rather than the build.
 */
export const GET = (request: Request): Promise<Response> => handleAuthRequest(request)

export const POST = (request: Request): Promise<Response> => handleAuthRequest(request)
