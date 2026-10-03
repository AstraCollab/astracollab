/**
 * Coding-agent anti-loop rules.
 *
 * ## What these are for
 *
 * The harness's own guards measure generic things: steps, spend, whether anything
 * changed. They cannot see what a *coding* agent does when it is lost — verifying
 * git over and over after it has already edited, calling tools that do not exist,
 * repeating the same validation failure, restating "I'm done". Those are domain
 * knowledge, and they live here rather than in the harness for the same reason the
 * input sanitisers do: they are facts about this agent, not about agents.
 *
 * Wired through `runAgent`'s `shouldStop`, so a rule fires at the step boundary and
 * reports as `stopped-by-caller` rather than being relabelled as a step ceiling.
 *
 * ## The port
 *
 * The original read a Mastra `generate` result: `steps[].toolCalls[].payload` for
 * what a step called, `steps[].toolResults[]` for whether it failed, `steps[].text`
 * for what it said. Here a step is derived from the harness's `messages` — assistant
 * `tool-call` parts paired with the `tool` messages that answer them — which is
 * typed, so the `payload`/`args`/`input` guessing is gone rather than ported.
 */
import type { ModelMessage } from "ai";

import { toolNamesFrom, wroteFiles } from "./run-shape.js";

/* ------------------------------------------------------------------ streaks */

const DEFAULT_GIT_VERIFY_STREAK = 2;
const FAST_PATH_GIT_VERIFY_STREAK = 1;
const DEFAULT_HALLUCINATED_TOOL_STREAK = 2;
const DEFAULT_VALIDATION_FAILURE_STREAK = 2;

export type StreakOptions = {
  env?: Record<string, string | undefined>;
  /** Tighten the bound. Clamped so a typo cannot disable a guard. */
  min?: number;
  max?: number;
  fallback: number;
  variable: string;
};

const resolveStreak = (options: StreakOptions): number => {
  const raw = (options.env ?? process.env)[options.variable]?.trim();
  if (!raw) return options.fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return options.fallback;
  return Math.min(options.max ?? 6, Math.max(options.min ?? 1, Math.floor(parsed)));
};

export const resolveGitVerifyStreak = (options: { implementFastPath?: boolean; env?: Record<string, string | undefined> } = {}): number =>
  options.implementFastPath === true
    ? FAST_PATH_GIT_VERIFY_STREAK
    : resolveStreak({ variable: "TICKET_CODING_STOP_GIT_VERIFY_STREAK", fallback: DEFAULT_GIT_VERIFY_STREAK, max: 6, env: options.env });

export const resolveHallucinatedToolStreak = (options: { env?: Record<string, string | undefined> } = {}): number =>
  resolveStreak({ variable: "TICKET_CODING_STOP_HALLUCINATED_TOOL_STREAK", fallback: DEFAULT_HALLUCINATED_TOOL_STREAK, max: 4, env: options.env });

export const resolveValidationFailureStreak = (options: { env?: Record<string, string | undefined> } = {}): number =>
  resolveStreak({ variable: "TICKET_CODING_STOP_VALIDATION_FAILURE_STREAK", fallback: DEFAULT_VALIDATION_FAILURE_STREAK, max: 4, env: options.env });

/* -------------------------------------------------------------- predicates */

/**
 * Tool names the agent has invented.
 *
 * The bare workspace verbs are here because Mastra registered them as
 * `mastra_workspace_read_file` and a model that remembered that name called it
 * directly, getting a "tool not found" that cost a step. Anything matching the
 * `mastra_workspace_` prefix counts for the same reason.
 */
const HALLUCINATED_TOOL_NAMES = new Set([
  "end",
  "task_complete",
  "task_check",
  "updateWorkingMemory",
  "read_file",
  "write_file",
  "list_files",
  "execute_command",
]);

export const isHallucinatedToolName = (toolName: string): boolean => {
  const name = toolName.trim();
  if (name.length === 0) return false;
  if (HALLUCINATED_TOOL_NAMES.has(name)) return true;
  return /^mastra_workspace_/i.test(name);
};

const GIT_VERIFY_COMMAND_RE =
  /\b(git\s+(status|diff|log|show|rev-parse|branch)|git\s+-\S+\s+(status|diff|log)|npm\s+test|pnpm\s+(test|lint|typecheck)|tsc\b|yarn\s+test|vitest|pytest)\b/i;

