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

/**
 * Statuses worth repeating.
 *
 * Every one of these is a response the model never got to answer on, so a
 * repeat is a fresh request rather than a duplicate of work already billed —
 * the body has not been read at this point in the loop. 401/403/404/422 are
 * deliberately absent: they are the caller's problem, and repeating them only
 * spends the backoff before failing the same way.
 */
const RETRYABLE_STATUS = new Set([408, 429, 502, 503, 504]);

/** One call plus two repeats. */
const MAX_ATTEMPTS = 3;
const BASE_BACKOFF_MS = 500;
const MAX_BACKOFF_MS = 8_000;

/**
 * A server may ask for a longer wait than the backoff curve would pick — most
 * often a 429 carrying `Retry-After`. Honour it, but bounded: an unbounded
 * honour would let one response park the run for as long as it liked.
 */
const MAX_RETRY_AFTER_MS = 30_000;

/**
 * Exported for tests: the retry policy is the part of this module with real
 * branching, and reaching it through a live provider would mean asserting on
 * network timing.
 */
export const providerFetch = (provider: string) => {
  let onStatus: ((status: string | null) => void) | undefined;
  let statusVersion = 0;
  /**
   * `retry-after` in either of its two forms: delta-seconds, or an HTTP date.
   */
  const retryAfterMs = (response: Response): number | undefined => {
    const header = response.headers.get("retry-after");
    if (header == null) return undefined;
    const seconds = Number(header);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1_000, MAX_RETRY_AFTER_MS);
    const at = Date.parse(header);
    if (Number.isNaN(at)) return undefined;
    return Math.min(Math.max(at - Date.now(), 0), MAX_RETRY_AFTER_MS);
  };
  /**
   * A backoff that ends early when the run is aborted, so a cancel during the
   * wait does not have to sit out the remaining sleep.
   */
  const sleep = (ms: number, signal: AbortSignal | undefined): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      const onAbort = (): void => {
        clearTimeout(timer);
        reject(signal?.reason ?? new Error("aborted"));
      };
      const timer = setTimeout(() => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
      if (signal?.aborted) onAbort();
      else signal?.addEventListener("abort", onAbort, { once: true });
    });

  const fetchWithStatus: typeof fetch = async (input, init) => {
    /**
     * One version for the whole call including its repeats, so the "connected"
     * clear timer belongs to this logical request and a newer request that
     * started meanwhile is not silenced by it.
     */
    const version = ++statusVersion;
    const signal = init?.signal ?? undefined;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      onStatus?.(
        attempt > 1 ? `${provider} retry ${attempt}/${MAX_ATTEMPTS}…` : `connecting to ${provider}…`,
      );
      const startedAt = Date.now();
      const slowTimer = setTimeout(() => {
        if (version === statusVersion) onStatus?.(`${provider} network slow · waiting for response`);
      }, 4_000);

      let response: Response;
      try {
        response = await fetch(input, init);
      } catch (error) {
        clearTimeout(slowTimer);
        /**
         * A cancelled run is a decision, not a fault — repeating it would
         * resurrect a request the caller already gave up on.
         */
        if (signal?.aborted) {
          onStatus?.(null);
          throw error;
        }
        if (attempt === MAX_ATTEMPTS) {
          onStatus?.(`${provider} network error`);
          throw error;
        }
        onStatus?.(`${provider} network error · retrying`);
        await sleep(Math.min(BASE_BACKOFF_MS * 2 ** (attempt - 1), MAX_BACKOFF_MS), signal);
        continue;
      }
      clearTimeout(slowTimer);

      const elapsed = Date.now() - startedAt;
      if (response.ok) {
        onStatus?.(`${provider} connected · ${elapsed}ms`);
        const clearTimer = setTimeout(() => {
          if (version === statusVersion) onStatus?.(null);
        }, 1_200);
        clearTimer.unref?.();
        return response;
      }

      if (!RETRYABLE_STATUS.has(response.status) || attempt === MAX_ATTEMPTS) {
        onStatus?.(
          RETRYABLE_STATUS.has(response.status)
            ? `${provider} still failing (${response.status}) · giving up`
            : `${provider} returned ${response.status}`,
        );
        return response;
      }

      onStatus?.(
        response.status === 429
          ? `${provider} rate limited (429) · retrying`
          : `${provider} high traffic (${response.status}) · retrying`,
      );
      const wait =
        retryAfterMs(response) ?? Math.min(BASE_BACKOFF_MS * 2 ** (attempt - 1), MAX_BACKOFF_MS);
      /**
       * Drain the body before waiting. A response left unread holds its socket
       * — and under a keep-alive agent its connection slot — for the whole
       * backoff, which is precisely the pressure we are backing off from.
       */
      await response.body?.cancel().catch(() => {});
      await sleep(wait, signal);
    }
    throw new Error(`${provider} exhausted ${MAX_ATTEMPTS} attempts`);
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
