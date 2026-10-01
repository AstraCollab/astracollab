/**
 * Prompt caching.
 *
 * Every step re-sends the whole transcript, so the system prompt, the tool
 * definitions, and all earlier turns are re-billed on every call. Prompt caching
 * reads them back at roughly a tenth of the price, and it does so *without*
 * editing any message content — which matters, because editing a prior
 * `tool_result` invalidates the thinking-block signatures Anthropic binds to
 * that prefix.
 *
 * The cacheable prefix is therefore marked, never rewritten.
 */

export type CacheControl = { type: "ephemeral"; ttl?: "5m" | "1h" };

import type { SharedV2ProviderOptions } from "@ai-sdk/provider";

const ANTHROPIC_KEYS = new Set(["anthropic"]);

/**
 * Whether a provider honours Anthropic-style `cacheControl` breakpoints.
 *
 * OpenAI-compatible gateways differ, and marking a breakpoint somewhere that
 * ignores it is at best wasted work. Detection is deliberately conservative:
 * unknown providers get no caching rather than a broken request.
 */
export const supportsCaching = (provider: string | undefined): boolean => {
  if (!provider) return false;
  const name = provider.toLowerCase();
  if (ANTHROPIC_KEYS.has(name)) return true;
  // OpenRouter fronts Anthropic models and accepts the same headers.
  if (name === "openrouter") return true;
  return false;
};

/** Provider options for the request-level (system prompt) cache breakpoint. */
export const cacheOptions = (
  provider: string | undefined,
  ttl: "5m" | "1h" = "5m",
): SharedV2ProviderOptions | undefined => {
  if (!supportsCaching(provider)) return undefined;
  return { anthropic: { cacheControl: { type: "ephemeral", ttl } satisfies CacheControl } } as SharedV2ProviderOptions;
};

/**
 * Wrap a tool map so every tool definition carries its own cache breakpoint.
 *
 * Tool schemas are re-sent verbatim on each call and are large; caching them is
 * a straightforward saving and, being append-only, is safe.
 */
export const withCachedToolSchemas = <T extends Record<string, unknown>>(
  tools: T,
  provider: string | undefined,
  ttl: "5m" | "1h" = "5m",
): T => {
  if (!supportsCaching(provider) || Object.keys(tools).length === 0) return tools;
  const control: CacheControl = { type: "ephemeral", ttl };
  const out: Record<string, unknown> = {};
  for (const [name, tool] of Object.entries(tools)) {
    if (typeof tool !== "object" || tool === null) {
      out[name] = tool;
      continue;
    }
    const existing = (tool as { providerOptions?: Record<string, unknown> }).providerOptions;
    out[name] = {
      ...(tool as object),
      providerOptions: {
        ...(existing ?? {}),
        anthropic: {
          ...((existing?.anthropic as Record<string, unknown> | undefined) ?? {}),
          cacheControl: control,
        },
      },
    };
  }
  return out as T;
};

/**
 * Number of recent messages to leave breakpoint-free.
 *
 * Anthropic allows a small number of cache breakpoints per request. Two are
 * spent on the system prompt and tool definitions, leaving the transcript to
 * grow its own at the tail.
 */
export const TAIL_CACHE_BREAKPOINTS = 2;