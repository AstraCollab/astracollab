import { tool, type Tool } from "ai";
import { z } from "zod";
import type { SessionTaskLedger } from "not-another-harness";
import type { SessionState } from "./session.js";

/**
 * The step status, from the words a model reaches for.
 *
 * Only unambiguous names are mapped: a status nobody recognises stays
 * `pending` rather than being recorded as progress the work has not made.
 */
const stepStatus = (value: unknown): "pending" | "in_progress" | "completed" | "blocked" => {
  const text = typeof value === "string" ? value.trim().toLowerCase().replace(/[\s-]+/g, "_") : "";
  switch (text) {
    case "completed":
    case "complete":
    case "done":
    case "finished":
      return "completed";
    case "in_progress":
    case "active":
    case "doing":
      return "in_progress";
    case "blocked":
      return "blocked";
    default:
      return "pending";
  }
};

/**
 * The task status, from the words a model reaches for.
 *
 * The task is moving, stuck, or finished: those are the only three answers
 * the ledger keeps. A status nobody recognises is not guessed at, so the tool
 * can name the three it takes instead of recording progress that did not
 * happen.
 */
const ledgerStatus = (value: unknown): "in_progress" | "blocked" | "completed" | null => {
  const text = typeof value === "string" ? value.trim().toLowerCase().replace(/[\s-]+/g, "_") : "";
  switch (text) {
    case "completed":
    case "complete":
    case "done":
    case "finished":
      return "completed";
    case "in_progress":
    case "active":
    case "working":
      return "in_progress";
    case "blocked":
    case "stuck":
      return "blocked";
    default:
      return null;
  }
};

/**
 * The step title, from the object a model wrote instead of a bare string.
 */
const stepTitle = (value: Record<string, unknown>): string => {
  const known = [value.step, value.title, value.description, value.name];
  const found = known.find((entry): entry is string => typeof entry === "string" && entry.trim().length > 0);
  if (found) return found.trim();
  const other = Object.entries(value).find(
    ([key, entry]) => key !== "status" && typeof entry === "string" && entry.trim().length > 0,
  );
  return other ? (other[1] as string).trim() : "";
};

/**
 * A step, in the shape the ledger stores.
 *
 * The bare title is what the schema asks for and what a model sends most of
 * the time. It also sends `{step, status}` — the shape the ledger itself uses
 * — often enough to matter, and a plan thrown away over that cost a whole
 * turn: the model had the plan right and the tool said no. So the near miss
 * is read here instead of rejected.
 */
const toStep = (value: unknown): { title: string; status: "pending" | "in_progress" | "completed" | "blocked" } => {
  if (typeof value === "string") return { title: value.trim(), status: "pending" };
  if (!value || typeof value !== "object") return { title: "", status: "pending" };
  const record = value as Record<string, unknown>;
  return { title: stepTitle(record), status: stepStatus(record.status) };
};

/**
 * A check, in the shape the ledger stores: the command is what runs, and the
 * words around it are the model's to choose.
 */
const toCheck = (value: unknown): { description: string; command: string } => {
  if (!value || typeof value !== "object") return { description: "", command: "" };
  const record = value as Record<string, unknown>;
  const text = (entry: unknown): string => (typeof entry === "string" ? entry.trim() : "");
  return {
    description: text(record.description) || text(record.desc),
    command: text(record.command) || text(record.cmd) || text(record.script),
  };
};

/**
 * The plan shapes a model actually sends.
 *
 * The schema is deliberately loose about the shape of a step and a check: the
 * provider validates tool input against it before the tool runs, and a
 * rejection there is an opaque type error the model can only guess its way
 * out of. Anything that parses is normalised by `toStep`/`toCheck` instead.
 */
const stepInput = z
  .union([
    z.string().max(300),
    z
      .object({
        step: z.string().max(300).optional(),
        title: z.string().max(300).optional(),
        description: z.string().max(300).optional(),
        name: z.string().max(300).optional(),
        status: z.string().max(50).optional().describe("pending | in_progress | completed | blocked"),
      })
      .catchall(z.unknown()),
  ])
  .describe("A plan step: a short title, or an object with a step/title/description and an optional status.");

const checkInput = z
  .object({
    description: z.string().max(300).optional(),
    desc: z.string().max(300).optional(),
    command: z.string().max(500).optional(),
    cmd: z.string().max(500).optional(),
    script: z.string().max(500).optional(),
  })
  .catchall(z.unknown())
  .describe("An acceptance check: what it proves, and the exact command that proves it.");

