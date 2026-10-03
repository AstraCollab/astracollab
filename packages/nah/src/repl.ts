import * as readline from "node:readline/promises";
import { promises as fs } from "node:fs";
import { createHash } from "node:crypto";
import * as nodePath from "node:path";

import type { HarnessEvent } from "not-another-harness";

import { defaultSessionFile, withFileInclusions } from "./context.js";
import { resolveModel } from "./model.js";
import { getModelOptions } from "./model-catalog.js";
import { pickModel } from "./model-picker.js";
import { removeProviderKey, storeProviderKey, type BuiltinProvider } from "./credentials.js";
import { parsePermissionMode } from "./permissions.js";
import { c, formatFileChange, formatWorkspaceDiff, renderWelcome, toolLabel, usageLine, type RenderableFileChange } from "./render.js";
import { renderCommandHelp } from "./commands.js";
import { listSessionIds, resolveSessionFile } from "./context.js";
import { handleCogmemCommand } from "./cogmem-command.js";
import { adoptUsage, resetUsage, resolveInjection, runTurn, type SessionState, type StepRecovery } from "./session.js";
import { runStudioCommand, confirmOnStdout } from "./studio-command.js";
import { attachStudio, detachStudio, setTelemetryState, telemetryState } from "./telemetry-export.js";
import { formatTaskLedger } from "./task-ledger.js";
import { saveLastModel } from "./model-preferences.js";
import { ratesFor } from "./rates.js";
import { formatUsd, projectStepCostUsd } from "./budget.js";
import { formatTokens } from "./tui/sidebar.js";

const REPL_HELP = renderCommandHelp();

const shellQuote = (value: string): string => `'${value.replace(/'/g, "'\\''")}'`;

