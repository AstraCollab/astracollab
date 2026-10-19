/**
 * Where the service is.
 *
 * The client used to default to `http://localhost:3000`, which is right for
 * someone running the service on their own machine and wrong for everyone who
 * installed the package: an agent that was not told a base URL sent every
 * request to its own localhost, and the failure — a connection refused, or a
 * response from something else entirely that happens to be listening on 3000 —
 * says nothing about the URL being the problem.
 *
 * So the default is the hosted service, and the order of preference is:
 *
 *   1. `baseUrl` on the config, because it is the most explicit statement there
 *      is.
 *   2. `COGNITIVE_MEMORY_URL` in the environment, which is how a self-hosted
 *      deployment — or a CI job that must not talk to production — says where
 *      it is. The same name the CLI uses, so one variable configures both.
 *   3. The origin of the page, in a browser, because a browser calling the
 *      service is nearly always calling the one that served it.
 *   4. The hosted service, which is where the package points when nothing says
 *      otherwise.
 */

/** The hosted service. */
export const DEFAULT_BASE_URL = "https://cogmem.astracollab.app"

/** The URL the environment names, if it names one. */
const environmentBaseUrl = (): string | undefined => {
  // `process` does not exist in a browser bundle, and reading it unguarded
  // throws there rather than returning nothing.
  if (typeof process === "undefined") return undefined
  const value = process.env?.COGNITIVE_MEMORY_URL
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined
}

/** The origin of the page, in a browser. */
const browserBaseUrl = (): string | undefined => {
  if (typeof window === "undefined") return undefined
  const origin = window.location?.origin
  return typeof origin === "string" && origin !== "" ? origin : undefined
}

/** Trailing slashes removed, because the paths are appended to it. */
const withoutTrailingSlash = (url: string): string => url.replace(/\/+$/, "")

/**
 * The URL to talk to.
 *
 * `configured` is the caller's own `baseUrl`, when there is one.
 */
export const resolveBaseUrl = (configured?: string): string => {
  const explicit = configured?.trim()
  if (explicit) return withoutTrailingSlash(explicit)
  const fromEnv = environmentBaseUrl()
  if (fromEnv) return withoutTrailingSlash(fromEnv)
  const fromBrowser = browserBaseUrl()
  if (fromBrowser) return withoutTrailingSlash(fromBrowser)
  return DEFAULT_BASE_URL
}