const taskInput = z.discriminatedUnion("action", [
  z.object({ action: z.literal("discover_checks") }),
  z.object({
    action: z.literal("plan"), goal: z.string().trim().min(1).max(500),
    steps: z.array(stepInput).min(1).max(20),
    checks: z.array(checkInput).min(1).max(12),
    replace: z.boolean().optional().describe("Set true only when the user has changed the scope of an unfinished plan."),
  }),
  z.object({ action: z.literal("step"), id: z.string().min(1), status: z.string().min(1).max(50).describe("pending | in_progress | completed | blocked"), note: z.string().max(500).optional() }),
  z.object({ action: z.literal("run_check"), id: z.string().min(1), timeoutSeconds: z.number().int().min(1).max(1800).optional() }),
  z.object({ action: z.literal("status"), status: z.string().max(50).optional().describe("in_progress | blocked | completed. Leave it out to read the plan back.") }),
]);

export const formatTaskLedger = (ledger: SessionTaskLedger): string => [
  `Task: ${ledger.goal}`, `Status: ${ledger.status}`, "Steps:",
  ...ledger.steps.map((step) => `  ${step.id}. [${step.status}] ${step.title}${step.note ? ` — ${step.note}` : ""}`),
  "Acceptance checks:",
  ...ledger.checks.map((check) => {
    const attempt = check.attempts.at(-1);
    return `  ${check.id}. [${check.status}] ${check.description} — ${check.command || "command required"}${attempt ? ` (exit ${attempt.exitCode}, ${attempt.durationMs}ms)` : ""}${attempt?.output ? `\n     ${attempt.output.replace(/\n/g, "\n     ")}` : ""}`;
  }),
].join("\n");

type Approver = (toolName: string, input: unknown) => Promise<boolean>;

/**
 * Resolve a step/check by id, tolerating the shapes a model naturally guesses.
 *
 * Plans used to mint bare numeric ids ("1"), so the obvious guess of "step-1"
 * failed with a dead end. Accept the prefixed form, the bare number, and a
 * suffix match so older sessions keep working.
 */
const matchesId = (actual: string, requested: string, prefix: "step" | "check"): boolean => {
  const want = requested.trim().toLowerCase();
  const have = actual.trim().toLowerCase();
  if (!want || want === have) return false;
  if (have === `${prefix}-${want}`) return true;
  if (have === want.replace(new RegExp(`^${prefix}-`), "")) return true;
  return have.endsWith(`-${want}`);
};

const resolveStep = <T extends { id: string }>(steps: T[], id: string): T | undefined =>
  steps.find((s) => s.id === id) ?? steps.find((s) => matchesId(s.id, id, "step"));

const resolveCheck = <T extends { id: string }>(checks: T[], id: string): T | undefined =>
  checks.find((c) => c.id === id) ?? checks.find((c) => matchesId(c.id, id, "check"));

/** Always name the valid ids, so a wrong guess costs one call instead of a stall. */
const unknownIdError = (kind: "step" | "check", requested: string, ids: string[]): string =>
  ids.length > 0
    ? `Error: no ${kind} with id "${requested}". Valid ${kind} ids: ${ids.join(", ")}.`
    : `Error: the plan has no ${kind}s yet.`;

