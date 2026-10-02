/**
 * Test fixtures for the AI SDK's provider-level types.
 *
 * The shape of `usage` changed in a way that a mechanical rename cannot absorb:
 * on v5 it was three flat numbers, and on v7 the prompt is broken out into
 * `total` / `noCache` / `cacheRead` / `cacheWrite`. A test that says
 * `{ inputTokens: 10 }` now means "inputTokens is a number", which is wrong at
 * every level — so fixtures are built here instead, where the new shape is
 * written once and a mismatch is one error instead of thirty.
 */
import type { LanguageModelV4FinishReason, LanguageModelV4Usage } from "@ai-sdk/provider";

export interface UsageInput {
  /** Prompt tokens in total, cache included — what a provider reports. */
  readonly input?: number;
  readonly output?: number;
  /** Of the prompt, how much was served from cache. */
  readonly cacheRead?: number;
  /** Of the prompt, how much was written to cache on this request. */
  readonly cacheWrite?: number;
  readonly reasoning?: number;
}

/**
 * A complete `LanguageModelV4Usage`.
 *
 * `noCache` is derived rather than accepted, because a fixture that sets a total
 * and a cacheRead while leaving the uncached part at zero describes a request
 * that cannot happen — and the whole point of these tests is that the harness
 * adds the pieces back up correctly.
 */
export const v4Usage = ({
  input = 0,
  output = 0,
  cacheRead = 0,
  cacheWrite = 0,
  reasoning = 0,
}: UsageInput = {}): LanguageModelV4Usage => ({
  inputTokens: {
    total: input,
    noCache: Math.max(0, input - cacheRead - cacheWrite),
    cacheRead,
    cacheWrite
  },
  outputTokens: {
    total: output,
    text: Math.max(0, output - reasoning),
    reasoning
  }
});

/**
 * A `finishReason` in the shape the provider now emits.
 *
 * In v5 this was the bare string `"stop"`. In v7 it is an object pairing a
 * normalised `unified` reason with whatever the provider actually said, so a
 * fixture written as a string is not merely untyped — it describes the old
 * protocol. Built here so the shape is written once.
 */
export const finishReason = (
  unified: "stop" | "length" | "content-filter" | "tool-calls" | "error" | "other",
  raw?: string,
): LanguageModelV4FinishReason => ({ unified, raw });
