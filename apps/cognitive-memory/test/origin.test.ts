import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

/**
 * Which host this deployment answers on.
 *
 * A deployment that answers on `http://localhost:3000` while it is served from
 * `https://cogmem.astracollab.app` does not fail loudly. The browser asks the
 * wrong host, the origin check rejects the host that asked, and the session
 * cookie arrives without `Secure` — three symptoms with one cause, and none
 * of them says "wrong origin". These are the cases where the origin used to
 * disagree with the request.
 */

const ENV = ["BETTER_AUTH_URL", "PORT"] as const

beforeEach(() => {
  vi.resetModules()
})

afterEach(() => {
  for (const key of ENV) delete process.env[key]
  vi.unstubAllEnvs()
})

const headers = (values: Record<string, string>): Headers => new Headers(values)

describe("origin from request headers", () => {
  it("takes the host and the protocol a proxy forwarded", async () => {
    const { originFromHeaders } = await import("@/server/auth/origin")

    const origin = originFromHeaders(
      headers({
        "x-forwarded-host": "cogmem.astracollab.app",
        "x-forwarded-proto": "https",
        host: "localhost:3000"
      })
    )

    expect(origin).toBe("https://cogmem.astracollab.app")
  })

  it("reads the first entry of a forwarded list", async () => {
    const { originFromHeaders } = await import("@/server/auth/origin")

    const origin = originFromHeaders(
      headers({ "x-forwarded-host": "cogmem.astracollab.app, internal.local", "x-forwarded-proto": "https, http" })
    )

    expect(origin).toBe("https://cogmem.astracollab.app")
  })

  it("calls a public host https even when no protocol was forwarded", async () => {
    const { originFromHeaders } = await import("@/server/auth/origin")

    expect(originFromHeaders(headers({ host: "cogmem.astracollab.app" }))).toBe(
      "https://cogmem.astracollab.app"
    )
  })

  it("does not believe an http claim for a public host", async () => {
    const { originFromHeaders } = await import("@/server/auth/origin")

    // Next.js fills `x-forwarded-proto` in with the scheme of the internal hop
    // when no proxy sent one, so an `http` here is the hop, not the truth.
    expect(
      originFromHeaders(
        headers({ "x-forwarded-host": "cogmem.astracollab.app", "x-forwarded-proto": "http" })
      )
    ).toBe("https://cogmem.astracollab.app")
  })

  it("calls a loopback host http, because that is a developer machine", async () => {
    const { originFromHeaders } = await import("@/server/auth/origin")

    expect(originFromHeaders(headers({ host: "localhost:3000" }))).toBe("http://localhost:3000")
    expect(originFromHeaders(headers({ host: "127.0.0.1:3000" }))).toBe("http://127.0.0.1:3000")
  })

  it("keeps a private address on http in development", async () => {
    vi.stubEnv("NODE_ENV", "development")
    const { originFromHeaders } = await import("@/server/auth/origin")

    expect(originFromHeaders(headers({ host: "192.168.1.20:3000" }))).toBe("http://192.168.1.20:3000")
  })

  it("calls a private address https in production, where the cookie is Secure", async () => {
    vi.stubEnv("NODE_ENV", "production")
    const { originFromHeaders } = await import("@/server/auth/origin")

    expect(originFromHeaders(headers({ host: "192.168.1.20:3000" }))).toBe("https://192.168.1.20:3000")
  })

  it("has nothing to say when the request names no host", async () => {
    const { originFromHeaders } = await import("@/server/auth/origin")

    expect(originFromHeaders(headers({}))).toBeNull()
  })
})

describe("resolved origin", () => {
  it("is the configured URL when the operator sets one", async () => {
    process.env.BETTER_AUTH_URL = "https://cogmem.astracollab.app"
    const { resolveOrigin } = await import("@/server/auth/origin")

    const origin = resolveOrigin(headers({ host: "internal.local:3000" }))

    expect(origin).toBe("https://cogmem.astracollab.app")
  })

  it("is the host of the request when nothing is configured", async () => {
    const { resolveOrigin } = await import("@/server/auth/origin")

    const origin = resolveOrigin(
      headers({ "x-forwarded-host": "cogmem.astracollab.app", "x-forwarded-proto": "https" })
    )

    expect(origin).toBe("https://cogmem.astracollab.app")
  })

  it("falls back to localhost only when there is nothing else to go on", async () => {
    const { resolveOrigin } = await import("@/server/auth/origin")

    expect(resolveOrigin()).toBe("http://localhost:3000")
  })

  it("remembers the origin for a caller that has no request to offer", async () => {
    const { resolveOrigin } = await import("@/server/auth/origin")

    resolveOrigin(headers({ "x-forwarded-host": "cogmem.astracollab.app", "x-forwarded-proto": "https" }))

    expect(resolveOrigin()).toBe("https://cogmem.astracollab.app")
  })
})
