import { afterEach, describe, expect, it, vi } from "vitest"

import { DEFAULT_BASE_URL, resolveBaseUrl } from "../src/base-url"
import { createClient } from "../src/cogmem"

/**
 * Where the client sends its requests.
 *
 * The default used to be `http://localhost:3000`, which meant an agent that
 * was installed and given a key was talking to its own machine: a connection
 * refused, or worse, something else on port 3000. The default is the hosted
 * service now, and the environment variable is how a self-hosted deployment
 * says where it is.
 */

afterEach(() => {
  vi.unstubAllEnvs()
})

describe("resolveBaseUrl", () => {
  it("points at the hosted service when nothing says otherwise", () => {
    expect(resolveBaseUrl()).toBe("https://cogmem.astracollab.app")
    expect(DEFAULT_BASE_URL).toBe("https://cogmem.astracollab.app")
  })

  it("takes the URL from the environment", () => {
    vi.stubEnv("COGNITIVE_MEMORY_URL", "https://memory.example.com")

    expect(resolveBaseUrl()).toBe("https://memory.example.com")
  })

  it("prefers an explicit base URL over the environment", () => {
    vi.stubEnv("COGNITIVE_MEMORY_URL", "https://memory.example.com")

    expect(resolveBaseUrl("https://other.example.com")).toBe("https://other.example.com")
  })

  it("ignores an empty value rather than talking to nothing", () => {
    vi.stubEnv("COGNITIVE_MEMORY_URL", "   ")

    expect(resolveBaseUrl()).toBe(DEFAULT_BASE_URL)
    expect(resolveBaseUrl("")).toBe(DEFAULT_BASE_URL)
  })

  it("strips the trailing slash, because the paths are appended to it", () => {
    expect(resolveBaseUrl("https://memory.example.com/")).toBe("https://memory.example.com")
  })
})

describe("the client", () => {
  it("talks to the hosted service unless it is told otherwise", () => {
    const memory = createClient({ apiKey: "cmi_test_abcdef01_secret" })

    expect(memory.baseUrl).toBe(DEFAULT_BASE_URL)
  })

  it("and the environment says where a self-hosted deployment is", () => {
    vi.stubEnv("COGNITIVE_MEMORY_URL", "https://memory.example.com")

    const memory = createClient({ apiKey: "cmi_test_abcdef01_secret" })

    expect(memory.baseUrl).toBe("https://memory.example.com")
  })
})
