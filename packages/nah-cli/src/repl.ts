import * as readline from "node:readline/promises";
import { promises as fs } from "node:fs";
import { createHash } from "node:crypto";
import * as nodePath from "node:path";

import type { HarnessEvent } from "@astracollab/not-another-harness";

import { buildNahSystemPrompt, defaultSessionFile, withFileInclusions } from "./context.js";
import { resolveModel } from "./model.js";
import { getModelOptions } from "./model-catalog.js";
import { pickModel } from "./model-picker.js";
import { removeProviderKey, storeProviderKey, type BuiltinProvider } from "./credentials.js";
import { createApprover, parsePermissionMode, type PermissionMode } from "./permissions.js";
import { c, renderWelcome, toolLabel, usageLine } from "./render.js";
import { runTurn, type SessionState, type StepRecovery } from "./session.js";
import { createTaskLedgerTool, formatTaskLedger } from "./task-ledger.js";
import { createDelegationTool } from "./delegation.js";
import { loadLastModel, saveLastModel } from "./model-preferences.js";

const REPL_HELP = `Slash commands:
  /help                 Show this help
  /model                Search and select a model
  /model <spec>         Switch directly (e.g. /model openai:gpt-5.2)
  /provider [name]      Add or switch provider credentials securely
  /provider remove <name>  Remove a saved provider key
  /permissions [mode]   ask | yolo | readonly (gate edit/write/bash)
  /stats                Tokens used this session
  /task                 Show the saved plan and progress
  delegate_task         Run an independent subtask in a temporary Git worktree
  /task clear           Clear the active plan
  /diff                 Show current workspace changes
  /undo                 Undo the last turn's workspace changes
  /undo [step]          Restore the last turn or last agent step
  /clear                Drop the transcript (start fresh)
  /branches             List session branches
  /branch <name>        Fork or switch to a named branch
  /session new|off      New JSONL session file / stop persisting
  /compact              Force transcript compaction (truncate mode)
  /quit                 Exit (Ctrl-C also aborts the current turn)

Everything else is sent to the agent. Prefix files with @ to include them.`;

const shellQuote = (value: string): string => `'${value.replace(/'/g, "'\\''")}'`;

