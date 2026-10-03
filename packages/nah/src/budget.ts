/**
 * Optional per-turn spend ceiling.
 *
 * ## There is no ceiling by default
 *
 * This used to pick one automatically: $2 on a fresh session, scaling to $5 as the
 * transcript grew. Every turn in a real session then stopped at `$1.99 / $2.00`,
 * mid-task, with the work unfinished. Three separate things were wrong with it:
 *
 * - **It stopped working runs.** A turn that emits 68k output tokens costs about
 *   a dollar at Sonnet rates, and the agent was emitting that on ordinary tasks.
 *   The ceiling was inside the cost of doing the job.
 * - **It was scaled on a signal that was always zero.** The scaling keyed on the
 *   turn's starting context, which nothing ever wrote — `contextUsedTokens` sat
 *   at 0 for every turn — so the scaling never engaged and the $2 floor was the
 *   only number that ever applied. A fresh session and a session with 3.9M
 *   tokens of history got the same $2.
 * - **It was priced from invented numbers.** `ratesFor` falls back to assumed
 *   Sonnet rates for a model it does not recognise, and the model in question
 *   was an OpenRouter route the user may well pay nothing for. A ceiling
 *   computed from a guess will confidently stop real work.
 *
 * Long-running coding agents do not stop because a counter crossed a line. Claude
 * Code, opencode, and pi all run a turn until the task is done, the context window
 * is genuinely full, or the human interrupts. Those are the only bounds here now,
 * and they are the right ones: `maxContextTokens` is a real limit, `maxSteps` is
 * finite, and Ctrl-C is always available.
 *
 * A ceiling remains available for anyone who wants one — `/budget 5`, or
 * `NAH_TURN_SPEND_USD=5` — and it is opt-in because the cost of having it on by
 * default is a run that stops half-finished for no reason the user can see.
 *
 * ## What is still worth reporting
 *
 * Spend, and the cache hit rate it depends on. Both are diagnostics, and neither
 * can end a run: a display that only shows what has happened is not a ceiling.
 */
import type { ModelRates } from "not-another-harness";

/**
 * The ceiling for a turn, or 0 for none.
 *
 * 0 rather than `null` because the harness treats any non-positive budget as "no
 * budget", and because a number that cannot be mistaken for a real allowance is
 * harder to accidentally treat as one.
 *
 * Resolution is deliberately narrow: an explicit `/budget`, then the env var, then
 * nothing. There is no computed fallback, because every attempt to compute one
 * produced a number nobody chose.
 */
export const resolveTurnSpendUsd = (
  override?: number | null,
  env: NodeJS.ProcessEnv = process.env,
): number => {
  if (override != null && Number.isFinite(override) && override > 0) return override;
  const raw = env.NAH_TURN_SPEND_USD;
  if (raw) {
    const parsed = Number.parseFloat(raw);
    // A malformed value is ignored rather than guessed at. Falling back to some
    // automatic number here would reintroduce exactly the ceiling this removed.
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return 0;
};

/**
 * Projected cost of one more step at this context size, cache hit rate, and rates.
 *
 * Purely informational: what the next step is expected to cost, so the hit rate
 * has a number attached to it. Nothing acts on it.
 */
export const projectStepCostUsd = (
  contextTokens: number,
  hitRate: number,
  rates: ModelRates,
  outputTokens = 500,
): number => {
  const clamped = Math.min(1, Math.max(0, hitRate));
  const read = rates.cacheRead ?? rates.input * 0.1;
  const write = rates.cacheWrite ?? rates.input * 1.25;
  const cached = contextTokens * clamped;
  const created = contextTokens * (1 - clamped);
  return (
    (cached / 1_000_000) * read +
    (created / 1_000_000) * write +
    (outputTokens / 1_000_000) * rates.output
  );
};

/**
 * `$1.25`, or `$0.04` — small spend figures need more precision than large ones.
 *
 * Non-finite input reads as `$0` rather than throwing: this is called from the
 * sidebar's render path, which runs on every frame, and a malformed counter there
 * would take down the terminal over a cosmetic figure.
 */
export const formatUsd = (value: number): string => {
  if (!Number.isFinite(value)) return "$0";
  return value >= 10 ? `$${value.toFixed(0)}` : value >= 1 ? `$${value.toFixed(2)}` : `$${value.toFixed(3)}`;
};