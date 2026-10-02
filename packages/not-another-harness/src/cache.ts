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
 *
 * ## Breakpoints are a scarce resource
 *
 * Anthropic allows a small fixed number of cache breakpoints per request, and
 * the AI SDK enforces the cap by **silently discarding** any marker past it.
 * A discarded marker is not an error — it is a full-price re-bill on every step
 * of every run, forever.
 *
 * A breakpoint marks a *prefix*, not a block. Marking the last tool definition
 * therefore caches the entire tool block, and marking every tool says the same
 * thing N times while spending the budget that the transcript needed. The rules
 * below follow from that:
 *
 * - One breakpoint on the **last** tool, never one per tool.
 * - One request-level breakpoint, which Anthropic auto-places on the last
 *   cacheable block and moves forward as the conversation grows. That is the
 *   moving tail breakpoint, and it is the one that matters for a long run
 *   because the transcript is the only part that keeps growing.
 */

export type CacheControl = { type: "ephemeral"; ttl?: "5m" | "1h" };

import type { SharedV2ProviderOptions } from "@ai-sdk/provider";
import type { ModelMessage } from "ai";

const ANTHROPIC_KEYS = new Set(["anthropic"]);

/**
 * Total cache breakpoints a single request may carry.
 *
 * The AI SDK caps explicit markers at this number and warns rather than failing,
 * so exceeding it is silent. Kept here so the harness can reason about its own
 * footprint instead of discovering it from a billing report.
 */
export const MAX_CACHE_BREAKPOINTS = 4;

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
 * Mark the **last** tool definition with a cache breakpoint.
 *
 * A breakpoint marks a prefix that ends at that block, so the final tool
 * carries the whole tool schema block into the cache. Marking every tool
 * individually spends the provider's breakpoint budget to express one fact N
 * times — and because the cap is enforced by *silently discarding* the excess,
 * the tools that lose their marker are re-billed at full price on every step
 * with nothing in the logs to indicate it.
 *
 * An 11-tool session therefore marked 4 tools and silently re-billed the other
 * 7 on every request. One marker on the last tool covers all of them.
 */
export const withCachedToolSchemas = <T extends Record<string, unknown>>(
  tools: T,
  provider: string | undefined,
  ttl: "5m" | "1h" = "5m",
): T => {
  if (!supportsCaching(provider)) return tools;
  const names = Object.keys(tools);
  if (names.length === 0) return tools;
  const control: CacheControl = { type: "ephemeral", ttl };
  const out: Record<string, unknown> = { ...tools };
  const lastName = names[names.length - 1]!;
  const last = tools[lastName];
  if (typeof last !== "object" || last === null) return tools;
  const existing = (last as { providerOptions?: Record<string, unknown> }).providerOptions;
  out[lastName] = {
    ...(last as object),
    providerOptions: {
      ...(existing ?? {}),
      anthropic: {
        ...((existing?.anthropic as Record<string, unknown> | undefined) ?? {}),
        cacheControl: control,
      },
    },
  };
  return out as T;
};

/**
 * Breakpoints left for the transcript after the tools and system prompt.
 *
 * The tool block and the request-level breakpoint are committed first, so this
 * is what remains for the one part of the request that actually grows.
 */
export const TAIL_CACHE_BREAKPOINTS = 2;

/**
 * Mark the growing end of the transcript so it is read back, not re-billed.
 *
 * Every step re-sends the entire conversation, so without a breakpoint here the
 * dominant cost of a long run — replaying a transcript that grew by a few
 * thousand tokens each step — is paid at full price every time. With one, each
 * step reads back the prefix the previous step wrote.
 *
 * The marker has to *move*. Anthropic resolves a cache read by walking backward
 * from a breakpoint looking for a prefix a previous request wrote, and it only
 * looks back a fixed number of blocks. A breakpoint pinned to a fixed index in a
 * growing conversation eventually falls outside that window and stops matching —
 * no error, no warning, just a cache that silently stopped working.
 *
 * So the marker is placed on the message that was last present when the
 * previous request was sent. Everything up to it is byte-identical to what that
 * request wrote, which is exactly the condition a cache read requires.
 *
 * Only message-level options are touched. Content is never altered, so thinking
 * signatures bound to the prefix stay valid.
 */
export const withCachedTail = (
  messages: readonly ModelMessage[],
  stableThrough: number,
  provider: string | undefined,
  ttl: "5m" | "1h" = "5m",
): ModelMessage[] => {
  if (!supportsCaching(provider)) return [...messages];
  // Nothing new since the last request: the prefix is unchanged, so there is no
  // new entry to write and nothing to gain from marking it again.
  const index = Math.min(Math.max(0, Math.floor(stableThrough)), messages.length - 1);
  if (index < 0) return [...messages];
  const target = messages[index];
  if (!target) return [...messages];
  const control: CacheControl = { type: "ephemeral", ttl };
  const existing = (target as { providerOptions?: Record<string, unknown> }).providerOptions;
  return [
    ...messages.slice(0, index),
    {
      ...target,
      providerOptions: {
        ...(existing ?? {}),
        anthropic: {
          ...((existing?.anthropic as Record<string, unknown> | undefined) ?? {}),
          cacheControl: control,
        },
      },
    } as ModelMessage,
    ...messages.slice(index + 1),
  ];
};

/**
 * Whether a provider's `inputTokens` already includes the cached portion.
 *
 * - `"split"` — Anthropic. `input_tokens` counts only what came *after* the last
 *   cache breakpoint; the cached prefix is reported separately as
 *   `cache_read_input_tokens`, so the two must be added to get the real size.
 * - `"inclusive"` — OpenAI and OpenAI-compatible gateways, OpenRouter included.
 *   `prompt_tokens` already contains `cached_tokens`, so adding them counts the
 *   cached prefix twice.
 *
 * Getting this wrong is not a rounding error. On a run with a 90% hit rate the
 * split formula reports roughly 10x the true context size, which then drives
 * compaction and the spend rail off a number that was never real.
 *
 * @deprecated v7 normalises cache accounting, so the distinction no longer
 * exists. The type is kept only so existing callers still compile.
 */
export type CacheAccounting = "split" | "inclusive";

/**
 * Which accounting convention `provider` uses.
 *
 * **Deprecated on AI SDK v7, and no longer consulted.** It existed because the
 * SDK reported `input_tokens` two different ways depending on the provider —
 * Anthropic excluded the cached prefix, OpenAI-compatible gateways included it —
 * so a harness that summed the pieces had to know which it was looking at, and a
 * wrong guess inflated every size figure it reported by up to 10x.
 *
 * v7 removes the ambiguity rather than moving it: `inputTokens` is always the
 * whole prompt and `inputTokenDetails` always breaks out `noCache`,
 * `cacheRead`, and `cacheWrite`. There is nothing left to infer.
 *
 * Kept exported so existing callers still compile, and because the provider list
 * is the kind of thing worth having on record. It no longer affects any figure
 * the harness reports.
 *
 * @deprecated v7 normalises cache accounting; this is inert.
 */
export const cacheAccountingFor = (provider: string | undefined): CacheAccounting => {
  void provider;
  return "inclusive";
};

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