/** Render one turn to stdout: streamed text + one line per tool call. */
export const renderTurn = async (
  events: AsyncIterable<HarnessEvent>,
  out: NodeJS.WriteStream = process.stdout,
  getProviderStatus: () => string | null = () => null,
): Promise<void> => {
  let textOpen = false;
  let textLineStart = true;
  const terminalWidth = out.columns ?? 80;
  const contentWidth = Math.min(100, Math.max(40, terminalWidth - 8));
  const indentWidth = out.isTTY ? Math.max(0, Math.floor((terminalWidth - contentWidth) / 2)) : 0;
  const indent = " ".repeat(indentWidth);
  const writeIndented = (value: string) => out.write(`${indent}${value}`);
  const writeStreamText = (value: string) => {
    const lines = value.split("\n");
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index]!;
      if (textLineStart && line.length > 0) writeIndented("");
      if (line) out.write(line);
      textLineStart = false;
      if (index < lines.length - 1) {
        out.write("\n");
        textLineStart = true;
      }
    }
  };
  let spinnerLabel = "";
  let spinnerFrame = 0;
  let spinnerVisible = false;
  const spinnerFrames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  const canAnimate = Boolean(out.isTTY);
  const clearSpinner = () => {
    if (!spinnerVisible) return;
    out.write("\r\u001b[2K");
    spinnerVisible = false;
  };
  const startSpinner = (label: string) => {
    spinnerLabel = label;
    spinnerFrame = 0;
    spinnerVisible = false;
  };
  const drawSpinner = () => {
    const label = getProviderStatus() ?? spinnerLabel;
    if (!canAnimate || !label) return;
    out.write(`\r${indent}${c.cyan(spinnerFrames[spinnerFrame % spinnerFrames.length]!)} ${c.dim(label)}`);
    spinnerFrame += 1;
    spinnerVisible = true;
  };
  const nl = () => {
    clearSpinner();
    if (textOpen) {
      out.write("\n");
      textOpen = false;
      textLineStart = true;
    }
  };

  const iterator = events[Symbol.asyncIterator]();
  let nextEvent = iterator.next();
  while (true) {
    const outcome = await Promise.race([
      nextEvent.then((result) => ({ type: "event" as const, result })),
      new Promise<{ type: "tick" }>((resolve) => setTimeout(() => resolve({ type: "tick" }), 90)),
    ]);
    if (outcome.type === "tick") {
      drawSpinner();
      continue;
    }
    if (outcome.result.done) break;
    const e = outcome.result.value;
    nextEvent = iterator.next();
    switch (e.type) {
      case "step-start":
        clearSpinner();
        startSpinner("thinking");
        break;
      case "text-delta":
        clearSpinner();
        spinnerLabel = "";
        writeStreamText(e.text);
        textOpen = true;
        break;
      case "tool-call":
        nl();
        writeIndented(`  ${c.cyan("◆")} ${c.bold(toolLabel(e.toolName, e.input))}\n`);
        startSpinner(`running ${toolLabel(e.toolName, e.input)}`);
        break;
      case "tool-result": {
        clearSpinner();
        spinnerLabel = "";
        if (!e.isError) {
          break;
        }
          writeIndented(`  ${c.red("└─ ✕")} ${c.dim(e.output.split("\n")[0]?.slice(0, 120) ?? "error")}\n`);
        break;
      }
      case "compacted":
        nl();
        writeIndented(
          c.magenta(`  ⤓ compacted transcript (−${e.droppedMessages} messages, kept ${e.keptMessages})\n`),
        );
        break;
      case "step-finish":
        break; // per-step usage stays quiet; /stats has the totals
      case "finish":
        nl();
        spinnerLabel = "";
        writeIndented(`${c.dim(`  ${usageLine(e.usage)}${e.reason === "completed" ? "" : ` · ${e.reason}`}`)}\n`);
        break;
      case "error":
        nl();
        spinnerLabel = "";
        writeIndented(`${c.red("error:")} ${e.error instanceof Error ? e.error.message : String(e.error)}\n`);
        break;
      default:
        break;
    }
  }
};

const setActiveModel = (state: SessionState, model: SessionState["model"]): void => {
  state.model?.setStatusHandler();
  state.model = model;
  state.providerStatus = null;
  model?.setStatusHandler((status) => { state.providerStatus = status; });
};

const withStatusUpdates = async function* (
  events: AsyncIterable<HarnessEvent>,
  state: SessionState,
): AsyncIterable<HarnessEvent> {
  for await (const event of events) {
    if (event.type === "step-finish") {
      state.contextUsedTokens = event.usage.inputTokens;
      state.lastOutputTokens = event.usage.outputTokens;
      state.contextUsageEstimated = event.usage.estimated === true;
    }
    if (event.type === "finish" || event.type === "error") state.providerStatus = null;
    yield event;
  }
};

const renderStatusPrompt = (state: SessionState): string => {
  const format = (value: number): string =>
    value >= 1_000_000 ? `${(value / 1_000_000).toFixed(1)}m` : value >= 1_000 ? `${(value / 1_000).toFixed(1)}k` : String(value);
  const providerModel = state.model
    ? `${state.model.provider} · ${state.model.modelId}`
    : "model not configured";
  const status = [
    c.dim(`↑${format(state.totalUsage.inputTokens)} ↓${format(state.totalUsage.outputTokens)} tokens`),
    c.dim(`ctx ${state.contextUsageEstimated ? "~" : ""}${format(state.contextUsedTokens)} used`),
    c.dim(`usage ${format(state.totalUsage.totalTokens)} total`),
    c.cyan(providerModel),
    c.magenta(`mode ${state.permissions} · interactive`),
  ].join(c.dim("  │  "));
  const left = Math.max(0, Math.floor(((process.stdout.columns ?? 80) - 100) / 2));
  const indent = " ".repeat(left);
  return `${indent}${status}\n${indent}${c.magenta("❯")} `;
};

const providerIds: BuiltinProvider[] = ["anthropic", "openai", "openrouter"];

