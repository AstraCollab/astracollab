/** Minimal ANSI helpers (respect NO_COLOR / dumb terminals), zero deps. */
const enabled =
  !process.env.NO_COLOR && process.env.TERM !== "dumb" && process.stdout.isTTY !== false;

const wrap = (open: string, close: string) => (s: string) =>
  enabled ? `${open}${s}${close}` : s;

export const c = {
  added: wrap("\u001b[38;5;114m", "\u001b[39m"),
  removed: wrap("\u001b[38;5;203m", "\u001b[39m"),
  hunk: wrap("\u001b[38;5;141m", "\u001b[39m"),
  /** Structure colour: headings, bullets, rules. Distinct from UI chrome. */
  purple: wrap("\u001b[38;5;141m", "\u001b[39m"),
  dim: wrap("[2m", "[0m"),
  bold: wrap("[1m", "[0m"),
  cyan: wrap("[36m", "[0m"),
  green: wrap("[32m", "[0m"),
  yellow: wrap("[33m", "[0m"),
  red: wrap("[31m", "[0m"),
  italic: wrap("\u001b[3m", "\u001b[23m"),
  strikethrough: wrap("\u001b[9m", "\u001b[29m"),
  underline: wrap("\u001b[4m", "\u001b[24m"),
  magenta: wrap("[35m", "[0m"),
};

const faint = (s: string) => wrap("\u001b[38;5;244m", "\u001b[39m")(s);
const dark = (s: string) => wrap("\u001b[30;1m", "\u001b[39m")(s);
export const stripAnsi = (s: string): string => s.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "");

export const renderWelcome = (opts: {
  cwd: string;
  model: string | null;
  permissions: string;
  sandbox?: string;
}): string => {
  const width = Math.max(40, process.stdout.columns ?? 80);
  const rows = Math.max(16, process.stdout.rows ?? 24);
  const clip = (value: string, max: number) => value.length > max ? `${value.slice(0, max - 1)}…` : value;
  const center = (text: string) => {
    const visibleLength = stripAnsi(text).length;
    const pad = Math.max(0, Math.floor((width - visibleLength) / 2));
    return `${" ".repeat(pad)}${text}`;
  };
  if (process.stdout.isTTY === false) {
    return [
      `${c.cyan("◈")} ${dark("nah")} ${faint("/ not another harness")}`,
      faint(`${opts.sandbox ?? opts.cwd} · ${opts.model ?? "not configured"} · ${opts.permissions}`),
      faint("Ask for a change, or type /help for commands. Ctrl+C to exit."),
      "",
    ].join("\n");
  }
  const top = Math.max(2, Math.floor((rows - 14) / 2));
  const put = (row: number, text: string) => `\u001b[${row};1H${center(text)}\u001b[0m`;
  const lines = [
    put(top, `${c.cyan("◈")} ${dark("nah")}`),
    put(top + 2, faint("NOT ANOTHER HARNESS")),
    put(top + 4, dark("An agent that works directly in your codebase.")),
    put(top + 6, faint(clip(opts.sandbox ?? opts.cwd, Math.max(12, width - 8)))),
    put(top + 7, faint(`${opts.model ?? "choose a model with /model"}  ·  ${opts.permissions} permissions`)),
    put(rows - 2, faint("/model  choose model     /help  commands     Ctrl+C  exit")),
    `\u001b[${top + 9};1H`,
  ];
  return `\u001b[2J\u001b[H${lines.join("")}`;
};

/** Tool-call → one-line label (mirrors the harness's Ui discipline). */
/** `delegate_task` → `delegate task`; used for any tool without a mapping. */
const humanize = (toolName: string): string => toolName.replace(/_/g, " ");

