import { tool, type Tool } from "ai";
import { z } from "zod";
import type { SessionTaskLedger } from "not-another-harness";
import type { SessionState } from "./session.js";

const taskInput = z.discriminatedUnion("action", [
  z.object({ action: z.literal("discover_checks") }),
  z.object({
    action: z.literal("plan"), goal: z.string().trim().min(1).max(500),
    steps: z.array(z.string().trim().min(1).max(300)).min(1).max(20),
    checks: z.array(z.object({ description: z.string().trim().min(1).max(300), command: z.string().trim().min(1).max(500) })).min(1).max(12),
    replace: z.boolean().optional().describe("Set true only when the user has changed the scope of an unfinished plan."),
  }),
  z.object({ action: z.literal("step"), id: z.string().min(1), status: z.enum(["pending", "in_progress", "completed", "blocked"]), note: z.string().max(500).optional() }),
  z.object({ action: z.literal("run_check"), id: z.string().min(1), timeoutSeconds: z.number().int().min(1).max(1800).optional() }),
  z.object({ action: z.literal("status"), status: z.enum(["in_progress", "blocked", "completed"]) }),
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
      const invalid = input.checks.filter((check) => !state.discoveredChecks.includes(check.command));
      if (invalid.length) return `Error: each check command must exactly match a discovered command. Invalid: ${invalid.map((check) => check.command).join(", ")}`;
      const ledger: SessionTaskLedger = {
        version: 2, goal: input.goal, status: "in_progress",
        steps: input.steps.map((title, index) => ({ id: `step-${index + 1}`, title, status: "pending" })),
        checks: input.checks.map((check, index) => ({ ...check, id: `check-${index + 1}`, status: "pending" as const, attempts: [] })),
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
      step.status = input.status;
      if (input.note !== undefined) step.note = input.note;
      if (input.status === "blocked") next.status = "blocked";
      else if (input.status === "in_progress" && next.status === "blocked") next.status = "in_progress";
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
      if (input.status === "completed") {
        const unfinished = next.steps.filter((step) => step.status !== "completed");
        const unchecked = next.checks.filter((check) => check.status !== "passed" || check.attempts.at(-1)?.exitCode !== 0);
        if (unfinished.length || unchecked.length) return `Cannot complete task: ${unfinished.length} step(s) and ${unchecked.length} acceptance check(s) remain.`;
      }
      next.status = input.status;
    }
    next.updatedAt = new Date().toISOString();
    await persist(state, next);
    return formatTaskLedger(next);
  };
  return tool({
    description: "Maintain durable task progress. For substantial multi-step tasks, call discover_checks before editing, plan observable steps and executable acceptance checks using exact discovered commands, update steps, then run each acceptance check. A check passes only when run_check executes it and returns exit code 0. Repair failures and rerun; only mark completed after every step and check passes.",
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

const persist = async (state: SessionState, ledger: SessionTaskLedger | null): Promise<void> => {
  await state.store?.saveTaskLedger(ledger);
  state.taskLedger = ledger;
};