const setupProvider = async (
  state: SessionState,
  requested: string,
  out: NodeJS.WriteStream,
): Promise<void> => {
  let providerName = requested.trim().toLowerCase();
  if (!providerName) {
    const prompt = readline.createInterface({ input: process.stdin, output: out, terminal: Boolean(process.stdin.isTTY) });
    try {
      providerName = (await prompt.question("Provider (anthropic / openai / openrouter): ")).trim().toLowerCase();
    } finally {
      prompt.close();
    }
  }
  if (providerName.startsWith("remove ")) {
    const target = providerName.slice("remove ".length).trim() as BuiltinProvider;
    if (!providerIds.includes(target)) {
      out.write(c.red("usage: /provider remove anthropic|openai|openrouter\n"));
      return;
    }
    try {
      await removeProviderKey(target);
      if (state.model?.provider === target) setActiveModel(state, null);
      out.write(c.dim(`removed saved ${target} key\n`));
    } catch (error) {
      out.write(c.red(`${error instanceof Error ? error.message : String(error)}\n`));
    }
    return;
  }
  if (!providerIds.includes(providerName as BuiltinProvider)) {
    out.write(c.red("Choose a supported provider: anthropic, openai, or openrouter. Custom OpenAI-compatible providers still need NAH_BASE_URL.\n"));
    return;
  }
  const provider = providerName as BuiltinProvider;
  try {
    await storeProviderKey(provider);
    out.write(c.green(`saved ${provider} credentials in the device credential store\n`));
    setActiveModel(state, null);
    const options = (await getModelOptions()).filter((option) => option.provider === provider);
    const selected = await pickModel(options);
    if (!selected) {
      out.write(c.dim("key saved; run /model when you’re ready to choose a model\n"));
      return;
    }
    const model = await resolveModel(selected);
    setActiveModel(state, model);
    await saveLastModel(model.spec);
    out.write(c.green(`provider → ${provider} · model → ${model.modelId}\n`));
  } catch (error) {
    out.write(c.red(`${error instanceof Error ? error.message : String(error)}\n`));
  }
};

type SlashResult = "handled" | "quit" | "not-a-command";

