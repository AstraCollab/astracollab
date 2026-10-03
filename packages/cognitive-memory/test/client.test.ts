import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { createHttpClient } from "../src/client"
import { CognitiveMemoryError } from "../src/errors"
import { createClient } from "../src/cogmem"
import { TURN_FIELD_LIMIT } from "../src/resources/turns"

/**
 * The HTTP layer, tested at the HTTP layer.
 *
 * Mocking `fetch` rather than the resources is the point: what is worth checking
 * here is that every request is authenticated, that errors arrive as
 * `CognitiveMemoryError`, and that debug logging exists. Mocking the SDK instead would
 * test the mock.
 */

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  })

let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  fetchMock = vi.fn().mockResolvedValue(jsonResponse({ ok: true }))
  vi.stubGlobal("fetch", fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe("createHttpClient", () => {
  it("authenticates every request", async () => {
    const client = createHttpClient({ apiKey: "cmi_test_abcdef01_secret", baseUrl: "https://memory.test" })
    await client("/health")

    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe("https://memory.test/api/v1/health")
    // ofetch hands the hooks a Headers instance, so the header has to be read
    // through one rather than off a plain object.
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer cmi_test_abcdef01_secret")
  })

  it("refuses to be built without a key", () => {
    expect(() => createHttpClient({ apiKey: "" })).toThrow(/apiKey is required/)
  })

  it("turns an error envelope into a typed error", async () => {
    // A fresh Response per call: a body can only be read once, and these tests
    // deliberately call twice to check both the throw and the mapped value.
    fetchMock.mockImplementation(async () =>
      jsonResponse(
        {
          error: "Forbidden",
          message: "This key lacks the memories:write scope.",
          requiredScope: "memories:write"
        },
        403
      )
    )
    const client = createHttpClient({ apiKey: "k", baseUrl: "https://memory.test" })

    await expect(client("/memories", { method: "POST", body: {} })).rejects.toBeInstanceOf(CognitiveMemoryError)

    const error = await client("/memories", { method: "POST", body: {} }).catch((e: CognitiveMemoryError) => e)
    expect(error.isScopeError()).toBe(true)
    expect(error.requiredScope).toBe("memories:write")
    expect(error.message).toContain("memories:write")
  })

  it("carries validation issues through", async () => {
    fetchMock.mockImplementation(async () =>
      jsonResponse(
        { error: "InvalidRequest", message: "bad body", issues: ["Expected string at [query]"] },
        400
      )
    )
    const client = createHttpClient({ apiKey: "k", baseUrl: "https://memory.test" })
    const error = (await client("/recall", { method: "POST", body: {} }).catch((e) => e)) as CognitiveMemoryError

    expect(error.isValidationError()).toBe(true)
    expect(error.issues).toEqual(["Expected string at [query]"])
  })

  it("still produces a typed error when a proxy answers with something else", async () => {
    fetchMock.mockImplementation(async () => new Response("<html>502</html>", { status: 502 }))
    const client = createHttpClient({ apiKey: "k", baseUrl: "https://memory.test" })
    const error = (await client("/memories").catch((e) => e)) as CognitiveMemoryError

    expect(error).toBeInstanceOf(CognitiveMemoryError)
    expect(error.status).toBe(502)
    expect(error.isServerError()).toBe(true)
  })

  it("logs both sides of the exchange when debug is on", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {})
    const client = createHttpClient({ apiKey: "k", baseUrl: "https://memory.test", debug: true })
    await client("/memories")

    const messages = spy.mock.calls.map((call) => String(call[0]))
    expect(messages).toContain("[cognitive-memory]")
  })

  it("stays quiet by default", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {})
    const client = createHttpClient({ apiKey: "k", baseUrl: "https://memory.test" })
    await client("/memories")

    expect(spy).not.toHaveBeenCalled()
  })
})

describe("resources", () => {
  it("unwraps the envelope rather than leaking it", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ memories: [{ id: "mem-1", content: "a fact", tier: "L1" }] })
    )
    const memory = createClient({ apiKey: "k", baseUrl: "https://memory.test" })

    const memories = await memory.memories.list({ tier: "L1" })
    expect(memories).toHaveLength(1)
    expect(memories[0]?.content).toBe("a fact")
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ method: "GET" })
  })

  it("omits an undefined filter rather than sending the string undefined", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ tensions: [] }))
    const memory = createClient({ apiKey: "k", baseUrl: "https://memory.test" })
    await memory.tensions.list()

    const url = String(fetchMock.mock.calls[0]?.[0])
    expect(url).not.toContain("status")
  })

  it("encodes ids in the path", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ memory: { id: "a/b", content: "x", tier: "L1" } }))
    const memory = createClient({ apiKey: "k", baseUrl: "https://memory.test" })
    await memory.memories.get("a/b")

    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("/memories/a%2Fb")
  })

  it("clips a turn to what the service accepts instead of losing it", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ stored: [], mergedInto: [], rejected: [] }))
    const memory = createClient({ apiKey: "k", baseUrl: "https://memory.test" })

    // The service answers 400 above this, and a rejected turn learns nothing —
    // so an un-clipped runaway string is the whole exchange, thrown away.
    await memory.turns.learn({
      userMessage: "explain the scheduler",
      assistantResponse: "z".repeat(TURN_FIELD_LIMIT + 1000)
    })

    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))
    expect(body.assistantResponse).toHaveLength(TURN_FIELD_LIMIT + 1)
    expect(body.userMessage).toBe("explain the scheduler")
  })

  it("leaves a turn that fits alone", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ stored: [], mergedInto: [], rejected: [] }))
    const memory = createClient({ apiKey: "k", baseUrl: "https://memory.test" })

    await memory.turns.learn({ userMessage: "we deploy on Fridays", assistantResponse: "Noted." })

    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      userMessage: "we deploy on Fridays",
      assistantResponse: "Noted."
    })
  })
})
