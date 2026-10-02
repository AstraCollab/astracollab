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
  /** Environment values that were unusable, with the fallback used instead. */
  readonly problems: Array<string>
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

  return {
    databasePath: env.COGNITIVE_MEMORY_DATABASE_PATH?.trim() || ".cognitive-memory/cognitive-memory.sqlite",
    maxTotalTokens: int(env.COGNITIVE_MEMORY_MAX_TOTAL_TOKENS, 2000, "COGNITIVE_MEMORY_MAX_TOTAL_TOKENS", problems),
    maxIndexItems: int(env.COGNITIVE_MEMORY_MAX_INDEX_ITEMS, 60, "COGNITIVE_MEMORY_MAX_INDEX_ITEMS", problems),
    defaultRecallLimit: int(env.COGNITIVE_MEMORY_DEFAULT_RECALL_LIMIT, 8, "COGNITIVE_MEMORY_DEFAULT_RECALL_LIMIT", problems),
    modelApiKey: env.COGNITIVE_MEMORY_MODEL_API_KEY?.trim() || null,
    modelBaseUrl: env.COGNITIVE_MEMORY_MODEL_BASE_URL?.trim() || null,
    modelName: env.COGNITIVE_MEMORY_MODEL_NAME?.trim() || "gpt-4o-mini",
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