export const handleSlashCommand = async (
  input: string,
  state: SessionState,
  cwd: string,
  out: NodeJS.WriteStream = process.stdout,
): Promise<SlashResult> => {
  const [cmd, ...rest] = input.slice(1).split(/\s+/);
  const arg = rest.join(" ").trim();

  switch (cmd) {
    case "help":
      out.write(`${REPL_HELP}\n`);
      return "handled";
    case "quit":
    case "exit":
      return "quit";
    case "clear":
      try {
        await state.store?.reset();
        state.messages = [];
        state.taskLedger = null;
        state.undoHistory = [];
        out.write(c.dim("(transcript cleared)\n"));
      } catch (e) {
        out.write(c.red(`could not clear session: ${e instanceof Error ? e.message : String(e)}\n`));
      }
      return "handled";
    case "stats":
      out.write(
        c.dim(
          `${state.turns} turns · ${usageLine(state.totalUsage)} · ${state.messages.length} messages`,
        ) + "\n",
      );
      return "handled";
    case "task":
      if (arg === "clear") {
        try {
          await state.store?.saveTaskLedger(null);
          state.taskLedger = null;
          out.write(c.dim("(task plan cleared)\n"));
        } catch (e) {
          out.write(c.red(`could not clear task plan: ${e instanceof Error ? e.message : String(e)}\n`));
        }
      } else if (state.taskLedger) {
        out.write(`${formatTaskLedger(state.taskLedger)}\n`);
      } else {
        out.write(c.dim("(no task plan saved)\n"));
      }
      return "handled";
    case "diff": {
      const status = await state.workspace.exec("git status --porcelain=v1 -z", { timeoutSeconds: 15 });
      const diff = await state.workspace.exec("git diff --no-ext-diff --no-color HEAD --", { timeoutSeconds: 15 });
      const statusItems = status.stdout.split("\0").filter(Boolean);
      const untracked = statusItems.filter((item) => item.startsWith("?? ")).slice(0, 20);
      const untrackedDiffs: string[] = [];
      for (const item of untracked) {
        const file = item.slice(3);
        const result = await state.workspace.exec(`git diff --no-index --no-color -- /dev/null ${shellQuote(file)}`, { timeoutSeconds: 10 });
        if (result.stdout.trim()) untrackedDiffs.push(result.stdout);
      }
      const summary = statusItems.map((item) => item.slice(0, 2) + " " + item.slice(3)).join("\n");
      const combined = [summary, diff.stdout.trim(), ...untrackedDiffs].filter(Boolean).join("\n\n");
      out.write(combined ? `${combined.slice(0, 24_000)}${combined.length > 24_000 ? "\n[diff truncated at 24 KB]" : ""}\n` : c.dim("(no Git changes found)\n"));
      if (status.exitCode !== 0 && diff.exitCode !== 0) out.write(c.red("Git diff unavailable in this workspace.\n"));
      return "handled";
    }
    case "undo": {
      const checkpoint = state.undoHistory[state.undoHistory.length - 1];
      if (!checkpoint) {
        out.write(c.dim("(no NAH file-tool edits to undo)\n"));
        return "handled";
      }
      const stepOnly = arg === "step";
      const recoverySteps = checkpoint.steps ?? (checkpoint.changes.length ? [{
        step: 0,
        before: null,
        after: null,
        changedPaths: [],
        beforeTouchedFingerprints: {},
        afterTouchedFingerprints: {},
        snapshotAvailable: false,
        snapshotReason: "legacy turn checkpoint",
        fileChanges: checkpoint.changes,
        shellCommands: [],
        messagesBefore: checkpoint.messages,
        ledgerBefore: null,
      }] : []);
      const selectedSteps = stepOnly ? [recoverySteps.at(-1)].filter((step): step is StepRecovery => step !== undefined) : [...recoverySteps].reverse();
      if (stepOnly && selectedSteps.length === 0) {
        out.write(c.dim("(no agent step snapshot is available to undo)\n"));
        return "handled";
      }
      try {
        if (!stepOnly && selectedSteps.length && selectedSteps.every((step) => step.snapshotAvailable)) {
          await validateTurnSnapshots(state, [...selectedSteps].reverse());
        } else if (!stepOnly) {
          await validateFileChanges(state, checkpoint.changes);
        }
        for (const step of selectedSteps) await restoreStep(state, step);
        const messages = stepOnly ? selectedSteps[0]!.messagesBefore : checkpoint.messages;
        const taskLedger = stepOnly ? selectedSteps[0]!.ledgerBefore : checkpoint.ledgerBefore ?? null;
        await state.store?.replace(messages);
        await state.store?.saveTaskLedger?.(taskLedger);
        state.messages = messages;
        state.taskLedger = taskLedger;
        if (stepOnly) {
          checkpoint.steps.pop();
          if (checkpoint.steps.length === 0) state.undoHistory.pop();
        } else {
          state.undoHistory.pop();
        }
        const commands = selectedSteps.flatMap((step) => step.shellCommands);
        const restored = selectedSteps.reduce((sum, step) => sum + (step.snapshotAvailable ? step.changedPaths.length : step.fileChanges.length), 0);
        const shellSummary = commands.length
          ? ` Shell commands ran: ${commands.join("; ")}. Snapshots restore workspace files, excluding .git and node_modules. Process, network, service/database, package-cache, and out-of-workspace effects cannot be reversed.`
          : "";
        const incomplete = selectedSteps.some((step) => !step.snapshotAvailable);
        const reasons = [...new Set(selectedSteps.map((step) => step.snapshotReason).filter((reason): reason is string => Boolean(reason)))];
        const incompleteSummary = incomplete
          ? `; at least one step lacked a complete filesystem snapshot${reasons.length ? ` (${reasons.join("; ")})` : ""}, so shell-written files may remain`
          : "";
        out.write(c.dim(`${stepOnly ? `undid step ${selectedSteps[0]!.step}` : "undid the last turn"}; restored ${restored} workspace path(s)${incompleteSummary}.${shellSummary}\n`));
      } catch (e) {
        out.write(c.red(`could not undo ${stepOnly ? "step" : "turn"}: ${e instanceof Error ? e.message : String(e)}\n`));
      }
      return "handled";
    }
    case "branches": {
      if (!state.sessionBasePath) {
        out.write(c.dim("(session persistence is off)\n"));
        return "handled";
      }
      try {
        const base = state.sessionBasePath.replace(/\.jsonl$/, "");
        const parent = nodePath.dirname(base);
        const prefix = `${nodePath.basename(base)}.`;
        const files = await fs.readdir(parent);
        const names = files.filter((file) => file.startsWith(prefix) && file.endsWith(".jsonl")).map((file) => file.slice(prefix.length, -6));
        out.write(`${c.bold("main")}${state.store?.path === state.sessionBasePath ? " (active)" : ""}\n`);
        for (const name of names.sort()) out.write(`${name}${state.store?.path === `${base}.${name}.jsonl` ? " (active)" : ""}\n`);
      } catch (e) {
        out.write(c.red(`could not list branches: ${e instanceof Error ? e.message : String(e)}\n`));
      }
      return "handled";
    }
    case "branch": {
      if (!state.store || !state.sessionBasePath) {
        out.write(c.red("session branching requires session persistence\n"));
        return "handled";
      }
      if (!/^[a-zA-Z0-9_-]{1,48}$/.test(arg)) {
        out.write(c.red("usage: /branch <1-48 character name using letters, numbers, _ or ->\n"));
        return "handled";
      }
      try {
        if (arg === "main") {
          const { createJsonlSessionStore } = await import("@astracollab/not-another-harness");
          const store = createJsonlSessionStore(state.sessionBasePath);
          state.store = store;
          state.messages = await store.load();
          state.taskLedger = await store.loadTaskLedger();
          state.undoHistory = [];
          out.write(c.dim("switched to branch main\n"));
          return "handled";
        }
        const base = state.sessionBasePath.replace(/\.jsonl$/, "");
        const destination = `${base}.${arg}.jsonl`;
        try {
          await fs.access(destination);
          const { createJsonlSessionStore } = await import("@astracollab/not-another-harness");
          const store = createJsonlSessionStore(destination);
          const messages = await store.load();
          if (messages.length === 0) throw new Error("branch file exists but has no active transcript");
          state.store = store;
          state.messages = messages;
          state.taskLedger = await store.loadTaskLedger();
          state.undoHistory = [];
          out.write(c.dim(`switched to branch ${arg}\n`));
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
          state.store = await state.store.fork(destination);
          state.messages = await state.store.load();
          state.taskLedger = await state.store.loadTaskLedger();
          state.undoHistory = [];
          out.write(c.dim(`forked branch ${arg}\n`));
        }
      } catch (e) {
        out.write(c.red(`could not switch branch: ${e instanceof Error ? e.message : String(e)}\n`));
      }
      return "handled";
    }
    case "model": {
      if (!arg) {
        out.write(c.dim(`current model: ${state.model?.spec ?? "not configured"}\n`));
        return "handled";
      }
      try {
        const model = await resolveModel(arg);
        setActiveModel(state, model);
        await saveLastModel(model.spec);
        out.write(c.dim(`model → ${model.spec}\n`));
      } catch (e) {
        out.write(c.red(e instanceof Error ? e.message : String(e)) + "\n");
      }
      return "handled";
    }
    case "permissions": {
      if (!arg) {
        out.write(c.dim(`permissions: ${state.permissions}\n`));
        return "handled";
      }
      const mode = parsePermissionMode(arg);
      if (!mode) {
        out.write(c.red("usage: /permissions ask|yolo|readonly") + "\n");
        return "handled";
      }
      state.permissions = mode;
      out.write(c.dim(`permissions → ${mode}\n`));
      return "handled";
    }
    case "session": {
      if (arg === "off") {
        state.store = null;
        out.write(c.dim("(session persistence off for this process)\n"));
        return "handled";
      }
      if (arg === "new") {
        const p = `${defaultSessionFile(cwd)}`.replace(/\.jsonl$/, `-${Date.now()}.jsonl`);
        const { createJsonlSessionStore } = await import("@astracollab/not-another-harness");
        state.store = createJsonlSessionStore(p);
        state.sessionBasePath = p;
        state.messages = [];
        state.taskLedger = null;
        state.undoHistory = [];
        out.write(c.dim(`new session → ${p}\n`));
        return "handled";
      }
      out.write(c.red("usage: /session new | off") + "\n");
      return "handled";
    }
    case "compact": {
      if (!state.model) {
        out.write(c.red("configure a model before compacting: set a provider API key, then use /model <provider:model-id>\n"));
        return "handled";
      }
      const { compactMessages } = await import("@astracollab/not-another-harness");
      const compacted = await compactMessages({
        model: state.model.model,
        system: state.system,
        messages: state.messages,
        keepRecent: 6,
        mode: "truncate",
      });
      if (!compacted) {
        out.write(c.dim("(nothing to compact yet)\n"));
      } else {
        try {
          await state.store?.replace(compacted.messages);
          state.messages = compacted.messages;
          out.write(c.dim(`compacted −${compacted.droppedMessages} messages\n`));
        } catch (e) {
          out.write(c.red(`could not save compacted session: ${e instanceof Error ? e.message : String(e)}\n`));
        }
      }
      return "handled";
    }
    default:
      if (cmd) {
        out.write(c.red(`unknown command /${cmd} — /help`) + "\n");
        return "handled";
      }
      return "not-a-command";
  }
};

