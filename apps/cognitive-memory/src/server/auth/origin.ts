/**
 * The public origin of this deployment.
 *
 * Better Auth needs it in two places that fail quietly when it is wrong: the
 * trusted-origin check that every sign-in and every session refresh goes
 * through, and the `Secure` flag on the session cookie. `http://localhost:3000`
 * is not a fallback for those two, it is an answer — and in production it is
 * the wrong one, which makes the origin check reject the host the browser is
 * actually on and the cookie arrive without `Secure`.
 *
 * So the origin is resolved rather than assumed:
 *
 *   1. `BETTER_AUTH_URL`, when the operator sets it. Explicit beats inferred.
 *   2. The host the request was addressed to. Behind a proxy the request URL
 *      is the internal one — on Vercel it is `http://localhost:3000` — so the
 *      public name of the deployment exists only in the forwarded headers.
 *   3. `http://localhost:${PORT}`, for a developer running the app locally.
 *
 * A deployment answers on one host, so the answer barely changes; it is
 * remembered anyway, because a caller without a request to offer should still
 * get the origin the rest of the process is using.
 */

/** The first entry of a header that may carry a comma-separated list. */
const firstValue = (value: string | null): string | null => {
  const first = value?.split(",")[0]?.trim()
  return first === undefined || first === "" ? null : first
}

/** The name of a host, without its port. */
const hostName = (host: string): string =>
  host.replace(/:\d+$/, "").replace(/^\[|\]$/g, "").toLowerCase()

/** Whether a host names this machine. */
const isLoopback = (host: string): boolean => {
  const name = hostName(host)
  return name === "localhost" || name.endsWith(".localhost") || name === "::1" || name.startsWith("127.")
}

/**
 * Whether a host names a machine or a private network rather than a public
 * name.
 *
 * The distinction decides the scheme when the request does not: a developer on
 * `localhost` or on `192.168.1.20` is served over http, a deployment with a
 * public name is served over TLS.
 */
const isLocalHost = (host: string): boolean => {
  const name = hostName(host)
  if (isLoopback(host)) return true
  if (name.endsWith(".local")) return true
  // A single-label name is a machine on the local network, not a domain.
  if (!name.includes(".")) return true
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(name)
  if (!ipv4) return false
  const [a, b] = [Number(ipv4[1]), Number(ipv4[2])]
  if (a === 10) return true
  if (a === 192 && b === 168) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 169 && b === 254) return true
  return false
}

/**
 * Whether this host may be served over http.
 *
 * In production, only this machine may: a deployment that answers on a name of
 * its own is served over TLS, and the session cookie is `Secure` there, so an
 * http deployment is already a broken one. In development, a private address
 * counts too — that is a colleague's laptop on the same network.
 */
const mayBeHttp = (host: string): boolean =>
  process.env.NODE_ENV === "production" ? isLoopback(host) : isLocalHost(host)

/**
 * The origin a request was addressed to.
 *
 * The forwarded host wins, because that is the host the client asked for and
 * the proxy in front of the app is what sets it; the plain `host` header is the
 * fallback for a deployment that is not proxied.
 *
 * The scheme needs more care than the host. Next.js fills `x-forwarded-proto`
 * in itself when no proxy sent one, and what it fills in is the scheme of the
 * internal hop — `http` between the proxy and the app — which says nothing
 * about the scheme the browser used. So a claim of `https` is believed, and
 * anything else is only believed for a host that may be served over http at
 * all. `BETTER_AUTH_URL` overrides all of it for the setups this reasoning
 * cannot know about.
 */
export const originFromHeaders = (headers: Headers): string | null => {
  const host = firstValue(headers.get("x-forwarded-host")) ?? firstValue(headers.get("host"))
  if (host === null) return null
  const proto = firstValue(headers.get("x-forwarded-proto"))
  if (proto === "https") return `https://${host}`
  if (proto === "http" && mayBeHttp(host)) return `http://${host}`
  return `${mayBeHttp(host) ? "http" : "https"}://${host}`
}

let remembered: string | null = null
let warned = false

/**
 * The origin this deployment answers on.
 *
 * `headers` are the headers of the request being served, when there is one.
 */
export const resolveOrigin = (headers?: Headers): string => {
  const configured = process.env.BETTER_AUTH_URL?.trim()
  if (configured) return configured

  const derived = headers ? originFromHeaders(headers) : null
  if (derived !== null) {
    remembered ??= derived
    return derived
  }
  if (remembered !== null) return remembered

  const local = `http://localhost:${process.env.PORT ?? 3000}`
  if (process.env.NODE_ENV === "production" && !warned) {
    // Loud, because the alternative is a deployment that answers sign-ins with
    // "invalid origin" and hands out cookies without `Secure`, and neither of
    // those says "wrong origin".
    warned = true
    process.emitWarning(
      `cognitive-memory: could not determine the public origin of this deployment, so it is using ${local}. Set BETTER_AUTH_URL to the URL this app is served from.`
    )
  }
  return local
}
