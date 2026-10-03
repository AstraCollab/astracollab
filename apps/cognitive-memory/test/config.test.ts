import { afterEach, describe, expect, it } from "vitest"

import { readCognitiveMemorySettings } from "@/server/config"

/**
 * Where extraction requests are sent.
 *
 * A deployment pointed at one gateway while reporting another is worse than no
 * configuration at all: memory keeps working, the dashboard says the wrong
 * thing, and the operator has no signal that their key is going somewhere they
 * did not choose. These are the cases where the two used to disagree.
 */

const KEYS = [
  "COGNITIVE_MEMORY_MODEL_PROVIDER",
  "COGNITIVE_MEMORY_MODEL_BASE_URL",
  "COGNITIVE_MEMORY_MODEL_NAME",
  "COGNITIVE_MEMORY_MODEL_API_KEY"
] as const

afterEach(() => {
  for (const key of KEYS) delete process.env[key]
})

const configure = (env: Partial<Record<(typeof KEYS)[number], string>>): void => {
  for (const [key, value] of Object.entries(env)) process.env[key] = value
}

describe("model provider", () => {
  it("defaults to OpenAI, endpoint and model both", () => {
    const config = readCognitiveMemorySettings()

    expect(config.modelProvider).toBe("openai")
    expect(config.modelBaseUrl).toBeNull()
    expect(config.modelName).toBe("gpt-4o-mini")
    expect(config.problems).toEqual([])
  })

  it("points OpenRouter at OpenRouter, not at OpenAI", () => {
    configure({ COGNITIVE_MEMORY_MODEL_PROVIDER: "openrouter" })
    const config = readCognitiveMemorySettings()

    expect(config.modelBaseUrl).toBe("https://openrouter.ai/api/v1")
    expect(config.modelName).toBe("openai/gpt-4o-mini")
    expect(config.modelProviderLabel).toBe("OpenRouter")
    expect(config.problems).toEqual([])
  })

  it("accepts the provider in any case, because it is typed by hand", () => {
    configure({ COGNITIVE_MEMORY_MODEL_PROVIDER: "  OpenRouter " })
    expect(readCognitiveMemorySettings().modelProvider).toBe("openrouter")
  })

  it("lets an explicit base URL and name override the provider", () => {
    configure({
      COGNITIVE_MEMORY_MODEL_PROVIDER: "openrouter",
      COGNITIVE_MEMORY_MODEL_BASE_URL: "http://localhost:11434/v1",
      COGNITIVE_MEMORY_MODEL_NAME: "qwen2.5:14b"
    })
    const config = readCognitiveMemorySettings()

    expect(config.modelBaseUrl).toBe("http://localhost:11434/v1")
    expect(config.modelName).toBe("qwen2.5:14b")
    expect(config.problems).toEqual([])
  })

  it("reports a provider it does not know, and says what it used instead", () => {
    configure({ COGNITIVE_MEMORY_MODEL_PROVIDER: "ollama" })
    const config = readCognitiveMemorySettings()

    expect(config.modelProvider).toBe("openai")
    expect(config.problems.join(" ")).toMatch(/COGNITIVE_MEMORY_MODEL_PROVIDER="ollama".*using openai/)
  })

  it("will not guess a model for a provider with no default", () => {
    configure({ COGNITIVE_MEMORY_MODEL_PROVIDER: "groq" })
    const config = readCognitiveMemorySettings()

    expect(config.modelBaseUrl).toBe("https://api.groq.com/openai/v1")
    expect(config.problems.join(" ")).toMatch(/COGNITIVE_MEMORY_MODEL_NAME is not set/)
  })

  it("reaches Anthropic over its own client, not the OpenAI one", () => {
    configure({ COGNITIVE_MEMORY_MODEL_PROVIDER: "anthropic" })
    const config = readCognitiveMemorySettings()

    // Its API is not a base-URL variant of OpenAI's, so an OpenAI client would
    // send the wrong request shape and fail in the response parser.
    expect(config.modelClient).toBe("anthropic")
    expect(config.modelName).toBe("claude-haiku-4-5")
    expect(config.modelBaseUrl).toBeNull()
    expect(config.problems).toEqual([])
  })

  it("keeps every gateway on the OpenAI-compatible client", () => {
    for (const name of ["openai", "openrouter", "groq", "together", "custom"] as const) {
      configure({ COGNITIVE_MEMORY_MODEL_PROVIDER: name, COGNITIVE_MEMORY_MODEL_NAME: "some-model" })
      expect(readCognitiveMemorySettings().modelClient).toBe("openai-compatible")
    }
  })

  it("lets an Anthropic deployment move to a proxy without changing client", () => {
    configure({
      COGNITIVE_MEMORY_MODEL_PROVIDER: "anthropic",
      COGNITIVE_MEMORY_MODEL_BASE_URL: "https://gateway.internal/anthropic"
    })
    const config = readCognitiveMemorySettings()

    expect(config.modelClient).toBe("anthropic")
    expect(config.modelBaseUrl).toBe("https://gateway.internal/anthropic")
  })
})
