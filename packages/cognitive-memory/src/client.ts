import { FetchError, ofetch, type $Fetch } from "ofetch"

import { CognitiveMemoryError } from "./errors"
import type { CognitiveMemoryConfig, CognitiveMemoryErrorBody } from "./types"

/**
 * Configuration, as a factory rather than a constructor.
 *
 * A constructor with fifteen options is a dumping ground: configuration and
 * instantiation get tangled, tests have to construct a whole class to check one
 * header, and "the client with a different timeout" becomes a subclass. A factory
 * is a plain function — no `new`, no `this`, composable, trivially mockable.
 *
 * The real work happens in the interceptors. Authentication, error translation
 * and debug logging are configured once here instead of being repeated in each
 * of the twenty-odd methods below, which is the difference between changing how
 * auth works in one place and in twenty.
 */
export function createHttpClient(config: CognitiveMemoryConfig): $Fetch {
  const {
    apiKey,
    baseUrl = defaultBaseUrl(),
    timeout = 30_000,
    retry = 2,
    debug = false,
    headers: extraHeaders = {}
  } = config

  if (typeof apiKey !== "string" || apiKey.trim() === "") {
    throw new Error(
      "cognitive-memory: apiKey is required. Issue one in the dashboard — the secret is shown only once."
    )
  }

  const inner = ofetch.create({
    baseURL: `${baseUrl.replace(/\/$/, "")}/api/v1`,
    timeout,
    // Retries are for transport hiccups, not for a 400. ofetch already limits
    // this to idempotent-looking methods, and the service is idempotent for the
    // reads that matter.
    retry,
    headers: {
      accept: "application/json",
      ...extraHeaders
    },

    onRequest({ options, request }) {
      // `options.headers` is a Headers instance by this point, not a plain
      // object — assigning to it silently drops every header.
      options.headers.set("authorization", `Bearer ${apiKey}`)
      options.headers.set("content-type", "application/json")
      if (debug) {
        // eslint-disable-next-line no-console
        console.log("[cognitive-memory]", options.method ?? "GET", `${options.baseURL ?? ""}${request ?? ""}`)
      }
    },

    onResponse({ response, options, request }) {
      if (debug) {
        // eslint-disable-next-line no-console
        console.log("[cognitive-memory]", response.status, options.method ?? "GET", request ?? "")
      }
    },

  })

  /**
   * Error translation happens out here rather than in `onResponseError`.
   *
   * ofetch 1.4 replaces anything thrown from that hook with its own `FetchError`
   * before it reaches the caller, so a hook that throws is a hook whose error
   * silently disappears — the caller gets an exception with no status, no scope
   * and no issues. Catching here is the only place the service's envelope can be
   * read, and it leaves genuine transport failures (no response) untouched.
   */
  // The parameter types are taken from `$Fetch` itself rather than restated, so
  // this wrapper cannot drift out of step with the client it wraps.
  const wrap = async (request: unknown, options?: unknown): Promise<unknown> => {
    try {
      return await (inner as (r: unknown, o?: unknown) => Promise<unknown>)(request, options)
    } catch (error) {
      if (!(error instanceof FetchError) || !error.response) throw error
      const response = error.response
      // The service always answers with this envelope; a proxy or a crash in
      // front of it might not, so the body is treated as untrusted.
      const body = (response._data ?? undefined) as CognitiveMemoryErrorBody | undefined
      throw new CognitiveMemoryError(body?.message ?? `cognitive-memory: request failed with ${response.status}`, {
        status: response.status,
        code: body?.error ?? "UnknownError",
        ...(body === undefined ? {} : { body }),
        ...(body?.requiredScope === undefined ? {} : { requiredScope: body.requiredScope }),
        ...(body?.issues === undefined ? {} : { issues: body.issues })
      })
    }
  }

  return wrap as unknown as $Fetch
}

function defaultBaseUrl(): string {
  if (typeof window !== "undefined") return window.location.origin
  return "http://localhost:3000"
}

export type HttpClient = ReturnType<typeof createHttpClient>
