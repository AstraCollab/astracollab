/** Minimal ANSI helpers (respect NO_COLOR / dumb terminals), zero deps. */
const enabled =
  !process.env.NO_COLOR && process.env.TERM !== "dumb" && process.stdout.isTTY !== false;

const wrap = (open: string, close: string) => (s: string) =>
  enabled ? `${open}${s}${close}` : s;

export const c = {
  dim: wrap("[2m", "[0m"),
  bold: wrap("[1m", "[0m"),
  cyan: wrap("[36m", "[0m"),
  green: wrap("[32m", "[0m"),
  yellow: wrap("[33m", "[0m"),
  red: wrap("[31m", "[0m"),
  magenta: wrap("[35m", "[0m"),
};

const faint = (s: string) => wrap("\u001b[38;5;244m", "\u001b[39m")(s);
const dark = (s: string) => wrap("\u001b[30;1m", "\u001b[39m")(s);
const stripAnsi = (s: string): string => s.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "");

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
export const toolLabel = (toolName: string, input: unknown): string => {
  const args = (input ?? {}) as Record<string, unknown>;
  const path = typeof args.path === "string" ? args.path : "";
  const clip = (s: string, n = 50): string => (s.length > n ? `${s.slice(0, n)}…` : s);
  switch (toolName) {
    case "read":
      return `read ${path}${args.offset ? `:${args.offset}` : ""}`;
    case "list":
      return `list ${path || "."}`;
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
    default:
      return toolName;
  }
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
    `${c.cyan("✳")} ${c.bold(change.path)}  ${c.green(`+${added}`)} ${c.red(`−${removed}`)}`,
  ];
  let previous = -1;
  for (const index of [...visibleIndexes].sort((a, b) => a - b)) {
    if (previous >= 0 && index > previous + 1) lines.push(c.dim("  │ …"));
    const line = diff[index]!;
    const prefix = line.kind === "added" ? c.green("+ ") : line.kind === "removed" ? c.red("− ") : c.dim("  ");
    lines.push(`${prefix}${line.text.slice(0, 220)}`);
    previous = index;
  }
  if (changedIndexes.length === 0) lines.push(c.dim("  │ no textual changes"));
  if (lines.length > 124) {
    return [...lines.slice(0, 120), c.dim(`  │ … ${lines.length - 120} more diff lines`)];
  }
  return lines;
};

export const usageLine = (u: {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}): string => {
  const k = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
  return `${k(u.inputTokens)} in · ${k(u.outputTokens)} out · ${k(u.totalTokens)} total`;
};
