import { headers } from "next/headers"
import { Effect, Layer, ManagedRuntime } from "effect"

import { getAuth } from "./auth/better-auth"
import { CognitiveMemorySettings } from "./config"
import { Database } from "./db/database"
import { Forbidden, Unauthorized, type CognitiveMemoryError } from "./domain/errors"
import { MemoryEngine, engineLayer } from "./engine/memory-engine"
import { TurnExtractor } from "./engine/turn-extractor"
import { respondWith } from "./http/respond"
import { Keys, requireScope } from "./services/keys"
import { MemoryStore } from "./services/memory-store"

/**
 * Where Effect meets Next.js.
 *
 * One `ManagedRuntime` for the process, built from one layer graph, so the
 * SQLite connection is acquired once and reused rather than opened per request.
 * The `memoMap` is shared for the reason the Effect docs insist on: without it
 * the memoisation keys that stop layers being rebuilt do not match, and the
 * graph is reconstructed on every call.
 *
 * Two ways in, deliberately separate:
 *
 * - **API keys** authenticate an agent. A key resolves to a Better Auth
 *   organisation and to scopes; nothing else about the caller is known, because
 *   an agent is not a person.
 * - **Session cookies** authenticate the dashboard. Only they can create an
 *   organisation or mint a key, so a stolen key cannot escalate itself.
 */

export const AppLayer = Layer.mergeAll(engineLayer, TurnExtractor.layer, Keys.layer).pipe(
  // One store instance, shared by everything that needs it.
  Layer.provideMerge(MemoryStore.layer),
  Layer.provide(Database.layer)
)

export const appMemoMap = Layer.makeMemoMapUnsafe()

export const runtime = ManagedRuntime.make(AppLayer, { memoMap: appMemoMap })

/**
 * What the runtime provides. Named so the `run` signature can say "some subset of
 * these" rather than an unconstrained `R` the runtime could never satisfy.
 */
type AppServices = MemoryEngine | MemoryStore | TurnExtractor | Keys

/** Run a request-scoped effect against the process runtime. */
export const run = <A, E>(effect: Effect.Effect<A, E, AppServices>): Promise<A> =>
  runtime.runPromise(effect)

/**
 * The shape every route handler ends with.
 *
 * Bound to this runtime so handlers do not have to know that the layer graph
 * has to be provided before anything can run.
 */
export const respond = <A, E extends CognitiveMemoryError>(
  effect: Effect.Effect<A, E, AppServices>,
  options?: { readonly status?: number; readonly headers?: Record<string, string> }
): Promise<Response> => respondWith(run, effect, options)

export const runExit = runtime.runPromiseExit

/**
 * Read the credential a request presented.
 *
 * `Authorization: Bearer` is tried first and `x-cognitive-memory-key` second, because some
 * of the SDKs an agent might be driving cannot set custom headers on a fetch but
 * all of them can set Authorization.
 */
export const presentedCredential = (request: Request): string | null => {
  const header = request.headers.get("authorization")
  if (header?.startsWith("Bearer ")) return header.slice(7)
  return request.headers.get("x-cognitive-memory-key")
}

/** Authenticate an agent's key, requiring a scope. */
export const authorize = (request: Request, scope: string) =>
  Effect.gen(function* () {
    const keys = yield* Keys
    const caller = yield* keys.authenticate(presentedCredential(request))
    yield* requireScope(caller, scope)
    return caller
  })

/** The signed-in user, from the session cookie. */
export const currentSession = Effect.gen(function* () {
  const requestHeaders = yield* Effect.promise(() => headers())
  return yield* Effect.tryPromise({
    try: () => getAuth().api.getSession({ headers: requestHeaders }),
    // A failure here means no usable session, which is a 401 rather than a 500.
    catch: () => new Unauthorized({ message: "Could not read the session cookie." })
  })
})

/** A signed-in user, failing with `Unauthorized` when there is none. */
export const requireSession = Effect.gen(function* () {
  const session = yield* currentSession
  if (session === null) {
    return yield* new Unauthorized({ message: "Sign in to continue." })
  }
  return session
})

/**
 * A session that may only act on one of its own organisations.
 *
 * The organisation always comes from the session, never from a request field:
 * accepting an id from the caller here would let a member of one organisation
 * read another's memory just by changing a query parameter.
 */
export const requireOrganization = Effect.gen(function* () {
  const session = yield* requireSession
  const organizationId = session.session.activeOrganizationId
  if (!organizationId) {
    return yield* new Forbidden({ message: "Select or create an organisation first." })
  }
  return { session, organizationId, userId: session.user.id }
})

export { MemoryEngine, MemoryStore, CognitiveMemorySettings }