const validateFileChanges = async (
  state: SessionState,
  changes: Array<{ path: string; after: string }>,
): Promise<void> => {
  const finalByPath = new Map(changes.map((change) => [change.path, change]));
  for (const change of finalByPath.values()) {
    const exists = await state.workspace.exists(change.path);
    const current = exists ? await state.workspace.readFile(change.path) : undefined;
    if (current !== change.after) throw new Error(`${change.path} changed since NAH edited it; no files were restored`);
  }
};

const restoreStep = async (state: SessionState, step: StepRecovery): Promise<void> => {
  if (step.snapshotAvailable && step.before && step.after && state.workspace.restoreSnapshot) {
    const result = await state.workspace.restoreSnapshot(step.before, step.after, step.changedPaths);
    if (result.conflicts.length) throw new Error(`${result.conflicts.join(", ")} changed after step ${step.step}; left untouched`);
    return;
  }
  const finalByPath = new Map(step.fileChanges.map((change) => [change.path, change]));
  for (const change of finalByPath.values()) {
    const exists = await state.workspace.exists(change.path);
    const current = exists ? await state.workspace.readFile(change.path) : undefined;
    if (current !== change.after) throw new Error(`${change.path} changed since step ${step.step}; leaving it untouched`);
  }
  for (const change of [...step.fileChanges].reverse()) {
    if (change.existed) await state.workspace.writeFile(change.path, change.content ?? "");
    else if (state.workspace.deleteFile) await state.workspace.deleteFile(change.path);
    else throw new Error(`workspace cannot remove newly created file ${change.path}`);
  }
};

