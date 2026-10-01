import { Cause, Effect, Exit, Schema } from "effect"

import { InvalidRequest, CognitiveMemoryError } from "../domain/errors"

/**
 * The one place a domain failure becomes an HTTP status.
 *
 * Every route handler ends in `respond`, so there is exactly one table from
 * error to status. A route that maps its own errors is a route that gets
 * `StorageFailure` wrong and answers an outage with a 400, or hides a bug behind
 * a tidy message.
 *
 * The runner is passed in rather than hardcoded because the Effect layer graph
 * has to be provided by the caller's runtime: this module knows how to render a
 * result, not how to build the application.
 */

const STATUS_BY_TAG: Record<string, number> = {
  Unauthorized: 401,
  Forbidden: 403,
  NotFound: 404,
  InvalidRequest: 400,
  StorageFailure: 500,
  ModelFailure: 502,
  BootstrapDisabled: 503
}

/** Only these are worth a warning: the rest are the client's problem, not ours. */
const QUIET_ON_FAILURE = new Set(["Unauthorized", "Forbidden", "NotFound", "InvalidRequest"])

const errorBody = (error: Record<string, unknown> & { readonly _tag: string }): Record<string, unknown> => {
  const body: Record<string, unknown> = {
    error: error._tag,
    message: typeof error.message === "string" ? error.message : "Request failed."
  }
  if (typeof error.requiredScope === "string") body.requiredScope = error.requiredScope
  if (typeof error.resource === "string") body.resource = error.resource
  if (typeof error.id === "string") body.id = error.id
  if (Array.isArray(error.issues)) body.issues = error.issues
  return body
}

const json = (body: unknown, status: number, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers }
  })

/**
 * Render a failure.
 *
 * Failures are values, so they become responses. Defects — a bug, a driver
 * crash — are logged with their cause and answered with a 500 that says nothing
 * about internals, because that cause is where connection strings and query text
 * live.
 */
export const renderFailure = (exit: Exit.Exit<unknown, unknown>): Response => {
  const cause = Exit.getCause(exit)
  if (cause._tag === "None") {
    Effect.logError("request interrupted").pipe(Effect.runFork)
    return json({ error: "Internal", message: "The request was interrupted." }, 500)
  }
  const squashed = Cause.squash(cause.value)
  const error =
    typeof squashed === "object" && squashed !== null
      ? (squashed as Record<string, unknown> & { readonly _tag: string })
      : null
  const status = error === null ? undefined : STATUS_BY_TAG[error._tag]
  if (error === null || status === undefined) {
    Effect.logError("unhandled defect in request", squashed).pipe(Effect.runFork)
    return json({ error: "Internal", message: "The request failed unexpectedly." }, 500)
  }
  if (!QUIET_ON_FAILURE.has(error._tag)) {
    Effect.logWarning(`${error._tag}: ${errorBody(error).message}`).pipe(Effect.runFork)
  }
  return json(errorBody(error), status)
}

/**
 * Run a request effect and render the outcome.
 *
 * The `Exit` is matched as a *value*, not as an error channel. `Effect.exit`
 * turns a failure into a successful value carrying the `Exit`, so matching it
 * any other way reports every failed request as a success.
 */
export const respondWith = <A, E extends CognitiveMemoryError, R>(
  // The runner is an implementation detail (in practice `runtime.runPromise`),
  // so it is typed loosely on purpose: threading a generic through both the
  // runner and the effect buys nothing and fights Effect's own variance rules.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  runner: (effect: Effect.Effect<any, any, any>) => Promise<any>,
  effect: Effect.Effect<A, E, R>,
  options?: { readonly status?: number; readonly headers?: Record<string, string> }
): Promise<Response> =>
  runner(effect.pipe(Effect.exit)).then((exit: Exit.Exit<A, E>) =>
    Exit.isSuccess(exit)
      ? json(exit.value, options?.status ?? 200, options?.headers)
      : renderFailure(exit)
  )

/**
 * Decode an untrusted request body.
 *
 * The accepted shape is declared once, next to the handler that uses it, rather
 * than re-implemented as guards. The issue is flattened into something a caller
 * can act on, because a raw schema error is unreadable over HTTP.
 */
export const decodeBody = <S extends Schema.Top>(schema: S, raw: unknown) =>
  Schema.decodeUnknownEffect(schema)(raw).pipe(
    // A real `InvalidRequest`, not a lookalike object: the HTTP layer maps on
    // `_tag`, and a plain object would not be assignable to `CognitiveMemoryError`.
    Effect.mapError(
      (error) =>
        new InvalidRequest({
          message: "Request body did not match the expected shape.",
          issues: [error.message]
        })
    )
  )

/** Read a JSON body, treating an empty or malformed one as `{}`. */
export const readJson = (request: Request): Promise<unknown> =>
  request.json().catch(() => ({}))
