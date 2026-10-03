/**
 * Step ceilings and the structured turn log.
 *
 * Ported from the Mastra agent. Both read a Mastra `generate` result —
 * `result.steps`, nested `toolCalls[].payload` — and both now read the harness's
 * typed `HarnessRunResult` instead, through `./run-shape.js`.
 */
import {
  executeCommandsFrom,
  summaryFrom,
  toolNamesFrom,
  usageSummary,
} from "./run-shape.js";

/** Env-configurable ceiling, clamped to a range that is deliberate rather than generous. */
export type StepCapOptions = {
  env?: Record<string, string | undefined>;
  variable?: string;
  fallback?: number;
  min?: number;
  max?: number;
};

export const resolveStepCap = (options: StepCapOptions = {}): number => {
  const fallback = options.fallback ?? 60;
  const min = options.min ?? 8;
  const max = options.max ?? 120;
  const raw = (options.env ?? process.env)[options.variable ?? "CODING_AGENT_MAX_STEPS"]?.trim();
  if (!raw) return fallback;
  const parsed = Number(raw);
  // A typo must not silently become an unbounded run and `Infinity` must not
  // become a hang, so anything unparseable falls back.
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(parsed)));
};

/**
 * The ceiling for an implement run.
 *
 * Lowered when the turn opens with a codebase profile, because the preamble has
 * already done the orientation work that steps would otherwise spend on it.
 */
export const resolveImplementStepCap = (options: {
  hasProfilePreamble?: boolean;
  env?: Record<string, string | undefined>;
}): number => {
  const base = resolveStepCap({ env: options.env });
  return options.hasProfilePreamble ? Math.min(base, 20) : base;
};

/** Whether the noisy per-turn log is switched on. Off unless asked for. */
export const turnLogEnabled = (env: Record<string, string | undefined> = process.env): boolean => {
  const raw = env.CODING_AGENT_TELEMETRY_LOG?.trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "on" || raw === "yes";
};

export type TurnLogInput = {
  workflow: string;
  mode: "scout" | "implement";
  result: Parameters<typeof usageSummary>[0] & {
    text: string;
    reason: string;
    steps: number;
    messages: unknown[];
  };
  /** Measured by the caller, because the harness does not time the whole turn. */
  durationMs?: number;
  enabled?: boolean;
  /** Overridable so a test can read what was logged. */
  sink?: (line: string, detail: unknown) => void;
};

/**
 * One structured line per turn.
 *
 * Every figure comes from `run-shape` rather than from a walk over the result,
 * which is the reason those helpers exist: the Mastra version recovered
 * information the run result already had, by digging through
 * `steps[].toolCalls[].payload`.
 */
export const logImplementTurn = (input: TurnLogInput): void => {
  if (input.enabled !== true) return;
  const result = input.result as never;
  const usage = usageSummary(result);
  const tools = toolNamesFrom(result);
  const commands = executeCommandsFrom(result);
  (input.sink ?? defaultSink)("[coding-agent] implement turn", {
    workflow: input.workflow,
    mode: input.mode,
    durationMs: input.durationMs,
    tools,
    // The count, not the commands: a transcript that echoes every shell command
    // into a log line is unreadable and the list is already in the trace.
    commandCount: commands.length,
    summaryChars: summaryFrom({ text: input.result.text }).length,
    ...usage,
  });
};

const defaultSink = (line: string, detail: unknown): void => {
  // eslint-disable-next-line no-console
  console.info(line, detail);
};