const validateTurnSnapshots = async (state: SessionState, chronological: StepRecovery[]): Promise<void> => {
  const snapshots = state.workspace.snapshot;
  if (!snapshots) throw new Error("workspace snapshots are unavailable");
  const current = await snapshots.call(state.workspace);
  if (!current.complete) throw new Error(`cannot verify current workspace: ${current.reason ?? "snapshot incomplete"}`);
  const changed = new Set(chronological.flatMap((step) => step.changedPaths));
  const fingerprint = (entry: unknown): string => entry === undefined
    ? "missing"
    : createHash("sha256").update(JSON.stringify(entry)).digest("hex");
  for (const file of changed) {
    let expected: StepRecovery | undefined;
    for (const step of chronological) if (step.changedPaths.includes(file)) expected = step;
    if (expected && fingerprint(current.entries[file]) !== expected.afterTouchedFingerprints[file]) {
      throw new Error(`${file} changed since the recorded turn; no files were restored`);
    }
  }
  const previouslyTouched = new Set<string>();
  for (let index = 0; index < chronological.length; index += 1) {
    const next = chronological[index]!;
    if (index > 0) {
      const previous = chronological[index - 1]!;
      for (const file of previouslyTouched) {
        if (previous.afterTouchedFingerprints[file] !== next.beforeTouchedFingerprints[file]) {
          throw new Error(`${file} changed between agent steps; whole-turn recovery is unsafe`);
        }
      }
    }
    next.changedPaths.forEach((file) => previouslyTouched.add(file));
  }
};

