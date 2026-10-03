import { Effect } from "effect"

import { authConfigured } from "@/server/auth/better-auth"
import { extractorMode, settings } from "@/server/config"
import { respond } from "@/server/runtime"

/**
 * Liveness, and what this deployment can actually do.
 *
 * Unauthenticated on purpose: an orchestrator has to be able to reach it without
 * holding a key, and nothing here is tenant data. It reports the extractor mode
 * and any environment values that were unusable, which is the difference
 * between "memory is not learning" being a mystery and being a config typo.
 */
export const dynamic = "force-dynamic"

const program = Effect.gen(function* () {
  const config = yield* settings
  const mode = yield* extractorMode
  const problems = [...config.problems]
  if (!authConfigured()) {
    problems.push("BETTER_AUTH_SECRET is not set, so sign-in will fail.")
  }
  return {
    ok: true,
    service: "cognitive-memory",
    version: "0.1.0",
    extractor: mode,
    // Which provider extraction actually talks to. Without this the only way to
    // tell an OpenRouter deployment from an OpenAI one was to read the request
    // log, and the health endpoint answered "fine" for both.
    model: {
      provider: config.modelProvider,
      label: config.modelProviderLabel,
      client: config.modelClient,
      name: config.modelName,
      baseUrl: config.modelBaseUrl,
      configured: config.modelApiKey !== null
    },
    limits: {
      maxTotalTokens: config.maxTotalTokens,
      maxIndexItems: config.maxIndexItems,
      defaultRecallLimit: config.defaultRecallLimit
    },
    // Non-empty only when something was present but unusable, or missing where
    // it is required. Empty is the healthy case, so an operator can alert on it
    // without a special case.
    problems
  }
})

export const GET = async (): Promise<Response> => respond(program)
