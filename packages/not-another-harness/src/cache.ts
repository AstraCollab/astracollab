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

/**
 * Tools whose results stay resident.
 *
 * The agent needs to remember what it read and what it changed in order to work
 * sensibly, so those are pinned. The bulky, reproducible output is what gets
 * cleared: directory listings, greps, and command output can all be re-fetched.
 */
export const DEFAULT_PINNED_TOOLS = ["read", "edit", "write"] as const;

export type ContextEditingOptions = {
  /** Input-token size that triggers clearing. */
  triggerTokens?: number;
  /** How many recent tool use/result pairs to keep intact. */
  keepToolUses?: number;
  /** Never clear these tools' results. */
  excludeTools?: readonly string[];
};

/**
 * Ask the API to clear old tool results server-side.
 *
 * This is the safe version of transcript pruning. The API replaces each cleared
 * result with placeholder text and — crucially — does *not* treat the edit as a
 * client edit, so the thinking-block signatures bound to the prefix stay valid.
 * Doing the same thing client-side is what Anthropic documents as invalid for
 * every later thinking block.
 *
 * The default trigger is deliberately far below the API's own 100k default. A
 * measured run spent 383k input tokens across 22 steps while no single request
 * exceeded roughly 35k, so a 100k trigger would never have fired and the cost
 * would be entirely the repeated replay of a transcript that never looked big
 * enough to compact.
 */
export const contextManagementOptions = (
  provider: string | undefined,
  options: ContextEditingOptions = {},
): Record<string, Record<string, unknown>> | undefined => {
  if (!supportsCaching(provider)) return undefined;
  const excludeTools = options.excludeTools ?? DEFAULT_PINNED_TOOLS;
  return {
    anthropic: {
      contextManagement: {
        edits: [
          {
            type: "clear_tool_uses_20250919",
            trigger: { type: "input_tokens", value: options.triggerTokens ?? 40_000 },
            keep: { type: "tool_uses", value: options.keepToolUses ?? 6 },
            // Results only; the tool_use inputs stay visible so the model still
            // remembers what it asked for.
            clearToolInputs: false,
            ...(excludeTools.length > 0 ? { excludeTools: [...excludeTools] } : {}),
          },
        ],
      },
      anthropicBeta: ["context-management-2025-06-27"],
    },
  } as Record<string, Record<string, unknown>>;
};