export const startRepl = async (state: SessionState): Promise<void> => {
  const out = process.stdout;
  out.write(renderWelcome({ cwd: state.cwd, model: state.model?.spec ?? null, permissions: state.permissions, sandbox: state.sandboxCwd }));
  let abort: AbortController | null = null;
  let activeRl: readline.Interface | null = null;
  const onSigint = () => {
    if (abort) {
      abort.abort();
      out.write(c.dim("\n(turn aborted)\n"));
    } else {
      activeRl?.close();
    }
  };
  process.on("SIGINT", onSigint);
  try {
    let keepRunning = true;
    while (keepRunning) {
      let openModelPicker = false;
      let openProviderSetup = false;
      let providerRequest = "";
      let receivedInput = false;
        const rl = readline.createInterface({
        input: process.stdin,
        output: out,
        terminal: true,
        historySize: 500,
        prompt: `${c.magenta("❯")} `,
      });
      activeRl = rl;
      rl.setPrompt(renderStatusPrompt(state));
      rl.prompt();
      try {
        for await (const line of rl) {
          receivedInput = true;
          const input = line.trim();
          if (!input) {
            rl.prompt();
            continue;
          }
          if (input === "/model" || input === "/models") {
            openModelPicker = true;
            rl.close();
            break;
          }
          if (input === "/provider" || input.startsWith("/provider ")) {
            openProviderSetup = true;
            providerRequest = input.slice("/provider".length).trim();
            rl.close();
            break;
          }
          if (input.startsWith("/")) {
            const result = await handleSlashCommand(input, state, state.cwd, out);
            if (result === "quit") {
              keepRunning = false;
              break;
            }
            rl.setPrompt(renderStatusPrompt(state));
            rl.prompt();
            continue;
          }

          abort = new AbortController();
          const files = input.match(/@([^\s]+)/g)?.map((s) => s.slice(1)) ?? [];
          const prompt = await withFileInclusions(state.cwd, files, input.replace(/@[^\s]+/g, "").trim());
          if (!state.model) {
            out.write(c.red("No model is configured yet. Set your provider API key, then use /model to browse models.\n\n"));
            rl.prompt();
            continue;
          }
          const turn = runTurn(state, prompt, { signal: abort.signal });
          try {
            await renderTurn(withStatusUpdates(turn.events, state), out, () => state.providerStatus);
            await turn.done;
          } catch (e) {
            out.write(c.red(e instanceof Error ? e.message : String(e)) + "\n");
          } finally {
            abort = null;
          }
          out.write("\n");
          rl.setPrompt(renderStatusPrompt(state));
          rl.prompt();
        }
      } finally {
        rl.close();
        activeRl = null;
      }
      if (!keepRunning) break;
      if (openModelPicker) {
        if (!process.stdin.isTTY) {
          out.write(c.red("Model search needs an interactive terminal. Use /model <provider:model-id> directly.\n"));
          continue;
        }
        out.write(c.dim("Loading model catalog…\n"));
        const options = await getModelOptions();
        const selected = await pickModel(options);
        if (selected) {
          try {
            const model = await resolveModel(selected);
            setActiveModel(state, model);
            await saveLastModel(model.spec);
            out.write(c.green(`model → ${model.spec}\n`));
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            out.write(c.red(`${selected}: ${message}\n`));
          }
        }
        continue;
      }
      if (openProviderSetup) {
        if (!process.stdin.isTTY) {
          out.write(c.red("Provider setup needs an interactive terminal.\n"));
          continue;
        }
        await setupProvider(state, providerRequest, out);
        continue;
      }
      if (!receivedInput) keepRunning = false;
    }
  } finally {
    process.off("SIGINT", onSigint);
    activeRl?.close();
  }
};