export const toolLabel = (toolName: string, input: unknown): string => {
  const args = (input ?? {}) as Record<string, unknown>;
  const path = typeof args.path === "string" ? args.path : "";
  const clip = (s: string, n = 50): string => (s.length > n ? `${s.slice(0, n)}…` : s);
  switch (toolName) {
    case "read":
      return `read ${path}${args.offset ? `:${args.offset}` : ""}`;
    case "list":
      return `list ${path || "."}`;
    case "glob":
      return `glob ${typeof args.pattern === "string" ? clip(args.pattern) : ""}`.trimEnd();
    case "grep":
      return `grep ${typeof args.pattern === "string" ? clip(args.pattern) : ""}`.trimEnd();
    case "edit":
      return `edit ${path} · ${args.replace_all === true ? "replace all" : "replace"} ${clip(JSON.stringify(args.old_string ?? ""), 26)} → ${clip(JSON.stringify(args.new_string ?? ""), 26)}`;
    case "write":
      return `write ${path}`;
    case "bash":
      return `$ ${typeof args.command === "string" ? clip(args.command) : ""}`;
    case "delegate_task":
      return `delegate in isolated worktree: ${typeof args.title === "string" ? clip(args.title) : "task"}`;
    // Bookkeeping, not exploration: show the verb so the transcript reads as
    // intent ("find checks", "save plan") instead of a bare tool name repeated.
    case "task_ledger": {
      const action = typeof args.action === "string" ? args.action : "";
      switch (action) {
        case "discover_checks":
          return "find executable checks";
        case "plan":
          return "save plan";
        case "step": {
          const id = typeof args.id === "string" ? args.id : "?";
          const status = typeof args.status === "string" ? args.status : "";
          return `plan · ${id}${status ? ` → ${status}` : ""}`;
        }
        case "run_check":
          return `run check ${typeof args.id === "string" ? args.id : "?"}`;
        default:
          return `plan · ${action || "update"}`;
      }
    }
    default:
      return humanize(toolName);
  }
};

/**
 * Tools whose success needs no result line.
 *
 * The call itself (`◆ read src/app.ts`) already says what happened; echoing the
 * body back just doubles the noise. Errors are always surfaced.
 */
const QUIET_ON_SUCCESS = new Set(["read", "list", "glob", "grep", "task_ledger"]);

export type ToolResultSummary = { show: boolean; text: string };

/**
 * One short line describing what a tool call achieved, instead of dumping the
 * tool's full reply. `task_ledger` in particular returned several paragraphs per
 * call, which buried the actual work in the transcript.
 */
export const summarizeToolResult = (
  toolName: string,
  input: unknown,
  output: string,
  isError: boolean,
): ToolResultSummary => {
  const args = (input ?? {}) as Record<string, unknown>;

  if (toolName === "task_ledger") {
    if (isError) return { show: true, text: output.split("\n")[0] ?? "failed" };
    const action = typeof args.action === "string" ? args.action : "";
    const found = output.match(/^- (.+)$/gm);
    if (action === "discover_checks" && found) {
      return { show: true, text: `${found.length} check${found.length === 1 ? "" : "s"} found` };
    }
    if (action === "plan") return { show: true, text: "plan saved" };
    if (action === "run_check") {
      const status = output.match(/\bexit code (\d+)\b|\b(exit \d+|passed|failed)\b/i)?.[0];
      return { show: true, text: status ? `check ${String(args.id ?? "")} ${status}`.trim() : "check ran" };
    }
    const updated = output.match(/^([\w.-]+)\s+(→|->)\s*(\w+)/m);
    if (updated) return { show: true, text: `${updated[1]} → ${updated[3]}` };
    return { show: false, text: "" };
  }

  if (isError) {
    return { show: true, text: output.split("\n")[0] ?? "failed" };
  }
  if (QUIET_ON_SUCCESS.has(toolName)) {
    return { show: false, text: "" };
  }

  const first = output.split("\n").find((line) => line.trim().length > 0);
  if (!first) return { show: false, text: "" };
  return { show: true, text: first.length > 120 ? `${first.slice(0, 120)}…` : first };
};