export const isGitVerificationCommand = (command: string): boolean => {
  const trimmed = command.trim();
  return trimmed.length > 0 && GIT_VERIFY_COMMAND_RE.test(trimmed);
};

const WRITE_TOOLS = ["write", "write_file", "edit", "edit_file", "apply_patch"];
const COMMAND_TOOLS = ["bash", "execute_command"];

type Part = Record<string, unknown>;

const partsOf = (message: ModelMessage): Part[] =>
  Array.isArray(message.content) ? (message.content as unknown as Part[]) : [];

/** One reconstructed step: what it called, what it was told, and what it said. */
export type ReconstructedStep = {
  step: number;
  toolNames: string[];
  /** Command strings, for the git-verify rule. */
  commands: string[];
  /** Paths written or edited. */
  writtenPaths: string[];
  /** Tool results that reported an error, as text. */
  errors: string[];
  text: string;
  mutated: boolean;
};

/**
 * Rebuild steps from the transcript.
 *
 * The harness hands over `messages`, not a step list, so this pairs assistant
 * `tool-call` parts with the `tool` messages answering them. Pairing is by
 * `toolCallId` rather than by position, because a step's tool calls can be
 * interleaved with steering.
 */
export const reconstructSteps = (messages: readonly ModelMessage[]): ReconstructedStep[] => {
  const steps: ReconstructedStep[] = [];
  let current: ReconstructedStep | undefined;

  for (const message of messages) {
    if (message.role === "assistant") {
      const parts = partsOf(message);
      const text = parts
        .filter((part) => part.type === "text")
        .map((part) => String(part.text ?? ""))
        .join("\n");
      const calls = parts.filter((part) => part.type === "tool-call");
      if (calls.length === 0 && text.length === 0) continue;
      current = {
        step: steps.length + 1,
        toolNames: calls.map((part) => String(part.toolName ?? "")),
        commands: [],
        writtenPaths: [],
        errors: [],
        text,
        mutated: false,
      };
      for (const call of calls) {
        const name = String(call.toolName ?? "");
        const input = (call.input ?? {}) as { command?: unknown; path?: unknown };
        if (COMMAND_TOOLS.includes(name) && typeof input.command === "string") {
          current.commands.push(input.command);
        }
        if (WRITE_TOOLS.includes(name)) {
          const path = typeof input.path === "string" ? input.path : "";
          if (path) current.writtenPaths.push(path);
          current.mutated = true;
        }
      }
      steps.push(current);
      continue;
    }
    if (message.role === "tool") {
      for (const part of partsOf(message)) {
        if (part.type !== "tool-result") continue;
        const isError = part.isError === true || part.output === undefined;
        if (isError) current?.errors.push(String(part.output ?? ""));
      }
    }
  }
  return steps;
};

const consecutiveTail = (steps: ReconstructedStep[], matches: (step: ReconstructedStep) => boolean, streak: number): boolean => {
  if (streak <= 0 || steps.length < streak) return false;
  return steps.slice(-streak).every(matches);
};

/* ------------------------------------------------------------------ rules */

export type AntiLoopVerdict = {
  /** True when any rule fired. */
  stopped: boolean;
  /** Which rule fired, for the log line. Only meaningful when `stopped`. */
  reason?:
    | "git-verify-loop"
    | "post-edit-git-verify"
    | "hallucinated-tool-loop"
    | "validation-failure-loop"
    | "completion-spam";
  detail?: Record<string, unknown>;
};

export type AntiLoopOptions = {
  mode?: "scout" | "implement";
  /** A lower git-verify streak, for a run that has already oriented itself. */
  implementFastPath?: boolean;
  /** Paths that count as the application's own files. */
  isApplicationPath?: (path: string) => boolean;
  gitVerifyStreak?: number;
  hallucinatedToolStreak?: number;
  validationFailureStreak?: number;
  /** How many identical assistant messages count as completion spam. */
  completionSpamStreak?: number;
};

/**
 * Every rule, evaluated once against the whole transcript.
 *
 * Returns which rule fired rather than a bare boolean, so the stop can be logged
 * with a reason — "anti-loop" without a cause is a line nobody can act on.
 */
