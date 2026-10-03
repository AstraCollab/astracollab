import { Context, Effect } from "effect"

/**
 * Where Effect meets the framework.
 *
 * A `Context.Reference` rather than a Layer because the environment is the
 * source of truth and there is nothing to construct. Note the *function* form:
 * `Context.Reference` is a plain factory in Effect 4, not a class to extend.
 *
 * The trade-off is that `defaultValue` cannot fail loudly, so an unusable value
 * is recorded in `problems` and surfaced by `/api/v1/health` and the dashboard
 * rather than thrown during module load — which would take down `next build`
 * instead of just the request that needed the setting.
 */

export interface CognitiveMemorySettingsValue {
  /** SQLite file. ":memory:" is useful for tests. */
  readonly databasePath: string
  /** Ceiling on everything injected into one prompt, index and bodies together. */
  readonly maxTotalTokens: number
  /** Upper bound on index lines, so a large store cannot fill the window. */
  readonly maxIndexItems: number
  /** Default number of results for a recall. */
  readonly defaultRecallLimit: number
  /** When set, turns are also summarised by a model. See `./engine/turn-extractor.ts`. */
  readonly modelApiKey: string | null
  readonly modelBaseUrl: string | null
  readonly modelName: string
  /** Which provider the endpoint above belongs to, for the health report. */
  readonly modelProvider: ModelProvider
  /** What to call that provider in the dashboard. */
  readonly modelProviderLabel: string
  /** Which client layer the extractor has to build to reach that provider. */
  readonly modelClient: ModelClient
  /** Environment values that were unusable, with the fallback used instead. */
  readonly problems: Array<string>
}

/**
 * Which wire protocol a provider speaks.
 *
 * Most of them speak OpenAI's, which is why one client covers four of the six
 * providers here. Anthropic's API is not a base-URL variant of it — different
 * request shape, different tool format — so it gets its own client rather than
 * being approximated, because an approximation fails in the response parser
 * where nobody is looking.
 */
export type ModelClient = "openai-compatible" | "anthropic"

/**
 * The providers this deployment can be pointed at.
 *
 * This table exists to answer the question an operator actually has — *where are
 * my extraction requests going* — and to supply the endpoint, the model and the
 * client that go with that answer. Without it, a deployment pointed at
 * OpenRouter still reported `gpt-4o-mini` against `api.openai.com` in the
 * dashboard, because the only way to reach another provider was to set a base
 * URL by hand and nothing recorded that the base URL was no longer OpenAI's.
 */
export type ModelProvider = "openai" | "openrouter" | "groq" | "together" | "anthropic" | "custom"

interface ProviderDefaults {
  readonly label: string
  readonly client: ModelClient
  /** `null` is the client's own default endpoint. */
  readonly baseUrl: string | null
  /**
   * `null` means this provider has no model worth guessing at. Guessing sends
   * a request for a model the provider does not serve, which fails as an opaque
   * 404 from the gateway rather than as a configuration error.
   */
  readonly defaultModel: string | null
}

const PROVIDERS: Record<ModelProvider, ProviderDefaults> = {
  openai: { label: "OpenAI", client: "openai-compatible", baseUrl: null, defaultModel: "gpt-4o-mini" },
  openrouter: {
    label: "OpenRouter",
    client: "openai-compatible",
    baseUrl: "https://openrouter.ai/api/v1",
    defaultModel: "openai/gpt-4o-mini"
  },
  groq: {
    label: "Groq",
    client: "openai-compatible",
    baseUrl: "https://api.groq.com/openai/v1",
    defaultModel: null
  },
  together: {
    label: "Together",
    client: "openai-compatible",
    baseUrl: "https://api.together.xyz/v1",
    defaultModel: null
  },
  anthropic: {
    label: "Anthropic",
    client: "anthropic",
    baseUrl: null,
    defaultModel: "claude-haiku-4-5"
  },
  custom: { label: "Custom (OpenAI-compatible)", client: "openai-compatible", baseUrl: null, defaultModel: null }
}

