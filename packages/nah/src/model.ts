import type { LanguageModel } from "ai";
import { getStoredProviderKey } from "./credentials.js";

export const DEFAULT_MODEL_SPEC = "anthropic:claude-sonnet-4-5";

export type ResolvedModel = {
  spec: string;
  provider: string;
  modelId: string;
  model: LanguageModel;
  setStatusHandler: (handler?: (status: string | null) => void) => void;
};

const providerFetch = (provider: string) => {
  let onStatus: ((status: string | null) => void) | undefined;
  let failures = 0;
  let statusVersion = 0;
  const fetchWithStatus: typeof fetch = async (input, init) => {
    const attempt = failures + 1;
    const version = ++statusVersion;
    onStatus?.(attempt > 1 ? `${provider} retry ${attempt}…` : `connecting to ${provider}…`);
    const startedAt = Date.now();
    const slowTimer = setTimeout(() => {
      if (version === statusVersion) onStatus?.(`${provider} network slow · waiting for response`);
    }, 4_000);
    try {
      const response = await fetch(input, init);
      clearTimeout(slowTimer);
      const elapsed = Date.now() - startedAt;
      if (response.status === 429) {
        failures += 1;
        onStatus?.(`${provider} rate limited (429) · retrying`);
      } else if (response.status === 502 || response.status === 503 || response.status === 504) {
        failures += 1;
        onStatus?.(`${provider} high traffic (${response.status}) · retrying`);
      } else if (!response.ok) {
        failures = 0;
        onStatus?.(`${provider} returned ${response.status}`);
      } else {
        failures = 0;
        const connectedStatus = `${provider} connected · ${elapsed}ms`;
        onStatus?.(connectedStatus);
        const clearTimer = setTimeout(() => {
          if (version === statusVersion) onStatus?.(null);
        }, 1_200);
        clearTimer.unref?.();
      }
      return response;
    } catch (error) {
      clearTimeout(slowTimer);
      failures += 1;
      onStatus?.(`${provider} network error · retrying`);
      throw error;
    }
  };
  return {
    fetch: fetchWithStatus,
    setStatusHandler: (handler?: (status: string | null) => void) => { onStatus = handler; },
  };
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
      const apiKey = env.ANTHROPIC_API_KEY ?? await getStoredProviderKey("anthropic");
      if (!apiKey) {
        throw new Error("Anthropic credentials are not set; use /provider anthropic or set ANTHROPIC_API_KEY");
      }
      const transport = providerFetch("Anthropic");
      const { createAnthropic } = await import("@ai-sdk/anthropic");
      return { spec: raw, provider, modelId, model: createAnthropic({ apiKey, fetch: transport.fetch })(modelId), setStatusHandler: transport.setStatusHandler };
    }
    case "openai": {
      const apiKey = env.OPENAI_API_KEY ?? await getStoredProviderKey("openai");
      if (!apiKey) {
        throw new Error("OpenAI credentials are not set; use /provider openai or set OPENAI_API_KEY");
      }
      const transport = providerFetch("OpenAI");
      const { createOpenAI } = await import("@ai-sdk/openai");
      return { spec: raw, provider, modelId, model: createOpenAI({ apiKey, fetch: transport.fetch })(modelId), setStatusHandler: transport.setStatusHandler };
    }
    case "openrouter": {
      const apiKey = env.OPENROUTER_API_KEY
        ?? env.OPENAI_API_KEY
        ?? await getStoredProviderKey("openrouter")
        ?? await getStoredProviderKey("openai");
      if (!apiKey) {
        throw new Error("OpenRouter credentials are not set; use /provider openrouter or set OPENROUTER_API_KEY");
      }
      const transport = providerFetch("OpenRouter");
      const { createOpenAICompatible } = await import("@ai-sdk/openai-compatible");
      const oi = createOpenAICompatible({
        name: "openrouter",
        baseURL: env.OPENROUTER_BASE_URL ?? "https://openrouter.ai/api/v1",
        apiKey,
        // OpenRouter attributes requests to an app via these headers, which is
        // what makes usage show up against this app in their dashboard rather
        // than as anonymous traffic. See the HTTP-Referer / X-OpenRouter-Title
        // fields in their API reference. Overridable for forks and self-hosts.
        headers: {
          "X-Title": env.NAH_APP_NAME ?? "nah",
          "HTTP-Referer": env.NAH_APP_URL ?? "https://nah.astracollab.com",
        },
        fetch: transport.fetch,
      });
      return { spec: raw, provider, modelId, model: oi(modelId), setStatusHandler: transport.setStatusHandler };
    }
    case "openai-compatible": {
      const apiKey = env.NAH_API_KEY ?? env.OPENAI_COMPATIBLE_API_KEY;
      const baseURL = env.NAH_BASE_URL ?? env.OPENAI_COMPATIBLE_BASE_URL;
      if (!apiKey || !baseURL) {
        throw new Error(
          "openai-compatible needs NAH_API_KEY and NAH_BASE_URL (or OPENAI_COMPATIBLE_*)",
        );
      }
      const transport = providerFetch("Provider");
      const { createOpenAICompatible } = await import("@ai-sdk/openai-compatible");
      const oi = createOpenAICompatible({ name: "openai-compatible", baseURL, apiKey, fetch: transport.fetch });
      return { spec: raw, provider, modelId, model: oi(modelId), setStatusHandler: transport.setStatusHandler };
    }
    default:
      throw new Error(
        `Unknown provider "${provider}". Try anthropic:<id>, openai:<id>, openrouter:<id>, openai-compatible:<id>.`,
      );
  }
};