const centeredOutput = (out: NodeJS.WriteStream): NodeJS.WriteStream => {
  if (!out.isTTY) return out;
  const width = out.columns ?? 80;
  const contentWidth = Math.min(100, Math.max(40, width - 8));
  const indent = " ".repeat(Math.max(0, Math.floor((width - contentWidth) / 2)));
  return new Proxy(out, {
    get(target, property) {
      if (property === "write") {
        return (...args: unknown[]) => {
          const chunk = args[0];
          if (typeof chunk === "string") {
            args[0] = chunk.replace(/[^\n]+/g, (line) => `${indent}${line}`);
          }
          return Reflect.apply(target.write, target, args);
        };
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as NodeJS.WriteStream;
};

/** A turn currently in flight that queued input can be steered into. */
type ActiveTurn = {
  steer(text: string): boolean;
};

/** Longest steer echo we print before truncating, so one paste cannot flood the TUI. */
const STEER_ECHO_LIMIT = 120;

const truncateForDisplay = (value: string): string =>
  value.length > STEER_ECHO_LIMIT ? `${value.slice(0, STEER_ECHO_LIMIT)}…` : value;

/**
 * Keep a half-typed steer message alive while the renderer paints.
 *
 * The renderer redraws its spinner with a carriage return + erase-line, which
 * would delete whatever the user had typed since the turn started. Every other
 * chunk is allowed through: readline owns the current line, and appending model
 * output to it is merely untidy, whereas erasing the input loses it entirely.
 */
export const protectTypedInput = (rl: readline.Interface) => (chunk: string): boolean => {
  if (chunk.startsWith("\r\u001b[2K") && rl.line.length > 0) {
    return false;
  }
  return true;
};

/** Render one turn to stdout: streamed text + one line per tool call. */
export const renderTurn = async (
  events: AsyncIterable<HarnessEvent>,
  out: NodeJS.WriteStream = process.stdout,
  getProviderStatus: () => string | null = () => null,
  getFileChanges: () => RenderableFileChange[] = () => [],
  /**
   * Called before every write. Return false to drop the chunk — the host uses
   * this to stop the renderer's spinner from erasing a steer message the user is
   * part-way through typing.
   */
  beforeWrite?: (chunk: string) => boolean,
): Promise<void> => {
  let textOpen = false;
  const terminalWidth = out.columns ?? 80;
  const contentWidth = Math.min(100, Math.max(40, terminalWidth - 8));
  const indentWidth = out.isTTY ? Math.max(0, Math.floor((terminalWidth - contentWidth) / 2)) : 0;
  const indent = " ".repeat(indentWidth);
  const write = (value: string): boolean => {
    if (beforeWrite && beforeWrite(value) === false) return true;
    return out.write(value);
  };
  const writeIndented = (value: string) => write(`${indent}${value}`);
  let responseBuffer = "";
  const writeResponseLine = (value: string) => {
    if (value.length === 0) {
      write("\n");
      return;
    }
    const chars = Array.from(value);
    let remaining = chars;
    while (remaining.length > contentWidth) {
      let splitAt = contentWidth;
      for (let index = contentWidth; index > 0; index -= 1) {
        if (/\s/.test(remaining[index - 1]!)) { splitAt = index - 1; break; }
      }
      if (splitAt === 0) splitAt = contentWidth;
      write(`${indent}${remaining.slice(0, splitAt).join("")}\n`);
      remaining = remaining.slice(splitAt);
      while (remaining.length > 0 && remaining[0] === " ") remaining = remaining.slice(1);
    }
    write(`${indent}${remaining.join("")}\n`);
  };
  const writeStreamText = (value: string) => {
    responseBuffer += value;
    while (true) {
      const newline = responseBuffer.indexOf("\n");
      if (newline >= 0) {
        writeResponseLine(responseBuffer.slice(0, newline).replace(/\r$/, ""));
        responseBuffer = responseBuffer.slice(newline + 1);
        continue;
      }
      const chars = Array.from(responseBuffer);
      if (chars.length <= contentWidth) break;
      let splitAt = contentWidth;
      for (let index = contentWidth; index > 0; index -= 1) {
        if (/\s/.test(chars[index - 1]!)) { splitAt = index - 1; break; }
      }
      if (splitAt === 0) splitAt = contentWidth;
      writeResponseLine(chars.slice(0, splitAt).join(""));
      responseBuffer = chars.slice(splitAt).join("").replace(/^ +/, "");
    }
  };
  let spinnerLabel = "";
  let renderedChanges = 0;
  // Consecutive identical tool calls collapse into one line plus an ×N tally.
  let repeatLabel: string | null = null;
  let repeatCount = 0;
  const flushRepeats = () => {
    if (repeatCount > 1 && repeatLabel) {
      writeIndented(`  ${c.dim(`└ ${repeatLabel} \u00d7${repeatCount}`)}\n`);
    }
    repeatLabel = null;
    repeatCount = 0;
  };
  let spinnerFrame = 0;
  let spinnerVisible = false;
  const spinnerFrames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  const canAnimate = Boolean(out.isTTY);
  const clearSpinner = () => {
    if (!spinnerVisible) return;
    write("\r\u001b[2K\n");
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
    write(`\r\u001b[2K${indent}${c.cyan(spinnerFrames[spinnerFrame % spinnerFrames.length]!)} ${c.dim(label)}`);
    spinnerFrame += 1;
    spinnerVisible = true;
  };
  const nl = () => {
    clearSpinner();
    if (textOpen) {
      writeResponseLine(responseBuffer);
      responseBuffer = "";
      textOpen = false;
    }
  };
  const renderNewChanges = () => {
    const changes = getFileChanges();
    while (renderedChanges < changes.length) {
      const change = changes[renderedChanges++]!;
      nl();
      spinnerLabel = "";
      for (const line of formatFileChange(change)) writeIndented(`${line}\n`);
      write("\n");
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
    renderNewChanges();
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
      case "tool-call": {
        const label = toolLabel(e.toolName, e.input);
        if (label === repeatLabel) {
          repeatCount += 1;
          startSpinner(`running ${label}`);
          break;
        }
        flushRepeats();
        nl();
        repeatLabel = label;
        repeatCount = 1;
        writeIndented(`  ${c.cyan("◆")} ${c.bold(label)}\n`);
        startSpinner(`running ${label}`);
        break;
      }
      case "tool-result": {
        clearSpinner();
        spinnerLabel = "";
        flushRepeats();
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
        flushRepeats();
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

export const setActiveModel = (state: SessionState, model: SessionState["model"]): void => {
  state.model?.setStatusHandler();
  state.model = model;
  state.providerStatus = null;
  model?.setStatusHandler((status) => { state.providerStatus = status; });
};

/**
 * Copy the per-step figures a status panel needs onto the state.
 *
 * Both frontends call this for every event, and it has to be one function rather
 * than two: the readline footer and the TUI sidebar read the same fields, and a
 * handler wired into only one of them means the other shows zeros forever. That
 * is exactly what happened — the TUI consumed the event stream directly, so
 * `contextUsedTokens` stayed 0 in the panel *and* in the per-turn budget that
 * reads it.
 */
export const applyUsageEvent = (state: SessionState, event: HarnessEvent): void => {
  if (event.type !== "step-finish") {
    if (event.type === "finish" || event.type === "error") state.providerStatus = null;
    return;
  }
  /**
   * Context size comes from `event.request`, not `event.usage`.
   *
   * `usage` accumulates across every step of the run, so its `inputTokens` is
   * the total spent, not what is in the window. Reading it as the context made a
   * 30k-token session display as though it were carrying 270k — the two differ by
   * the number of steps, which is exactly the quantity the panel exists to help
   * you reason about.
   */
  state.contextUsedTokens = event.request.totalInputTokens;
  state.lastOutputTokens = event.usage.outputTokens;
  state.contextUsageEstimated = event.usage.estimated === true;
  state.cacheHitRate = event.request.hitRate;
};

const withStatusUpdates = async function* (
  events: AsyncIterable<HarnessEvent>,
  state: SessionState,
): AsyncIterable<HarnessEvent> {
  for await (const event of events) {
    applyUsageEvent(state, event);
    yield event;
  }
};

const renderStatusPrompt = (state: SessionState): string => {
  const format = (value: number): string =>
    value >= 1_000_000 ? `${(value / 1_000_000).toFixed(1)}m` : value >= 1_000 ? `${(value / 1_000).toFixed(1)}k` : String(value);
  const providerModel = state.model
    ? `${state.model.provider} · ${state.model.modelId}`
    : "model not configured";
  const statusParts = [
    c.dim(`↑${format(state.totalUsage.inputTokens)} ↓${format(state.totalUsage.outputTokens)} tokens`),
    c.dim(`ctx ${state.contextUsageEstimated ? "~" : ""}${format(state.contextUsedTokens)} used`),
    c.dim(`usage ${format(state.totalUsage.totalTokens)} total`),
    c.cyan(providerModel),
    c.magenta(`mode ${state.permissions} · interactive`),
  ];
  const terminalWidth = process.stdout.columns ?? 80;
  const contentWidth = Math.min(100, Math.max(40, terminalWidth - 8));
  const plainLength = (value: string) => value.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "").length;
  const separator = c.dim("  │  ");
  const rows: string[] = [];
  let row = "";
  for (const part of statusParts) {
    const candidate = row ? `${row}${separator}${part}` : part;
    if (row && plainLength(candidate) > contentWidth) {
      rows.push(row);
      row = part;
    } else {
      row = candidate;
    }
  }
  if (row) rows.push(row);
  const center = (value: string) => {
    const left = Math.max(0, Math.floor((terminalWidth - plainLength(value)) / 2));
    return `${" ".repeat(left)}${value}`;
  };
  const responseIndent = " ".repeat(Math.max(0, Math.floor((terminalWidth - contentWidth) / 2)));
  const cursor = `${responseIndent}${c.magenta("❯")} `;
  const prompt = [...rows.map(center), cursor].join("\n");
  return prompt.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, (ansi) => `\u0001${ansi}\u0002`);
};

const providerIds: BuiltinProvider[] = ["anthropic", "openai", "openrouter"];

export const setupProvider = async (
  state: SessionState,
  requested: string,
  out: NodeJS.WriteStream,
): Promise<void> => {
  let providerName = requested.trim().toLowerCase();
  if (!providerName) {
    // `process.stdout`, not `out`: the TUI calls this with a transcript sink,
    // which is not a stream and makes readline throw on `output.on`. The
    // exclusive path has released the terminal, so the prompt belongs on stdout.
    const prompt = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: Boolean(process.stdin.isTTY),
    });
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


/** One row per branch: the base transcript plus every named sibling. */
const listBranches = async (
  state: SessionState,
  cwd: string,
): Promise<Array<{ name: string; path: string; active: boolean; messages: number; modified: number }>> => {
  const base = state.sessionBasePath ?? defaultSessionFile(cwd);
  const stem = base.replace(/\.jsonl$/, "");
  const parent = nodePath.dirname(stem);
  const prefix = `${nodePath.basename(stem)}.`;
  const { createJsonlSessionStore } = await import("not-another-harness");

  const collect = async (name: string, path: string) => {
    let modified = 0;
    try {
      modified = (await fs.stat(path)).mtimeMs;
    } catch {
      modified = 0;
    }
    return {
      name,
      path,
      active: state.store?.path === path,
      messages: (await createJsonlSessionStore(path).load()).length,
      modified,
    };
  };

  const rows = [await collect("main", base)];
  for (const file of (await fs.readdir(parent)).sort()) {
    if (file.startsWith(prefix) && file.endsWith(".jsonl")) {
      rows.push(await collect(file.slice(prefix.length, -".jsonl".length), nodePath.join(parent, file)));
    }
  }
  return rows;
};

const renderBranches = (rows: Array<{ name: string; active: boolean; messages: number; modified: number }>) => {
  if (rows.length === 1 && rows[0]!.messages === 0) {
    return "(no branches yet — /branch <name> forks one)\n";
  }
  const lines = [`${c.bold("Branches")}`];
  for (const row of rows) {
    const active = row.active ? c.green(" · active") : "";
    const when = row.modified ? c.dim(new Date(row.modified).toLocaleString()) : c.dim("never");
    const size = c.dim(`${row.messages} msg${row.messages === 1 ? "" : "s"}`);
    lines.push(`  ${row.active ? c.magenta("❯") : " "} ${row.name}${active}  ${size}  ${when}`);
  }
  lines.push(c.dim("Switch with: /branch <name>   ·   back to the original: /branch main"));
  return `${lines.join("\n")}\n`;
};

export const handleSlashCommand = async (
  input: string,
  state: SessionState,
  cwd: string,
  out: NodeJS.WriteStream = process.stdout,
): Promise<SlashResult> => {
  out = centeredOutput(out);
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
        // The counters described the transcript just discarded.
        await resetUsage(state);
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
    case "budget": {
      /**
       * Show what this session has cost, and let a ceiling be set.
       *
       * There is no ceiling to show by default, so the bare form reports spend and
       * says what the bounds on a turn actually are. Setting one is opt-in; the
       * previous version computed a number nobody chose and stopped turns at it
       * mid-task, which is the whole reason this is now empty by default.
       */
      const rates = state.model ? ratesFor(state.model.modelId) : null;
      if (arg === "off" || arg === "none") {
        state.turnSpendLimitUsd = null;
        out.write(c.dim("(no per-turn ceiling — a turn runs until the task is done)\n"));
        return "handled";
      }
      if (arg) {
        const parsed = Number.parseFloat(arg);
        if (!Number.isFinite(parsed) || parsed <= 0) {
          out.write(c.red(`not a dollar amount: ${arg}\n`));
          return "handled";
        }
        state.turnSpendLimitUsd = parsed;
        out.write(c.dim(`(per-turn ceiling: ${formatUsd(parsed)} — this turn will stop there)\n`));
        return "handled";
      }
      const lines = [
        `${formatUsd(state.spendUsd)} spent this session`,
        state.turnSpendLimitUsd === null
          ? "no per-turn ceiling — turns run until the task is done"
          : `${formatUsd(state.turnSpendLimitUsd)} per-turn ceiling`,
        `context ${formatTokens(state.contextUsedTokens)}` +
          (rates
            ? ` · next step ≈ ${formatUsd(
                projectStepCostUsd(state.contextUsedTokens, state.cacheHitRate, rates),
              )} at ${Math.round(state.cacheHitRate * 100)}% cached`
            : ""),
        c.dim("/budget <usd> to cap a turn · /budget off to remove the cap"),
      ];
      out.write(`${lines.join("\n")}\n`);
      return "handled";
    }
    case "steps": {
      /**
       * Cap a turn's steps, off by default.
       *
       * There is no ceiling unless this is set, and that is deliberate: a step
       * counter bounds long tasks and ignores short ones, so it cuts the work you
       * cared about while leaving the work you didn't. What ends a turn instead is
       * the model saying it is done, the window filling, or you interrupting. If
       * you want one anyway — an unattended run, a script — set it here rather
       * than editing the harness default.
       */
      if (arg === "off" || arg === "none" || arg === "") {
        if (arg === "") {
          out.write(
            state.turnStepLimit === null
              ? "no per-turn step ceiling — a turn runs until the task is done\n"
              : `${state.turnStepLimit} step ceiling per turn\n`,
          );
          out.write(c.dim("/steps <n> to cap a turn · /steps off to remove the cap\n"));
          return "handled";
        }
        state.turnStepLimit = null;
        out.write(c.dim("(no per-turn step ceiling — turns run until the task is done)\n"));
        return "handled";
      }
      const parsed = Number.parseInt(arg, 10);
      if (!Number.isFinite(parsed) || parsed < 1) {
        out.write(c.red(`not a step count: ${arg}\n`));
        return "handled";
      }
      state.turnStepLimit = parsed;
      out.write(c.dim(`(per-turn ceiling: ${parsed} steps — a turn will stop there)\n`));
      return "handled";
    }
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
      const diff = await state.workspace.exec("git diff --no-ext-diff --no-color --unified=3 HEAD --", { timeoutSeconds: 15 });
      const statusItems = status.stdout.split("\0").filter(Boolean);
      const untracked = statusItems.filter((item) => item.startsWith("?? ")).slice(0, 20);
      const untrackedDiffs: string[] = [];
      for (const item of untracked) {
        const file = item.slice(3);
        const result = await state.workspace.exec(`git diff --no-index --no-color -- /dev/null ${shellQuote(file)}`, { timeoutSeconds: 10 });
        if (result.stdout.trim()) untrackedDiffs.push(result.stdout);
      }
      const summary = statusItems.map((item) => item.slice(0, 2) + " " + item.slice(3)).join("\n");
      const patch = [diff.stdout.trim(), ...untrackedDiffs].filter(Boolean).join("\n\n");
      const formatted = summary || patch ? formatWorkspaceDiff(summary, patch).join("\n") : "";
      out.write(formatted ? `${formatted.slice(0, 24_000)}${formatted.length > 24_000 ? "\n[diff truncated at 24 KB]" : ""}\n` : c.dim("(no Git changes found)\n"));
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
      if (!state.sessionBasePath && !state.store) {
        out.write(c.dim("(session persistence is off)\n"));
        return "handled";
      }
      try {
        out.write(renderBranches(await listBranches(state, cwd)));
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
      if (!arg) {
        try {
          out.write(renderBranches(await listBranches(state, cwd)));
        } catch (e) {
          out.write(c.red(`could not list branches: ${e instanceof Error ? e.message : String(e)}\n`));
        }
        return "handled";
      }
      if (!/^[a-zA-Z0-9_-]{1,48}$/.test(arg)) {
        out.write(c.red("usage: /branch <1-48 character name using letters, numbers, _ or ->\n"));
        return "handled";
      }
      try {
        if (arg === "main") {
          const { createJsonlSessionStore } = await import("not-another-harness");
          const store = createJsonlSessionStore(state.sessionBasePath);
          state.store = store;
          state.messages = await store.load();
          state.taskLedger = await store.loadTaskLedger();
          state.undoHistory = [];
          await adoptUsage(state);
          out.write(`${c.green("switched")} → main ${c.dim(`${state.messages.length} messages`)}\n`);
          state.onSessionSwitch?.(state.messages);
          return "handled";
        }
        const base = state.sessionBasePath.replace(/\.jsonl$/, "");
        const destination = `${base}.${arg}.jsonl`;
        try {
          await fs.access(destination);
          const { createJsonlSessionStore } = await import("not-another-harness");
          const store = createJsonlSessionStore(destination);
          const messages = await store.load();
          if (messages.length === 0) throw new Error("branch file exists but has no active transcript");
          state.store = store;
          state.messages = messages;
          state.taskLedger = await store.loadTaskLedger();
          state.undoHistory = [];
          await adoptUsage(state);
          out.write(`${c.green("switched")} → ${arg} ${c.dim(`${messages.length} messages`)}\n`);
          state.onSessionSwitch?.(state.messages);
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
          const forked = await state.store.fork(destination);
          const restored = await forked.load();
          state.store = forked;
          state.messages = restored;
          state.taskLedger = await forked.loadTaskLedger();
          state.undoHistory = [];
          // The fork inherits the parent's transcript, so it inherits its spend.
          await adoptUsage(state);
          out.write(`${c.yellow("created")} branch ${arg} ${c.dim(`from ${restored.length} carried message(s)`)}\n`);
          out.write(c.dim(`  /branch main returns you · /branches lists them\n`));
          state.onSessionSwitch?.(state.messages);
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
    case "mode":
    case "permissions": {
      if (!arg) {
        out.write(c.dim(`mode: ${state.permissions}\n`));
        return "handled";
      }
      const mode = parsePermissionMode(arg);
      if (!mode) {
        out.write(c.red("usage: /mode ask|yolo|readonly (or /permissions ask|yolo|readonly)") + "\n");
        return "handled";
      }
      state.permissions = mode;
      out.write(c.dim(`mode → ${mode}\n`));
      return "handled";
    }
    case "session": {
      if (!arg || arg === "list") {
        const directory = nodePath.dirname(defaultSessionFile(cwd));
        try {
          const sessions = (await listSessionIds(cwd)).map((session) => ({
            ...session,
            active: state.store?.path === nodePath.join(directory, `${session.id}.jsonl`),
          }));
          const available = sessions;
          if (!available.length) {
            out.write(c.dim("(no saved sessions for this directory)\n"));
          } else {
            out.write(`${c.bold("Sessions for this directory")}\n`);
            for (const session of available) {
              const active = session.active ? c.green(" · active") : "";
              out.write(`${session.id}${active}  ${c.dim(new Date(session.modified).toLocaleString())}\n`);
            }
            out.write(c.dim("Switch with: /session <id>\n"));
          }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") out.write(c.dim("(no saved sessions for this directory)\n"));
          else out.write(c.red(`could not list sessions: ${error instanceof Error ? error.message : String(error)}\n`));
        }
        return "handled";
      }
      if (arg === "off") {
        state.store = null;
        out.write(c.dim("(session persistence off for this process)\n"));
        return "handled";
      }
      {
        // `/session <id|path>` switches without leaving the running agent, using
        // the same resolution as `--session` so both entry points agree.
        const { createJsonlSessionStore } = await import("not-another-harness");
        const target = resolveSessionFile(cwd, arg);
        const known = (await listSessionIds(cwd)).map((session) => session.id);
        const isKnown = known.includes(nodePath.basename(target, ".jsonl"));

        let messages: typeof state.messages;
        try {
          messages = await createJsonlSessionStore(target).load();
        } catch (error) {
          out.write(
            c.red(`could not open ${arg}: ${error instanceof Error ? error.message : String(error)}\n`),
          );
          return "handled";
        }

        // An id we do not recognise almost always means a typo. Say so, and say
        // what does exist, rather than silently switching to an empty session.
        if (messages.length === 0 && !isKnown) {
          out.write(c.red(`no session "${arg}"${nodePath.isAbsolute(arg) ? "" : ` (${target})`}.\n`));
          if (known.length > 0) {
            out.write(c.dim(`  sessions here: ${known.join(", ")}\n`));
          } else {
            out.write(c.dim("  no saved sessions for this directory\n"));
          }
          return "handled";
        }

        state.store = createJsonlSessionStore(target);
        state.sessionBasePath = target;
        state.messages = messages;
        state.taskLedger = await state.store.loadTaskLedger();
        state.undoHistory = [];
        // Counters belong to the transcript that produced them. Carrying the
        // previous session's totals over made /stats describe a session that
        // was no longer on screen.
        await adoptUsage(state);
        const loaded = messages.length === 0
          ? c.dim("(that session is empty)")
          : c.dim(`${messages.length} message${messages.length === 1 ? "" : "s"} restored`);
        out.write(`${c.green("switched")} → ${nodePath.basename(target)} ${loaded}\n`);
        state.onSessionSwitch?.(state.messages);
        return "handled";
      }
      if (arg === "new") {
        const p = `${defaultSessionFile(cwd)}`.replace(/\.jsonl$/, `-${Date.now()}.jsonl`);
        const { createJsonlSessionStore } = await import("not-another-harness");
        state.store = createJsonlSessionStore(p);
        state.sessionBasePath = p;
        state.messages = [];
        state.taskLedger = null;
        state.undoHistory = [];
        await resetUsage(state);
        out.write(c.dim(`new session → ${p}\n`));
        state.onSessionSwitch?.(state.messages);
        return "handled";
      }
      out.write(c.dim("usage: /session [list | <id> | new | off]") + "\n");
      return "handled";
    }
    case "compact": {
      if (!state.model) {
        out.write(c.red("configure a model before compacting: set a provider API key, then use /model <provider:model-id>\n"));
        return "handled";
      }
      const { compactMessages } = await import("not-another-harness");
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
    case "memory": {
      if (!state.cognitiveMemory) {
        out.write(c.dim("(cognitive memory not active in this session)\n"));
        return "handled";
      }
      // One description, whichever backend is live. Reading it is a network call
      // when the answer is hosted, which is why this is awaited rather than
      // asking the engine for a snapshot directly.
      const description = await state.cognitiveMemory.describe();
      out.write(`${c.bold("Cognitive Memory Cache State")} ${c.dim(`(${description.backend})`)}\n`);
      out.write(`  Location: ${description.location}\n`);
      if (description.turnsProcessed !== null) {
        out.write(`  Turns processed: ${description.turnsProcessed}\n`);
      }
      out.write(`  Active tensions: ${description.activeTensions.length}\n`);
      out.write(`  L1 Hot cache items: ${description.counts.L1}\n`);
      out.write(`  L2 Warm store items: ${description.counts.L2}\n`);
      out.write(`  L3 Cold archive items: ${description.counts.L3}\n`);
      // A backend that is failing has to say so here, or `/memory` reports a
      // healthy-looking empty cache for a service that is simply unreachable.
      if (description.degraded) {
        out.write(`  ${c.yellow("Unreachable:")} ${description.degraded}\n`);
      }
      out.write("\n");

      // What memory actually cost each turn, and why. There is no public
      // benchmark for pre-inject vs on-demand here, so this is the signal for
      // tuning the budget and the trigger threshold.
      const log = state.memoryInjectionLog;
      if (log && log.entries.length > 0) {
        const summary = log.summary();
        out.write(`${c.bold("Prompt injection log")} ${c.dim("(what memory added, and why)")}\n`);
        out.write(
          `  ${summary.turns} turn(s) · avg ${summary.avgTokens} tokens · max ${summary.maxTokens}` +
            `${summary.truncatedTurns > 0 ? c.yellow(` · ${summary.truncatedTurns} truncated by budget`) : ""}\n`,
        );
        const reasons = Object.entries(summary.byReason)
          .map(([reason, count]) => `${reason}=${count}`)
          .join("  ");
        if (reasons) out.write(`  ${c.dim(reasons)}\n`);
        for (const turn of log.entries.slice(-5)) {
          out.write(`  ${c.dim(`turn ${turn.turn}:`)} ${turn.totalTokens} tokens\n`);
          for (const item of turn.items) {
            const body = item.hasBody ? c.green("body") : c.dim("index");
            out.write(`    ${body} ${c.dim(`[${item.reason}/${item.tier}]`)} ${item.gist.slice(0, 70)}\n`);
          }
        }
        out.write("\n");
      }

      if (description.held.length > 0) {
        out.write(`${c.bold("Memories held")} ${c.dim(`(${description.heldNote})`)}\n`);
        for (const item of description.held) {
          const domains = item.domains.slice(0, 3);
          const tag = domains.length > 0 ? c.dim(` (${domains.join(", ")})`) : "";
          out.write(`  • ${item.content}${tag}\n`);
        }
        out.write("\n");
      }

      if (description.activeTensions.length > 0) {
        out.write(`${c.bold("Unresolved Contradictions:")}\n`);
        for (const t of description.activeTensions) {
          out.write(`  🔴 ${c.yellow(`[${t.impact.toUpperCase()}]`)} ${t.id}: ${t.actionableQuestion}\n`);
        }
        out.write("\n");
      }

      if (description.domains.length > 0) {
        out.write(`${c.bold("Per-Domain Reliability:")}\n`);
        for (const { domain, reliability, samples } of description.domains) {
          const pct = Math.round(reliability * 100);
          const color = pct >= 80 ? c.green : pct >= 60 ? c.yellow : c.red;
          out.write(`  ${domain}: ${color(`${pct}%`)} reliability (${samples} tasks)\n`);
        }
      }
      return "handled";
    }
    case "tensions": {
      if (!state.cognitiveMemory) {
        out.write(c.dim("(cognitive memory not active in this session)\n"));
        return "handled";
      }
      if (arg.startsWith("resolve ")) {
        const tensionId = arg.slice("resolve ".length).trim();
        const ok = await state.cognitiveMemory.resolveTension(tensionId, {
          resolvedBy: "manual user resolution",
          pattern: "user resolved in repl",
        });
        if (ok) {
          out.write(c.green(`tension ${tensionId} marked resolved\n`));
        } else {
          // A hosted resolve can also fail because the service is unreachable, so
          // the reason is worth showing rather than a bare "not found".
          out.write(
            c.red(
              state.cognitiveMemory.degraded
                ? `could not resolve: ${state.cognitiveMemory.degraded}\n`
                : `tension ${tensionId} not found\n`,
            ),
          );
        }
        return "handled";
      }
      const active = (await state.cognitiveMemory.describe()).activeTensions;
      if (!active.length) {
        out.write(c.dim("(no unresolved contradictions)\n"));
      } else {
        out.write(`${c.bold("Unresolved Contradictions")}\n`);
        for (const t of active) {
          out.write(`  ${c.red("🔴")} ${c.bold(t.id)} ${c.dim(`[${t.impact}]`)}\n`);
          out.write(`     Claim A (${t.claimA.source}): "${t.claimA.statement}"\n`);
          out.write(`     Claim B (${t.claimB.source}): "${t.claimB.statement}"\n`);
          out.write(`     ${c.cyan("➜")} ${t.actionableQuestion}\n\n`);
        }
        out.write(c.dim("Resolve with: /tensions resolve <id>\n"));
      }
      return "handled";
    }
    case "studio":
      // Runs in the background and returns: it starts a process, so there is no
      // terminal to hand over and nothing for a full-screen path to release. The
      // endpoint file the command writes is what this session attaches to.
      await runStudioCommand(input, {
        cwd: state.cwd,
        out,
        confirm: confirmOnStdout,
      });
      // A Studio started mid-session should see the very next turn, not the next
      // one after a restart.
      const attached = await attachStudio(state);
      if (attached) out.write(c.dim("  this session is reporting there\n"));
      return "handled";
    case "telemetry": {
      const [wanted] = rest;
      const state0 = await telemetryState();
      if (!wanted || wanted === "status") {
        const endpoint = state.studio;
        out.write(
          c.dim(`  telemetry ${state0}\n`) +
            (endpoint
              ? `  ${c.dim("reporting to")} ${endpoint.endpoint.url} ${c.dim(`as ${endpoint.agent.name}`)}\n`
              : `  ${c.dim("no studio is running, so nothing is sent")}\n`),
        );
        return "handled";
      }
      if (wanted !== "on" && wanted !== "off") {
        out.write(c.red(`  /telemetry ${wanted} — expected on or off\n`));
        return "handled";
      }
      await setTelemetryState(wanted);
      if (wanted === "off") {
        detachStudio(state);
        out.write(c.dim("  off — this session stops reporting\n"));
        return "handled";
      }
      const attached = await attachStudio(state);
      out.write(
        attached
          ? c.green("  on") + c.dim(` — reporting to ${attached.endpoint.url} as ${attached.agent.name}\n`)
          : c.yellow("  on") + c.dim(" — but no studio is running, so nothing is sent yet\n"),
      );
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
  // A memory backend that is not the one the config asked for has to be said out
  // loud at startup. Otherwise "hosted memory is on" and a local store are
  // indistinguishable until a fact fails to survive a restart.
  if (state.memoryNote) out.write(`${c.dim(`memory: ${state.memoryNote}`)}\n`);
  let abort: AbortController | null = null;
  let activeRl: readline.Interface | null = null;
  /** The turn currently streaming, if any. Input steers it instead of queueing. */
  let activeTurn: ActiveTurn | null = null;
  const deferredCommands: string[] = [];
  const renderSteerPrompt = () => c.dim("steer › ");
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
      let openCogmemSetup = false;
      let cogmemRequest = "";
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
            // Mid-turn, the background task owns the prompt; re-prompting here
            // would race it and leave two prompts on screen.
            if (!activeTurn) rl.prompt();
            continue;
          }
          // Steering takes precedence over every other interpretation of the
          // line. A turn is already in flight, so this line belongs to it:
          // steering never interrupts the model call currently streaming — the
          // message lands at the next step boundary.
          if (activeTurn) {
            if (input.startsWith("/")) {
              // Slash commands act on settled session state (and some of them
              // tear down the reader), so hold them until the turn finishes.
              deferredCommands.push(input);
              continue;
            }
            if (activeTurn.steer(input)) {
              out.write(c.dim(`  ↳ steering: ${truncateForDisplay(input)}\n`));
              continue;
            }
            // The run settled between this line arriving and the steer call, so
            // there is nowhere to deliver it. Treat it as a fresh prompt.
            activeTurn = null;
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
          if (input === "/cogmem" || input.startsWith("/cogmem ")) {
            openCogmemSetup = true;
            cogmemRequest = input.slice("/cogmem".length).trim();
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
          // Memory first, and awaited here rather than inside `runTurn`: the
          // hosted backend has to answer before the request can be composed. A
          // backend that is slow costs a moment of silence; one that is down
          // costs nothing, because `resolveInjection` contains the failure.
          const injection = await resolveInjection(state, prompt);
          const turn = runTurn(state, prompt, { signal: abort.signal }, injection);
          const turnFileChanges = state.activeFileChanges ?? [];
          const turnRef: ActiveTurn = { steer: (text) => turn.steer(text) };
          activeTurn = turnRef;
          // Make the affordance visible: typing now steers this turn.
          rl.setPrompt(renderSteerPrompt());
          rl.prompt();

          // Render and run in the background so this loop keeps reading lines.
          void (async () => {
            try {
              await renderTurn(
                withStatusUpdates(turn.events, state),
                out,
                () => state.providerStatus,
                () => turnFileChanges,
                protectTypedInput(rl),
              );
              await turn.done;
            } catch (e) {
              out.write(c.red(e instanceof Error ? e.message : String(e)) + "\n");
            } finally {
              abort = null;
              if (activeTurn === turnRef) {
                activeTurn = null;
              }
              // Commands typed mid-turn act on the now-settled session.
              while (keepRunning && deferredCommands.length > 0) {
                const deferred = deferredCommands.shift()!;
                if ((await handleSlashCommand(deferred, state, state.cwd, out)) === "quit") {
                  keepRunning = false;
                }
              }
              out.write("\n");
              rl.setPrompt(renderStatusPrompt(state));
              rl.prompt();
            }
          })();
        }
      } finally {
        rl.close();
        activeRl = null;
        // A turn may still be streaming; let it finish cleanly rather than
        // leaving an orphaned agent mutating files after the UI is gone.
        if (activeTurn) {
          activeTurn = null;
          abort?.abort();
        }
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
      if (openCogmemSetup) {
        // `status` only reads, so it is worth allowing without a terminal: it is
        // the one subcommand someone might want from a pipe.
        const readOnly = /^(status)?$/i.test(cogmemRequest);
        if (!process.stdin.isTTY && !readOnly) {
          out.write(c.red("Cogmem setup needs an interactive terminal. /cogmem status still works.\n"));
          continue;
        }
        await handleCogmemCommand({ state, out }, cogmemRequest);
        continue;
      }
      if (!receivedInput) keepRunning = false;
    }
  } finally {
    process.off("SIGINT", onSigint);
    activeRl?.close();
  }
  if (!state.store) {
    out.write(c.dim("You left NAH. Session persistence is off, so this session cannot be resumed.\n"));
  } else {
    const activePath = nodePath.resolve(state.store.path);
    const defaultFile = defaultSessionFile(state.cwd);
    const sessionPrefix = nodePath.basename(defaultFile, ".jsonl");
    const activeId = nodePath.basename(activePath, ".jsonl");
    const reference = nodePath.dirname(activePath) === nodePath.dirname(defaultFile) &&
      (activeId === sessionPrefix || activeId.startsWith(`${sessionPrefix}-`) || activeId.startsWith(`${sessionPrefix}.`))
      ? activeId
      : shellQuote(activePath);
    out.write(`You left NAH. Resume your session with: nah --session ${reference}\n`);
  }
};

/** Build a fresh session state (shared by print/json/interactive modes). */
