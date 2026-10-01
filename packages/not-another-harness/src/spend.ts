/**
 * Cache-aware spend accounting.
 *
 * ## Why not count tokens
 *
 * A token is not a fixed cost. Under prompt caching the same token costs a
 * tenth of a price as a cache read, 1.25x as a fresh cache write, and 5x to 25x
 * less than an output token depending on the model. Accumulating raw token
 * counts therefore charges a well-cached run at roughly ten times its real cost,
 * which makes any budget expressed in tokens fire on *harness efficiency* rather
 * than on money.
 *
 * That is precisely how the old cumulative `maxTokens` cap came to behave as a
 * step counter: cost grew with the transcript, the transcript grew with every
 * step, and the budget was reached after a fixed number of steps regardless of
 * how little the run had actually cost.
 *
 * So spend is denominated in US dollars, computed from the cache-aware usage
 * breakdown. Rates are supplied per model rather than hardcoded here: they change
 * often, they differ per provider, and a stale table that silently over- or
 * under-charges is worse than no table at all.
 */

/** Per-million-token prices for one model. All figures in USD. */
export type ModelRates = {
  /** Fresh (uncached) input. */
  input: number;
  /** Generated output. */
  output: number;
  /** Reading a cached prefix. Defaults to `input * 0.1`. */
  cacheRead?: number;
  /** Writing a cached prefix at a 5m TTL. Defaults to `input * 1.25`. */
  cacheWrite?: number;
};

/** The cache-aware usage breakdown a spend figure is derived from. */
export type CacheAwareUsage = {
  inputTokens: number;
  outputTokens: number;
  /** Tokens served from cache. Reported separately by Anthropic. */
  cachedInputTokens?: number;
  /** Tokens written into cache by this request. */
  cacheCreationInputTokens?: number;
};

const perMillion = (tokens: number, rate: number): number => (tokens / 1_000_000) * rate;

/**
 * Dollar cost of one request's usage.
 *
 * Cache reads and cache writes are priced separately from fresh input because
 * they differ by more than an order of magnitude. Counting a cache read as a
 * fresh input token — the behaviour that made the token budget a step counter —
 * overstates a well-cached run by roughly 10x.
 */
export const usageCostUsd = (usage: CacheAwareUsage, rates: ModelRates): number => {
  const cacheRead = rates.cacheRead ?? rates.input * 0.1;
  const cacheWrite = rates.cacheWrite ?? rates.input * 1.25;
  return (
    perMillion(usage.inputTokens, rates.input) +
    perMillion(usage.cachedInputTokens ?? 0, cacheRead) +
    perMillion(usage.cacheCreationInputTokens ?? 0, cacheWrite) +
    perMillion(usage.outputTokens, rates.output)
  );
};

/** Running total of what a run has cost. */
export const createSpendMeter = (rates: ModelRates) => {
  let usd = 0;
  return {
    /** Record one request's usage and return the new running total. */
    charge(usage: CacheAwareUsage): number {
      usd += usageCostUsd(usage, rates);
      return usd;
    },
    /** Total spent so far. */
    total: (): number => usd,
  };
};