export type RenderableFileChange = {
  path: string;
  existed: boolean;
  content?: string;
  after: string;
};

type DiffLine = { kind: "context" | "added" | "removed"; text: string };

const buildDiffLines = (before: string, after: string): DiffLine[] => {
  const oldLines = before.split("\n");
  const newLines = after.split("\n");
  const columns = newLines.length + 1;
  if (oldLines.length * newLines.length > 120_000) {
    let prefix = 0;
    while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) prefix += 1;
    let suffix = 0;
    while (
      suffix < oldLines.length - prefix &&
      suffix < newLines.length - prefix &&
      oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
    ) suffix += 1;
    return [
      ...oldLines.slice(Math.max(0, prefix - 3), prefix).map((text) => ({ kind: "context" as const, text })),
      ...oldLines.slice(prefix, oldLines.length - suffix).map((text) => ({ kind: "removed" as const, text })),
      ...newLines.slice(prefix, newLines.length - suffix).map((text) => ({ kind: "added" as const, text })),
      ...oldLines.slice(oldLines.length - suffix, oldLines.length - suffix + 3).map((text) => ({ kind: "context" as const, text })),
    ];
  }

  const table = new Uint32Array((oldLines.length + 1) * columns);
  for (let i = oldLines.length - 1; i >= 0; i -= 1) {
    for (let j = newLines.length - 1; j >= 0; j -= 1) {
      const index = i * columns + j;
      table[index] = oldLines[i] === newLines[j]
        ? table[(i + 1) * columns + j + 1]! + 1
        : Math.max(table[(i + 1) * columns + j]!, table[index + 1]!);
    }
  }
  const lines: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < oldLines.length || j < newLines.length) {
    if (i < oldLines.length && j < newLines.length && oldLines[i] === newLines[j]) {
      lines.push({ kind: "context", text: oldLines[i]! });
      i += 1;
      j += 1;
    } else if (
      i < oldLines.length &&
      (j >= newLines.length || table[(i + 1) * columns + j]! >= table[i * columns + j + 1]!)
    ) {
      lines.push({ kind: "removed", text: oldLines[i]! });
      i += 1;
    } else {
      lines.push({ kind: "added", text: newLines[j]! });
      j += 1;
    }
  }
  return lines;
};

export const formatFileChange = (change: RenderableFileChange): string[] => {
  const before = change.existed ? change.content ?? "" : "";
  const diff = buildDiffLines(before, change.after);
  const added = diff.filter((line) => line.kind === "added").length;
  const removed = diff.filter((line) => line.kind === "removed").length;
  const visibleIndexes = new Set<number>();
  const changedIndexes = diff.flatMap((line, index) => line.kind === "context" ? [] : [index]);
  for (const index of changedIndexes) {
    for (let i = Math.max(0, index - 3); i <= Math.min(diff.length - 1, index + 3); i += 1) visibleIndexes.add(i);
  }
  const lines = [
    `${c.cyan("◆")} ${c.bold(change.path)} ${faint(`${added} additions · ${removed} removals`)}`,
    faint("  ┌─────┬─────┬────────────────────────────────────────────────────────"),
  ];
  let oldLine = 1;
  let newLine = 1;
  const lineNumbers = diff.map((line) => {
    const result = { old: line.kind === "added" ? "" : String(oldLine), next: line.kind === "removed" ? "" : String(newLine) };
    if (line.kind !== "added") oldLine += 1;
    if (line.kind !== "removed") newLine += 1;
    return result;
  });
  let previous = -1;
  for (const index of [...visibleIndexes].sort((a, b) => a - b)) {
    if (previous >= 0 && index > previous + 1) lines.push(c.dim("  │ …"));
    const line = diff[index]!;
    const oldNumber = lineNumbers[index]!.old;
    const newNumber = lineNumbers[index]!.next;
    const marker = line.kind === "added" ? c.added("+") : line.kind === "removed" ? c.removed("−") : c.dim("│");
    const value = line.text.slice(0, 220);
    const text = line.kind === "added" ? c.added(value) : line.kind === "removed" ? c.removed(value) : value;
    lines.push(`  ${c.dim(oldNumber.padStart(4))} ${c.dim(newNumber.padStart(4))} ${marker} ${text}`);
    previous = index;
  }
  if (changedIndexes.length === 0) lines.push(c.dim("  │ no textual changes"));
  lines.push(faint("  └─────┴─────┴────────────────────────────────────────────────────────"));
  if (lines.length > 124) {
    return [...lines.slice(0, 120), c.dim(`  │ … ${lines.length - 120} more diff lines`)];
  }
  return lines;
};