export const createTaskLedgerTool = (state: SessionState, approve: Approver): Tool => {
  let pending: Promise<unknown> = Promise.resolve();
  const execute = async (input: z.infer<typeof taskInput>, signal?: AbortSignal): Promise<string> => {
    if (input.action === "discover_checks") {
      const checks = await discoverChecks(state);
      state.discoveredChecks = checks;
      return checks.length ? `Discovered executable checks (use exact commands in the plan):\n${checks.map((check) => `- ${check}`).join("\n")}` : "No standard checks discovered. Inspect project instructions and define a suitable executable check manually.";
    }

    if (input.action === "plan") {
      if (state.taskLedger && state.taskLedger.status !== "completed" && input.replace !== true) return "Error: an active plan already exists. Update it, or pass replace=true if the user has changed scope.";
      if (state.discoveredChecks.length === 0) return "Error: call discover_checks before creating a plan.";
      /**
       * A command that differs only in whitespace is the same command: a model
       * that wrapped a long command across lines meant the command it wrote,
       * and refusing the plan over the wrapping costs the whole turn.
       */
      const resolved: Array<{ description: string; command: string }> = [];
      const invalid: string[] = [];
      let incomplete = false;
      for (const raw of input.checks) {
        const check = toCheck(raw);
        if (!check.description || !check.command) {
          incomplete = true;
          continue;
        }
        const match =
          state.discoveredChecks.find((candidate) => candidate === check.command) ??
          state.discoveredChecks.find(
            (candidate) => normalizeCommand(candidate) === normalizeCommand(check.command),
          );
        if (match) resolved.push({ description: check.description, command: match });
        else invalid.push(check.command);
      }
      if (incomplete) return "Error: every check needs a description and a command.";
      if (invalid.length) {
        return [
          `Error: each check command must exactly match a discovered command. Invalid: ${invalid.join(", ")}.`,
          "Use one of these exactly:",
          ...state.discoveredChecks.map((command) => `- ${command}`),
        ].join("\n");
      }
      const steps = input.steps.map(toStep);
      if (steps.some((step) => !step.title)) {
        return "Error: every step needs a title.";
      }
      const ledger: SessionTaskLedger = {
        version: 2, goal: input.goal, status: "in_progress",
        steps: steps.map((step, index) => ({ id: `step-${index + 1}`, title: step.title, status: step.status })),
        checks: resolved.map((check, index) => ({ ...check, id: `check-${index + 1}`, status: "pending" as const, attempts: [] })),
        updatedAt: new Date().toISOString(),
      };
      await persist(state, ledger);
      return `Task plan saved. Run each acceptance check with run_check before marking it complete.\n${formatTaskLedger(ledger)}`;
    }

    const current = state.taskLedger;
    if (!current) return "Error: create a task plan before updating its progress.";
    const next: SessionTaskLedger = structuredClone(current);
    if (input.action === "step") {
      const step = resolveStep(next.steps, input.id);
      if (!step) return unknownIdError("step", input.id, current.steps.map((s) => s.id));
      const status = stepStatus(input.status);
      step.status = status;
      if (input.note !== undefined) step.note = input.note;
      if (status === "blocked") next.status = "blocked";
      else if (status === "in_progress" && next.status === "blocked") next.status = "in_progress";
    } else if (input.action === "run_check") {
      const check = resolveCheck(next.checks, input.id);
      if (!check) return unknownIdError("check", input.id, next.checks.map((c) => c.id));
      if (!check.command) return `Error: acceptance check ${input.id} has no executable command; replace the plan after discovering checks.`;
      const approved = await approve("bash", { command: check.command, timeoutSeconds: input.timeoutSeconds ?? 300, purpose: `Acceptance check ${check.id}: ${check.description}` });
      if (!approved) return `Check ${check.id} was not run because shell execution was denied.`;
      check.status = "pending";
      await persist(state, next);
      const started = Date.now();
      let result: { stdout: string; stderr: string; exitCode: number };
      try {
        // Acceptance checks can run for minutes; honour the run's abort signal so
        // Ctrl-C stops the check instead of only being noticed afterwards.
        result = await state.workspace.exec(check.command, { timeoutSeconds: input.timeoutSeconds ?? 300, signal });
      } catch (error) {
        result = { stdout: "", stderr: error instanceof Error ? error.message : String(error), exitCode: 1 };
      }
      state.activeShellCommands?.push(`${check.command} [exit ${result.exitCode}]`);
      const output = `${result.stdout}${result.stderr ? `${result.stdout ? "\n" : ""}${result.stderr}` : ""}`.slice(-4000);
      check.attempts.push({ command: check.command, exitCode: result.exitCode, at: new Date().toISOString(), durationMs: Date.now() - started, output });
      check.attempts = check.attempts.slice(-10);
      check.status = result.exitCode === 0 ? "passed" : "failed";
      next.updatedAt = new Date().toISOString();
      await persist(state, next);
      return `Check ${check.id} ${check.status} (exit ${result.exitCode}, ${Date.now() - started}ms).${output ? `\n${output}` : ""}\n${formatTaskLedger(next)}`;
    } else {
      /**
       * A status with no value is a question, not a change: hand back the
       * plan as it stands. The schema used to demand a value, and the
       * provider rejected the whole call as invalid input before the tool
       * ran — an opaque type error for a question with a plain answer.
       */
      const requested = typeof input.status === "string" ? input.status.trim() : input.status;
      if (!requested) return formatTaskLedger(current);
      const status = ledgerStatus(requested);
      if (!status) return `Error: unknown task status "${requested}". Use one of: in_progress, blocked, completed.`;
      if (status === "completed") {
        const unfinished = next.steps.filter((step) => step.status !== "completed");
        const unchecked = next.checks.filter((check) => check.status !== "passed" || check.attempts.at(-1)?.exitCode !== 0);
        if (unfinished.length || unchecked.length) return `Cannot complete task: ${unfinished.length} step(s) and ${unchecked.length} acceptance check(s) remain.`;
      }
      next.status = status;
    }
    next.updatedAt = new Date().toISOString();
    await persist(state, next);
    return formatTaskLedger(next);
  };
  return tool({
    description: "Maintain durable task progress. For substantial multi-step tasks, call discover_checks before editing, plan observable steps and executable acceptance checks using exact discovered commands, update steps, then run each acceptance check. A check passes only when run_check executes it and returns exit code 0. Repair failures and rerun; only mark completed after every step and check passes. Set the task status with action=status and a status of in_progress, blocked or completed; call action=status with no status to read the plan back.",
    inputSchema: taskInput,
    execute: (input, options) => {
      const signal = (options as { abortSignal?: AbortSignal } | undefined)?.abortSignal;
      const result = pending.then(() => execute(input, signal), () => execute(input, signal));
      pending = result.then(() => undefined, () => undefined);
      return result;
    },
  });
};