export const evaluateAntiLoop = (
  messages: readonly ModelMessage[],
  options: AntiLoopOptions = {},
): AntiLoopVerdict => {
  const steps = reconstructSteps(messages);
  if (steps.length === 0) return { stopped: false };

  const gitVerifyStreak = options.gitVerifyStreak ?? resolveGitVerifyStreak({ implementFastPath: options.implementFastPath });
  const hallucinatedStreak = options.hallucinatedToolStreak ?? resolveHallucinatedToolStreak();
  const validationStreak = options.validationFailureStreak ?? resolveValidationFailureStreak();
  const spamStreak = options.completionSpamStreak ?? 3;
  const isApplicationPath = options.isApplicationPath ?? (() => true);

  const isVerifyOnly = (step: ReconstructedStep): boolean =>
    step.commands.length > 0 && step.commands.every(isGitVerificationCommand) && step.writtenPaths.length === 0;

  const sawWrite = steps.some((step) => step.writtenPaths.some(isApplicationPath));

  // Verification passes counted since the last application write.
  //
  // Counted separately from the consecutive tail below, because the two rules ask
  // different questions: "is it stuck verifying right now" and "has it verified
  // twice since it last changed something". Checking only the final step for the
  // second one fires after a single verification pass, which is what a healthy
  // run does after every edit.
  let verifySinceWrite = 0;
  for (const step of steps) {
    if (step.writtenPaths.some(isApplicationPath)) {
      verifySinceWrite = 0;
      continue;
    }
    if (isVerifyOnly(step)) verifySinceWrite += 1;
  }

  // Every step after a write is only verifying, N times running.
  const gitVerifyLoop =
    sawWrite &&
    consecutiveTail(
      steps,
      isVerifyOnly,
      gitVerifyStreak,
    );
  if (gitVerifyLoop) return { stopped: true, reason: "git-verify-loop", detail: { gitVerifyStreak } };

  // Verified twice since the last write, and ended on the second: it believes the
  // work is done.
  const tail = steps.slice(-1)[0];
  if (sawWrite && verifySinceWrite >= gitVerifyStreak && tail && isVerifyOnly(tail)) {
    return { stopped: true, reason: "post-edit-git-verify", detail: { gitVerifyStreak, verifySinceWrite } };
  }

  const hallucinated = consecutiveTail(
    steps,
    (step) => step.toolNames.length > 0 && step.toolNames.every(isHallucinatedToolName),
    hallucinatedStreak,
  );
  if (hallucinated) return { stopped: true, reason: "hallucinated-tool-loop", detail: { hallucinatedStreak } };

  const validationFailures = consecutiveTail(
    steps,
    (step) => step.errors.length > 0 && step.toolNames.length > 0,
    validationStreak,
  );
  if (validationFailures) return { stopped: true, reason: "validation-failure-loop", detail: { validationStreak } };

  const saidDone = (step: ReconstructedStep): boolean => /\b(i'?m done|that'?s (it|all)|finished|implemented|complete)\b/i.test(step.text);
  if (consecutiveTail(steps, saidDone, spamStreak)) {
    return { stopped: true, reason: "completion-spam", detail: { spamStreak } };
  }

  return { stopped: false };
};

export type ShouldStopOptions = AntiLoopOptions & {
  env?: Record<string, string | undefined>;
  /** Overridable for tests; defaults to `console.info`. */
  sink?: (line: string, detail: unknown) => void;
};

/**
 * The `shouldStop` hook, built from the rules.
 *
 * ```ts
 * runAgent({ ..., shouldStop: createAntiLoopStop({ isApplicationPath: isRepoSourcePath }) })
 * ```
 */
export const createAntiLoopStop = (options: ShouldStopOptions = {}) => {
  const sink = options.sink ?? ((line: string, detail: unknown) => console.info(line, detail));
  return ({ messages }: { messages: readonly ModelMessage[] }): boolean => {
    const verdict = evaluateAntiLoop(messages, options);
    if (verdict.stopped && verdict.reason) {
      sink("[coding-agent] anti-loop stop", {
        mode: options.mode ?? "implement",
        reason: verdict.reason,
        ...verdict.detail,
      });
    }
    return verdict.stopped;
  };
};

/** Re-exported so a caller wiring a run does not need a second import. */
export { toolNamesFrom, wroteFiles };