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
 * Assumed rates for a model the table does not recognise, and when they apply.
 *
 * Sonnet's rates, because they are the middle of the Claude range. That is a
 * guess, and a guess presented as a measurement is worse than no guess at all:
 * `gpt-5` and `stealth/space-bunny-alpha` both matched nothing here, so a free
 * route was accounted as though it cost $3/M in and $15/M out. `/stats` then
 * showed a confident dollar figure for a model the user pays nothing for, and
 * `maxSpendUsd` sized a budget on it.
 *
 * So the assumption is reported rather than hidden. `NAH_RATES` is the way to
 * replace it with a real figure; `null` rates mean no dollar rail at all, which
 * is the honest state for a model we cannot price.
 */
const ASSUMED: ModelRates = { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 6 };

export type RateLookup = {
  /** Rates to bill against, or null when the model cannot be priced. */
  rates: ModelRates | null;
  /** Where the figures came from, so a display can say "assumed". */
  source: "env" | "table" | "assumed" | "unknown";
};

const fromEnv = (env: NodeJS.ProcessEnv): ModelRates | null => {
  const raw = env.NAH_RATES;
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<ModelRates>;
    if (typeof parsed.input === "number" && typeof parsed.output === "number") {
      return { ...ASSUMED, ...parsed };
    }
  } catch {
    // Fall through to the table rather than failing startup over a bad env var.
  }
  return null;
};

/**
 * Prices for `modelId`, from `NAH_RATES` if set, else the table, else an
 * explicitly-labelled assumption.
 *
 * Use `ratesFor` for the number and `lookupRates` when the provenance matters -
 * a UI showing dollars needs to know whether they are measured or guessed.
 */
export const lookupRates = (modelId: string, env: NodeJS.ProcessEnv = process.env): RateLookup => {
  const override = fromEnv(env);
  if (override) return { rates: override, source: "env" };
  const matched = TABLE.find((entry) => entry.match.test(modelId));
  if (matched) return { rates: matched.rates, source: "table" };
  return { rates: ASSUMED, source: "assumed" };
};

/**
 * Just the rates, for callers that do not care where they came from.
 *
 * Deliberately still returns a number for an unrecognised model, so existing
 * callers keep working. A display that shows money should use `lookupRates`
 * instead and check `source` before presenting the figure as measured.
 */
export const ratesFor = (modelId: string, env: NodeJS.ProcessEnv = process.env): ModelRates =>
  lookupRates(modelId, env).rates ?? ASSUMED;