const discoverChecks = async (state: SessionState): Promise<string[]> => {
  const env = state.workspace;
  const checks = new Set<string>(["git diff --check"]);
  const packageJsons = new Set<string>();
  const directories: Array<{ path: string; depth: number }> = [{ path: ".", depth: 0 }];
  let visited = 0;
  while (directories.length && visited < 500) {
    const current = directories.shift()!;
    visited += 1;
    try {
      const entries = await env.readdir(current.path);
      for (const entry of entries) {
        if (entry.type !== "directory" || [".git", "node_modules", ".next", "dist", "build", "coverage"].includes(entry.name)) continue;
        const child = current.path === "." ? entry.name : `${current.path}/${entry.name}`;
        if (current.depth < 4) directories.push({ path: child, depth: current.depth + 1 });
      }
      if (entries.some((entry) => entry.name === "package.json" && entry.type === "file")) {
        packageJsons.add(current.path === "." ? "package.json" : `${current.path}/package.json`);
      }
    } catch { /* Some virtual filesystems do not list every directory. */ }
  }
  packageJsons.add("package.json");
  for (const change of state.activeFileChanges ?? []) {
    const normalized = change.path.replaceAll("\\", "/");
    const parts = normalized.split("/").filter(Boolean);
    for (let i = 1; i < parts.length; i += 1) packageJsons.add(`${parts.slice(0, i).join("/")}/package.json`);
  }
  let runner = "npm";
  if (await env.exists("pnpm-lock.yaml")) runner = "pnpm";
  else if (await env.exists("yarn.lock")) runner = "yarn";
  else if (await env.exists("bun.lock") || await env.exists("bun.lockb")) runner = "bun";
  for (const file of packageJsons) {
    if (!(await env.exists(file))) continue;
    try {
      const manifest = JSON.parse(await env.readFile(file)) as { scripts?: Record<string, unknown> };
      const scripts = manifest.scripts ?? {};
      const prefix = file === "package.json" ? "" : `cd ${shellQuote(file.slice(0, -"/package.json".length))} && `;
      for (const name of ["test", "typecheck", "type-check", "lint", "build"]) {
        if (typeof scripts[name] !== "string") continue;
        const runName = name === "type-check" && scripts.typecheck ? "typecheck" : name;
        checks.add(`${prefix}CI=true ${runner} run ${runName}`);
      }
    } catch { /* Ignore invalid or unreadable package metadata. */ }
  }
  for (const [file, command] of [["Cargo.toml", "cargo test"], ["go.mod", "go test ./..."], ["pyproject.toml", "python -m pytest -q"]] as const) {
    if (await env.exists(file)) checks.add(command);
  }
  return [...checks];
};

const shellQuote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;

/** Two commands that differ only in whitespace are the same command. */
const normalizeCommand = (value: string): string => value.replace(/\s+/g, " ").trim();

const persist = async (state: SessionState, ledger: SessionTaskLedger | null): Promise<void> => {
  await state.store?.saveTaskLedger(ledger);
  state.taskLedger = ledger;
};
