/**
 * Per-turn spend budgets, scaled to the task rather than fixed.
 *
 * ## Why a flat ceiling was wrong
 *
 * `NAH_TURN_SPEND_USD` defaulted to $5 for every turn regardless of what the turn
 * was doing. Two runs of the same read-only "explain this codebase" cost $0.11
 * and $0.15 against that $5 — roughly 35x of headroom that was never touched, on
 * a turn whose entire output was one markdown document.
 *
 * A ceiling that never binds is not a safety rail, it is decoration. Worse, the
 * number was invisible: nothing in the UI showed a budget, so when a rail *did*
 * fire the stop looked arbitrary.
 *
 * ## What the budget is actually paying for
 *
 * Every step re-sends the transcript, so a turn's cost is dominated by how much
 * context it carries and how many steps it takes — not by how much the model
 * writes. That makes context size the one signal available at turn start that
 * actually predicts cost, and it points the opposite way from a flat number: the
 * sessions that most need budget are the ones resuming a large transcript.
 *
 * The old default gave the *freshest* session the largest envelope and the
 * biggest one a merely adequate one.
 *
 * ## What this is not
 *
 * Not a cap on model intelligence or a per-task allowance — the harness cannot
 * know a task's difficulty, and guessing from the prompt text would be brittle.
 * It is a runaway guard sized by the dominant cost driver, with the real number
 * on screen and a way to change it. Raising it is always one command away.
 */
import type { ModelRates } from "@astracollab/not-another-harness";

/** Never less than this, however small the context. */
const FLOOR_USD = 2;
/** Never more than this, however large the context. */
const CEILING_USD = 5;
/**
 * Marginal dollars per context token, chosen so the rail reaches the historical
 * $5 ceiling at a full 180k transcript.
 */
const PER_CONTEXT_TOKEN_USD = 1.7e-5;

/**
 * Spend rail for a turn starting from `contextTokens` of existing transcript.
 *
 * $2 on an empty session — still ~13x a read-only explanation, but no longer an
 * unreachable $5 — rising to $5 once a turn is carrying a full window, where the
 * per-step resend genuinely is expensive.
 */
export const defaultTurnSpendUsd = (contextTokens: number): number => {
  const scaled = FLOOR_USD + Math.max(0, contextTokens) * PER_CONTEXT_TOKEN_USD;
  return Math.min(CEILING_USD, Math.max(FLOOR_USD, scaled));
};

/**
 * Resolve the rail for a turn: an explicit override wins, otherwise the
 * context-scaled default.
 *
 * `NAH_TURN_SPEND_USD` stays supported so an existing setup keeps working, and so
 * there is an escape hatch without a slash command — but it now has to be asked
 * for rather than inherited.
 */
export const resolveTurnSpendUsd = (
  contextTokens: number,
  override?: number | null,
  env: NodeJS.ProcessEnv = process.env,
): number => {
  if (override != null && Number.isFinite(override) && override > 0) return override;
  const raw = env.NAH_TURN_SPEND_USD;
  if (raw) {
    const parsed = Number.parseFloat(raw);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return defaultTurnSpendUsd(contextTokens);
};

/**
 * Projected cost of one more step at this context size, cache hit rate, and rates.
 *
 * Used by `/budget` to show what the rail actually buys, so the number is not an
 * abstraction. At a 90% hit rate this is roughly an order of magnitude below the
 * same step uncached, which is the whole argument for watching the hit rate.
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