const provider = (raw: string | undefined, problems: Array<string>): ModelProvider => {
  const name = raw?.trim().toLowerCase()
  if (name === undefined || name === "") return "openai"
  if (name in PROVIDERS) return name as ModelProvider
  problems.push(
    `COGNITIVE_MEMORY_MODEL_PROVIDER="${raw}" is not one of ${Object.keys(PROVIDERS).join(", ")}; using openai.`
  )
  return "openai"
}

const int = (
  raw: string | undefined,
  fallback: number,
  name: string,
  problems: Array<string>
): number => {
  if (raw === undefined || raw.trim() === "") return fallback
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    problems.push(`${name}="${raw}" is not a positive integer; using ${fallback}.`)
    return fallback
  }
  return parsed
}

export const readCognitiveMemorySettings = (): CognitiveMemorySettingsValue => {
  const problems: Array<string> = []
  const env = process.env
  const modelProvider = provider(env.COGNITIVE_MEMORY_MODEL_PROVIDER, problems)
  const defaults = PROVIDERS[modelProvider]
  // An explicit endpoint or name always wins: the provider says where to look,
  // the operator says where to look when they disagree.
  const modelName = env.COGNITIVE_MEMORY_MODEL_NAME?.trim() || defaults.defaultModel || "gpt-4o-mini"
  if (env.COGNITIVE_MEMORY_MODEL_NAME?.trim() === undefined && defaults.defaultModel === null) {
    problems.push(
      `COGNITIVE_MEMORY_MODEL_NAME is not set, so extraction will ask ${defaults.label} for "gpt-4o-mini". Set a model that provider serves.`
    )
  }

  return {
    databasePath: env.COGNITIVE_MEMORY_DATABASE_PATH?.trim() || ".cognitive-memory/cognitive-memory.sqlite",
    maxTotalTokens: int(env.COGNITIVE_MEMORY_MAX_TOTAL_TOKENS, 2000, "COGNITIVE_MEMORY_MAX_TOTAL_TOKENS", problems),
    maxIndexItems: int(env.COGNITIVE_MEMORY_MAX_INDEX_ITEMS, 60, "COGNITIVE_MEMORY_MAX_INDEX_ITEMS", problems),
    defaultRecallLimit: int(env.COGNITIVE_MEMORY_DEFAULT_RECALL_LIMIT, 8, "COGNITIVE_MEMORY_DEFAULT_RECALL_LIMIT", problems),
    modelApiKey: env.COGNITIVE_MEMORY_MODEL_API_KEY?.trim() || null,
    modelBaseUrl: env.COGNITIVE_MEMORY_MODEL_BASE_URL?.trim() || defaults.baseUrl,
    modelName,
    modelProvider,
    modelProviderLabel: defaults.label,
    modelClient: defaults.client,
    problems
  }
}

export const CognitiveMemorySettings = Context.Reference<CognitiveMemorySettingsValue>("cognitive-memory/Settings", {
  defaultValue: readCognitiveMemorySettings
})

/** The settings as an effect, for the places that need the value itself. */
export const settings = Effect.service(CognitiveMemorySettings)

/**
 * The budgets actually in force for one organisation.
 *
 * An override wins over the deployment default, and a null override means
 * "inherit" — so a dashboard can show both numbers and a change of mind is one
 * `null`. Kept here rather than in the engine because the engine, the health
 * endpoint and the analytics report all need the same answer, and three places
 * each deciding what an override means is three places to be subtly wrong.
 */
export interface EffectiveBudgets {
  readonly maxTotalTokens: number
  readonly maxIndexItems: number
  readonly defaultRecallLimit: number
}

export const mergeBudgets = (
  config: CognitiveMemorySettingsValue,
  overrides: {
    readonly maxTotalTokens: number | null
    readonly maxIndexItems: number | null
    readonly defaultRecallLimit: number | null
  }
): EffectiveBudgets => ({
  maxTotalTokens: overrides.maxTotalTokens ?? config.maxTotalTokens,
  maxIndexItems: overrides.maxIndexItems ?? config.maxIndexItems,
  defaultRecallLimit: overrides.defaultRecallLimit ?? config.defaultRecallLimit
})

/** Whether model-backed extraction is available, for the health endpoint. */
export const extractorMode = Effect.map(
  settings,
  (current): "rules-only" | "rules+model" =>
    current.modelApiKey !== null ? "rules+model" : "rules-only"
)