/** Render a compact file overview and color-coded unified hunks for /diff. */
export const formatWorkspaceDiff = (summary: string, patch: string): string[] => {
  const files = summary.split("\n").filter(Boolean).slice(0, 80);
  const patchLines = patch.split("\n");
  const stats = new Map<string, { added: number; removed: number }>();
  let currentFile = "";
  for (const line of patchLines) {
    if (line.startsWith("+++ b/")) {
      currentFile = line.slice(6);
      if (!stats.has(currentFile)) stats.set(currentFile, { added: 0, removed: 0 });
    } else if (currentFile && line.startsWith("+") && !line.startsWith("+++")) stats.get(currentFile)!.added += 1;
    else if (currentFile && line.startsWith("-") && !line.startsWith("---")) stats.get(currentFile)!.removed += 1;
  }
  const values = [...stats.values()];
  const additions = values.reduce((sum, value) => sum + value.added, 0);
  const removals = values.reduce((sum, value) => sum + value.removed, 0);
  const output = [`${c.bold("Workspace changes")} ${faint(`${files.length} files`)}  ${c.added(`+${additions}`)} ${c.removed(`−${removals}`)}`];
  if (files.length) {
    output.push(faint("  FILES"));
    for (const entry of files) {
      const path = entry.slice(3);
      const count = stats.get(path);
      output.push(`  ${c.cyan("›")} ${path}${count ? `  ${c.added(`+${count.added}`)} ${c.removed(`−${count.removed}`)}` : ""}`);
    }
  }
  let oldLine = 0;
  let newLine = 0;
  for (const line of patchLines) {
    if (line.startsWith("diff --git ")) {
      const path = line.split(" b/")[1] ?? "unknown";
      output.push("", `${c.cyan("◆")} ${c.bold(path)}`);
    } else if (line.startsWith("@@")) {
      const range = line.match(/@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (range) { oldLine = Number(range[1]); newLine = Number(range[2]); }
      output.push(`  ${c.hunk(line)}`);
    } else if (line.startsWith("+") && !line.startsWith("+++")) {
      output.push(`  ${c.dim("     ")} ${c.dim(String(newLine).padStart(4))} ${c.added("+")} ${c.added(line.slice(1))}`);
      newLine += 1;
    } else if (line.startsWith("-") && !line.startsWith("---")) {
      output.push(`  ${c.dim(String(oldLine).padStart(4))} ${c.dim("     ")} ${c.removed("−")} ${c.removed(line.slice(1))}`);
      oldLine += 1;
    } else if (line.startsWith(" ")) {
      output.push(`  ${c.dim(String(oldLine).padStart(4))} ${c.dim(String(newLine).padStart(4))} ${c.dim("│")} ${line.slice(1)}`);
      oldLine += 1;
      newLine += 1;
    } else if (line.startsWith("\\ No newline")) output.push(`  ${faint(line)}`);
  }
  return output;
};

export const usageLine = (u: {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}): string => {
  const k = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
  return `${k(u.inputTokens)} in · ${k(u.outputTokens)} out · ${k(u.totalTokens)} total`;
};
