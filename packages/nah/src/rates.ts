import type { ModelRates } from "not-another-harness";

/**
 * Per-million-token prices used to turn usage into the `maxSpendUsd` figure.
 *
 * ## These go stale
 *
 * Prices change, they differ per provider, and OpenRouter fronts several models
 * at its own markup. So they live here, in one obvious place, rather than being
 * buried in the harness — and `NAH_RATES` can override them without a release:
 *
 *   NAH_RATES='{"input":3,"output":15}' nah
 *
 * Cache multipliers follow Anthropic's published figures: a read is 0.1x base
 * input, and a write is 2x for the 1h TTL this harness uses (1.25x for 5m).
 *
 * A wrong figure is not catastrophic — it scales the rail rather than breaking
 * it — but a stale one makes `maxSpendUsd` mean something slightly other than
 * what it says. Check these against the provider's pricing page when the number
 * in `/stats` looks wrong.
 */
const TABLE: Array<{ match: RegExp; rates: ModelRates }> = [
  // Opus 4.x: $5 / $25 base.
  { match: /opus-?4/i, rates: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 10 } },
  // Sonnet 4.x: $3 / $15 base.
  { match: /sonnet-?4/i, rates: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 6 } },
  // Haiku 4.x: $1 / $5 base.
  { match: /haiku-?4/i, rates: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 2 } },
  // Sonnet 5.x: $2 / $10 base.
  { match: /sonnet/i, rates: { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 4 } },
];

/**
 * A model missing from the table has no rates, and that is the whole point.
 *
 * This used to fall back to Sonnet's rates — the middle of the Claude range —
 * for anything unrecognised, and both `gpt-5` and `stealth/space-bunny-alpha`
 * matched nothing here. So a free route was accounted as though it cost $3/M in
 * and $15/M out: `/stats` printed a confident dollar figure for a model the user
 * pays nothing for, and `maxSpendUsd` sized a budget on it. Because every turn
 * re-sends the whole transcript, the figure also grew turn after turn, which
 * made the guess read more like a meter the longer the session ran.
 *
 * A guess presented as a measurement is worse than no figure at all, so the
 * fallback is gone. Unrecognised means `null` — no dollar rail, so spend stays at
 * zero instead of inventing money. `NAH_RATES` is how a real figure gets
 * supplied, including `NAH_RATES='{"input":0,"output":0}'` to state outright that
 * a model is free.
 */

/** Zero in and zero out: a route the provider does not charge for. */
const isFree = (rates: ModelRates): boolean => rates.input === 0 && rates.output === 0;

export type RateLookup = {
  /** Rates to bill against, or null when the model cannot be priced. */
  rates: ModelRates | null;
  /**
   * Where the figures came from, so a display can say whether it is measuring or
   * repeating a default. `free` is a measurement — the model genuinely costs
   * nothing — and `unknown` is the absence of one.
   */
  source: "env" | "table" | "free" | "unknown";
};

const fromEnv = (env: NodeJS.ProcessEnv): ModelRates | null => {
  const raw = env.NAH_RATES;
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<ModelRates>;
    if (typeof parsed.input === "number" && typeof parsed.output === "number") {
      // Cache multipliers come off the *supplied* input rate rather than a
      // default table. Spreading a default in meant `{"input":0,"output":0}` —
      // the way to declare a model free — still billed cache reads and writes,
      // so "free" was not free.
      return {
        input: parsed.input,
        output: parsed.output,
        cacheRead: typeof parsed.cacheRead === "number" ? parsed.cacheRead : parsed.input * 0.1,
        cacheWrite: typeof parsed.cacheWrite === "number" ? parsed.cacheWrite : parsed.input * 2,
      };
    }
  } catch {
    // Fall through to the table rather than failing startup over a bad env var.
  }
  return null;
};

/**
 * Prices for `modelId`, from `NAH_RATES` if set, else the table, else nothing.
 *
 * Use `ratesFor` when you need the numbers to bill against and `lookupRates`
 * when the provenance matters — a UI showing dollars needs to know whether it is
 * reporting a measurement or the absence of one.
 */
export const lookupRates = (modelId: string, env: NodeJS.ProcessEnv = process.env): RateLookup => {
  const override = fromEnv(env);
  if (override) return { rates: override, source: isFree(override) ? "free" : "env" };
  const matched = TABLE.find((entry) => entry.match.test(modelId));
  if (matched) return { rates: matched.rates, source: isFree(matched.rates) ? "free" : "table" };
  return { rates: null, source: "unknown" };
};

/**
 * Just the rates, or null when the model cannot be priced.
 *
 * Null used to be a number borrowed from a different model, which is what put
 * invented dollars on a free route. Callers now have to decide what an unpriced
 * model means for them, and no dollar rail at all is the honest reading. A
 * display that wants to say *why* it is showing nothing should use
 * `lookupRates` and read `source`.
 */
export const ratesFor = (modelId: string, env: NodeJS.ProcessEnv = process.env): ModelRates | null =>
  lookupRates(modelId, env).rates;