/** Build a fresh session state (shared by print/json/interactive modes). */
export const makeState = async (opts: {
  cwd: string;
  modelSpec?: string;
  sessionPath?: string;
  noSession?: boolean;
  permissions?: PermissionMode;
  /** Blaxel sandbox name, or true to create an ephemeral one. */
  sandbox?: string | true;
  extraSystemAppend?: string;
  allowUnconfiguredModel?: boolean;
}): Promise<SessionState> => {
  let model: SessionState["model"];
  try {
    const savedModel = opts.modelSpec === undefined && process.env.NAH_MODEL === undefined
      ? await loadLastModel()
      : undefined;
    model = await resolveModel(opts.modelSpec ?? savedModel);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (opts.allowUnconfiguredModel && /credentials are not set|API_KEY is not set|needs NAH_API_KEY/.test(message)) {
      model = null;
    } else {
      throw error;
    }
  }
  const { createCodingTools, createJsonlSessionStore } = await import(
    "@astracollab/not-another-harness"
  );

  let envToolSource: Parameters<typeof createCodingTools>[0];
  let cwdLabel = opts.cwd;
  let destroySandbox: (() => Promise<void>) | undefined;
  if (opts.sandbox) {
    const { createBlaxelEnvironment } = await import("./sandbox.js");
    const bl = await createBlaxelEnvironment({
      sandboxName: opts.sandbox === true ? undefined : opts.sandbox,
    });
    envToolSource = bl.env;
    cwdLabel = `blaxel sandbox ${bl.sandboxName}`;
    destroySandbox = bl.destroy;
  } else {
    const { createNodeEnvironment } = await import("@astracollab/not-another-harness/node");
    envToolSource = createNodeEnvironment(opts.cwd);
  }

  const system =
    opts.sandbox != null
      ? [
          await buildSystemPromptFor(opts.cwd, cwdLabel),
          "",
          `You are working in a remote sandbox (repo at ${cwdLabel === opts.cwd ? opts.cwd : "/workspace/repo"}). Changes do not affect the local machine.`,
        ].join("\n")
      : await buildNahSystemPrompt(opts.cwd);

  const store = opts.noSession || !opts.sessionPath ? null : createJsonlSessionStore(opts.sessionPath);
  const taskLedger = await store?.loadTaskLedger() ?? null;
  const state: SessionState = {
    messages: [],
    system,
    cwd: opts.cwd,
    tools: {},
    workspace: envToolSource,
    activeFileChanges: null,
    activeShellCommands: null,
    undoHistory: [],
    sessionBasePath: opts.noSession ? null : opts.sessionPath ?? null,
    taskLedger,
    discoveredChecks: [],
    store,
    model,
    providerStatus: null,
    totalUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    contextUsedTokens: 0,
    contextUsageEstimated: false,
    lastOutputTokens: 0,
    turns: 0,
    permissions: opts.permissions ?? "yolo",
    sandboxCwd: cwdLabel,
    destroySandbox,
  };
  model?.setStatusHandler((status) => { state.providerStatus = status; });
  const approve = createApprover(() => state.permissions);
  state.tools = {
    ...createCodingTools(envToolSource, {
    approveToolCall: approve,
    cwdLabel,
    onFileWrite: (change) => state.activeFileChanges?.push(change),
    onShellCommand: (command) => state.activeShellCommands?.push(command),
    }),
    task_ledger: createTaskLedgerTool(state, approve),
    ...(!opts.sandbox ? {
      delegate_task: createDelegationTool({
        cwd: opts.cwd,
        system: state.system,
        getModel: () => {
          if (!state.model) throw new Error("Configure a model before delegating a task.");
          return state.model.model;
        },
        approve,
        onChildUsage: (usage) => {
          state.totalUsage.inputTokens += usage.inputTokens;
          state.totalUsage.outputTokens += usage.outputTokens;
          state.totalUsage.totalTokens += usage.totalTokens;
        },
      }),
    } : {}),
  };
  return state;
};

const buildSystemPromptFor = async (cwd: string, label: string): Promise<string> => {
  const { buildSystemPrompt } = await import("@astracollab/not-another-harness");
  const { loadContextFiles } = await import("./context.js");
  return buildSystemPrompt({ cwdLabel: label, contextFiles: await loadContextFiles(cwd) });
};
