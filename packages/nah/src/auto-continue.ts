/**
 * Keeping a turn going when the model stops with the work unfinished.
 *
 * ## The failure this exists for
 *
 * A step that ends with no tool calls is a final answer, and the harness reports
 * it as one — the run is `completed` and control goes back to the prompt. For a
 * long-running coding agent that is the most common way a working run dies: the
 * model narrates its next move ("Now let me update the API routes…"), emits no
 * call for it, and the loop winds up over a task that is visibly half done. The
 * only thing between that and a finished task is the human typing "please
 * continue", which is a thing an agent should not need.
 *
 * So the stop is checked against the one piece of state that knows whether the
 * work is finished: the task ledger. A ledger with open steps and unpassed
 * checks means the run stopped early, whatever the model said.
 *
 * ## What counts as "still working"
 *
 * Not "the model said it was done" — a model says that mid-task — and not a
 * step count, which cannot tell a long task from a loop. The signal is whether
 * the model is *acting*: a step that used a tool is work, and a step that only
 * produced prose is the model talking instead of doing. A run that keeps
 * working keeps its continuation; a run that answers in prose again after being
 * told to continue has stopped, and the honest thing is to let it.
 *
 * That is the whole circle detector, and it is a real one: the pattern it
 * refuses is exactly "stops, is told to continue, stops again without having
 * done anything" — a run going in circles rather than a run going in circles in
 * some subtler way. The harness's own guards cover the subtler cases (repeated
 * identical calls, results the run has already seen), and they keep counting
 * across continuations because a continuation is the same run.
 *
 * ## What is deliberately not here
 *
 * No ledger, no continuation. The ledger is the only durable statement of what
 * is left; without one there is nothing to check a stop against, and inventing
 * a rule from the shape of the model's last sentence would be guessing at the
 * difference between "here is your answer" and "here is my next move".
 */
import type { SessionTaskLedger, ShouldContinue } from "not-another-harness";

/**
 * The work a ledger still holds, or null when it holds none.
 *
 * Null rather than a zero count, because "nothing left" and "no ledger" are
 * different answers and only one of them is a reason to keep going.
 */
export type OpenLedgerWork = {
  /** Steps that are pending or in progress. */
  steps: number;
  /** Acceptance checks that have not passed. */
  checks: number;
};

export const openLedgerWork = (
  ledger: SessionTaskLedger | null | undefined,
): OpenLedgerWork | null => {
  if (!ledger) return null;
  // `blocked` is the model's own statement that it cannot proceed, and
  // `completed` is a finished plan. Neither is a reason to talk it back into
  // working.
  if (ledger.status !== "in_progress") return null;
  const steps = ledger.steps.filter(
    (step) => step.status === "pending" || step.status === "in_progress",
  ).length;
  const checks = ledger.checks.filter((check) => check.status !== "passed").length;
  if (steps === 0 && checks === 0) return null;
  return { steps, checks };
};

/**
 * What the continuation gate remembers between stops.
 *
 * Held per run rather than per session: the question the gate answers is "did
 * anything happen since the last time this run stopped", and that is a question
 * about this run.
 */
export type ContinuationState = {
  /**
   * Tool-calling steps seen so far.
   *
   * The harness reports one entry per step that used a tool, so the difference
   * between this and the count at the last stop is exactly the number of steps
   * in which the model did something.
   */
  toolSteps: number;
  /**
   * Whether a stop was declined because the model was not acting.
   *
   * Kept so the run can say why it ended with the plan open, rather than
   * leaving a transcript that stops mid-task with no explanation.
   */
  declined: boolean;
};

export const createContinuationState = (): ContinuationState => ({
  toolSteps: 0,
  declined: false,
});

/**
 * The hook the harness asks before it reports a run as finished.
 *
 * `ledger` is read on every call rather than captured, because the model
 * updates the ledger *during* the run — the whole point is to notice that it
 * has not.
 */
export const createLedgerContinuation = (options: {
  ledger: () => SessionTaskLedger | null;
  state: ContinuationState;
}): ShouldContinue => ({ steps }) => {
  if (!openLedgerWork(options.ledger())) return false;
  if (steps.length > options.state.toolSteps) {
    options.state.toolSteps = steps.length;
    return true;
  }
  options.state.declined = true;
  return false;
};

/**
 * The line a UI must show when a run stopped with the plan still open.
 *
 * Null when there is nothing to report: a run that was never continued was a
 * model answering a question, and saying "the plan is still open" about that
 * reads as a complaint about a question that was answered.
 *
 * Only for a run that ended as a completion. A run that a rail stopped — the
 * context window, the spend ceiling — has a reason of its own, and this notice
 * would explain it wrongly.
 */
export const continuationStopNotice = (options: {
  continuations: number;
  declined: boolean;
  work: OpenLedgerWork | null;
  completed: boolean;
}): string | null => {
  if (!options.completed) return null;
  if (options.continuations === 0) return null;
  if (!options.declined || !options.work) return null;
  const { steps, checks } = options.work;
  const parts = [
    steps > 0 ? `${steps} step${steps === 1 ? "" : "s"}` : null,
    checks > 0 ? `${checks} acceptance check${checks === 1 ? "" : "s"}` : null,
  ].filter((part): part is string => part !== null);
  return (
    `Stopped with the plan unfinished — ${parts.join(" and ")} still open. ` +
    `The model answered in prose instead of working, so auto-continue let it stop. ` +
    `Send a message to resume.`
  );
};
