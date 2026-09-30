import type { LanguageModel } from "ai";

export const DEFAULT_MODEL_SPEC = "anthropic:claude-sonnet-4-5";

export type ResolvedModel = {
  spec: string;
  provider: string;
  modelId: string;
  model: LanguageModel;
};

/**
 * Resolve `provider:model` to an AI SDK v5 LanguageModel.
 * Provider SDKs are lazy-imported so `nah` starts fast and only loads what it uses.
 *
 * Providers:
 *  - anthropic:<id>            (ANTHROPIC_API_KEY)
 *  - openai:<id>               (OPENAI_API_KEY)
 *  - openai-compatible:<id>    (NAH_API_KEY + NAH_BASE_URL, or OPENAI_COMPATIBLE_*)
 *  - openrouter:<id>           (OPENROUTER_API_KEY, or OPENAI-compatible env)
 */
export const resolveModel = async (
  spec: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ResolvedModel> => {
  const raw = (spec ?? env.NAH_MODEL ?? DEFAULT_MODEL_SPEC).trim();
  const sep = raw.indexOf(":");
  const provider = sep === -1 ? "anthropic" : raw.slice(0, sep).trim();
  const modelId = (sep === -1 ? raw : raw.slice(sep + 1)).trim();
  if (!modelId) {
    throw new Error(`Invalid model spec "${raw}" — expected provider:model-id`);
  }

  switch (provider) {
    case "anthropic": {
      if (!env.ANTHROPIC_API_KEY) {
        throw new Error("ANTHROPIC_API_KEY is not set (or use --model openai:* / openrouter:*)");
      }
      const { createAnthropic } = await import("@ai-sdk/anthropic");
      return { spec: raw, provider, modelId, model: createAnthropic()(modelId) };
    }
    case "openai": {
      if (!env.OPENAI_API_KEY) {
        throw new Error("OPENAI_API_KEY is not set");
      }
      const { createOpenAI } = await import("@ai-sdk/openai");
      return { spec: raw, provider, modelId, model: createOpenAI()(modelId) };
    }
    case "openrouter": {
      const apiKey = env.OPENROUTER_API_KEY ?? env.OPENAI_API_KEY;
      if (!apiKey) {
        throw new Error("OPENROUTER_API_KEY is not set");
      }
      const { createOpenAICompatible } = await import("@ai-sdk/openai-compatible");
      const oi = createOpenAICompatible({
        name: "openrouter",
        baseURL: env.OPENROUTER_BASE_URL ?? "https://openrouter.ai/api/v1",
        apiKey,
      });
      return { spec: raw, provider, modelId, model: oi(modelId) };
    }
    case "openai-compatible": {
      const apiKey = env.NAH_API_KEY ?? env.OPENAI_COMPATIBLE_API_KEY;
      const baseURL = env.NAH_BASE_URL ?? env.OPENAI_COMPATIBLE_BASE_URL;
      if (!apiKey || !baseURL) {
        throw new Error(
          "openai-compatible needs NAH_API_KEY and NAH_BASE_URL (or OPENAI_COMPATIBLE_*)",
        );
      }
      const { createOpenAICompatible } = await import("@ai-sdk/openai-compatible");
      const oi = createOpenAICompatible({ name: "openai-compatible", baseURL, apiKey });
      return { spec: raw, provider, modelId, model: oi(modelId) };
    }
    default:
      throw new Error(
        `Unknown provider "${provider}". Try anthropic:<id>, openai:<id>, openrouter:<id>, openai-compatible:<id>.`,
      );
  }
};
