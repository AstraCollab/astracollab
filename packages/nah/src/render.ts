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
  /**
   * Panel fill: near-white text on a near-black surface, in one SGR pair.
   *
   * Both attributes are set by a single sequence and cleared by a single reset
   * rather than by separate foreground/background pairs. That keeps the row's
   * byte overhead at 17 characters instead of 29, which matters because the row
   * is padded to the full pane width and then clamped to the terminal width: the
   * cheaper form is the difference between fitting and having the closing escape
   * clipped off mid-sequence, which bleeds the fill onto the next line.
   */
  background: wrap("\u001b[38;5;255;48;5;236m", "\u001b[0m"),
  /**
   * Failure fill, applied to the whole panel rather than to the text.
   *
   * A nested SGR sequence inside a full-width padded row overflows its column
   * and the layout clips the closing escape, so a panel cannot carry its own
   * colour. Tinting the surface is the way to mark a failure here.
   */
  backgroundError: wrap("\u001b[38;5;255;48;5;52m", "\u001b[0m"),
  /**
   * Approval fill: near-white on a dark amber, the third surface in the same
   * family as `background` and `backgroundError`.
   *
   * Amber rather than bright yellow because the row carries near-white text, and
   * the alternatives are either unreadable (white on yellow) or invisible (the
   * `c.yellow("!")` marker that used to be the only attention cue disappears the
   * moment the surface behind it is yellow).
   */
  backgroundWarn: wrap("\u001b[38;5;255;48;5;94m", "\u001b[0m"),
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

/**
 * The full terminal command behind a `bash` call, or null if this is not one.
 *
 * `toolLabel` clips to 50 characters because its other callers - the approval
 * prompt, the readonly-mode notice, the readline fallback - are all single-line
 * surfaces with no room for a block. The TUI transcript has room, so it asks
 * for the command directly instead of unpicking a clipped label.
 */
export const bashCommand = (input: unknown): string | null => {
  const args = (input ?? {}) as Record<string, unknown>;
  if (typeof args.command !== "string") return null;
  const command = args.command.trim();
  return command.length > 0 ? command : null;
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
    /**
     * The URL, minus the scheme.
     *
     * `https://` on every row is width spent saying nothing — the label is
     * clipped to 50 characters by the callers that have only a line, and the
     * scheme is the part of a URL least likely to be the interesting bit. What is
     * left is usually the host and path, which is what identifies the fetch when
     * scrolling back through a turn.
     */
    case "web_fetch": {
      const raw = typeof args.url === "string" ? args.url : "";
      return `web fetch ${clip(raw.replace(/^https?:\/\//, ""), 44)}`.trimEnd();
    }
    case "web_search": {
      const raw = typeof args.query === "string" ? args.query : "";
      return `web search ${clip(raw, 44)}`.trimEnd();
    }
    case "delegate_task":
      return `delegate in isolated worktree: ${typeof args.title === "string" ? clip(args.title) : "task"}`;
    case "delegate_explore":
      return `explore read-only: ${typeof args.title === "string" ? clip(args.title) : "task"}`;
    case "delegate_explores": {
      const questions = Array.isArray(args.questions) ? (args.questions as Array<Record<string, unknown>>) : [];
      // Same reasoning as delegate_tasks: the count is the point of the batch
      // call, and a depth alongside a title is what says a cheap child and an
      // expensive one were mixed deliberately rather than by accident.
      return `explore ${questions.length} questions: ${questions
        .map(({ title, depth }) => {
          const label = typeof title === "string" ? clip(title, 24) : "question";
          return depth === "quick" ? `${label} (quick)` : label;
        })
        .join(", ")}`;
    }
    case "delegate_tasks": {
      const tasks = Array.isArray(args.tasks) ? (args.tasks as Array<Record<string, unknown>>) : [];
      // The count is the whole point of the batch call, so it leads; the titles
      // follow because a fan-out of six is worth reading in the transcript.
      return `delegate ${tasks.length} subtasks in isolated worktrees: ${tasks
        .map(({ title }) => (typeof title === "string" ? clip(title, 24) : "task"))
        .join(", ")}`;
    }
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
        case "status": {
          const status = typeof args.status === "string" ? args.status : "";
          return status ? `plan · status → ${status}` : "plan · status";
        }
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
 *
 * `web_fetch` belongs here for the same reason `read` does: the label already
 * carries the thing worth knowing (which URL), and the body is a converted page
 * whose first line is the page's own `<h1>` — which tells the reader nothing they
 * did not get from the label.
 */
const QUIET_ON_SUCCESS = new Set([
  "read",
  "list",
  "glob",
  "grep",
  "task_ledger",
  "web_fetch",
  "web_search",
]);

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
    if (action === "status") {
      const status = output.match(/^Status: (.+)$/m)?.[1];
      if (status) return { show: true, text: `status → ${status}` };
      return { show: true, text: output.split("\n")[0] ?? "plan status" };
    }
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
  // A trailing newline means "the last line is complete", not "there is an extra
  // empty line" — counting it would render a phantom trailing context row.
  const split = (text: string): string[] => {
    if (text === "") return [];
    const lines = text.split("\n");
    if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
    return lines;
  };
  const oldLines = split(before);
  const newLines = split(after);
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

/**
 * Render one side of a side-by-side diff row.
 *
 * `old`/`new` are the 0-based line numbers for that pane, or null on the side that
 * does not exist (an added line has no old number, a removed line no new one).
 * Numbers are right-aligned in a fixed gutter so the two panes stay aligned even as
 * the file grows past nine lines.
 */
const paneCell = (
  text: string,
  kind: "context" | "added" | "removed" | "empty",
  lineNumber: number | null,
  width: number,
): string => {
  const marker = kind === "added" ? "+" : kind === "removed" ? "−" : " ";
  const gutter = lineNumber === null ? " ".repeat(4) : String(lineNumber).padStart(4);
  const body = kind === "empty" ? "" : `${marker} ${text}`;
  const clipped = body.length > width ? body.slice(0, width) : body;
  const pad = " ".repeat(Math.max(0, width - clipped.length));
  const content = kind === "added" ? c.added : kind === "removed" ? c.removed : c.dim;
  return `${c.dim(gutter)} ${content(clipped + pad)}`;
};

/**
 * Format a file change as a side-by-side diff, old on the left and new on the right.
 *
 * Paired by the diff itself: a removed run and the added run that follows it are one
 * block, walked in step so a changed line sits on one row. A deletion with no
 * matching addition leaves the right pane blank, and the reverse. When the terminal
 * is too narrow for two panes to be legible — under 96 columns, the same threshold
 * the TUI sidebar uses — it falls back to the linear layout rather than squeezing
 * two truncated columns into the width.
 */
export const formatFileChange = (change: RenderableFileChange, width: number = 80): string[] => {
  const before = change.existed ? change.content ?? "" : "";
  const diff = buildDiffLines(before, change.after);
  const added = diff.filter((line) => line.kind === "added").length;
  const removed = diff.filter((line) => line.kind === "removed").length;
  const changedIndexes = diff.flatMap((line, index) => line.kind === "context" ? [] : [index]);

  // Fall back to the linear layout when there is no room for two panes.
  if (width < 96) return formatFileChangeLinear(change, diff, added, removed, changedIndexes);

  // Group the diff into blocks: a context run, then the changed block that breaks
  // it. Each block is a list of rows, and each row carries the text and line
  // number for each pane.
  const blocks: DiffLine[][] = [];
  let run: DiffLine[] = [];
  for (const line of diff) {
    if (line.kind === "context") {
      if (run.length) { blocks.push(run); run = []; }
      blocks.push([line]);
    } else {
      run.push(line);
    }
  }
  if (run.length) blocks.push(run);

  const header = `${c.purple("▸")} ${c.bold(change.path)}  ${c.added(`+${added}`)} ${c.removed(`−${removed}`)}`;
  const lines = [header];

  const paneWidth = Math.max(20, Math.floor((width - 16) / 2));
  const renderRow = (left: { text: string; kind: DiffLine["kind"] | "empty"; n: number | null }, right: { text: string; kind: DiffLine["kind"] | "empty"; n: number | null }): string => {
    const leftCell = paneCell(left.text, left.kind, left.n, paneWidth);
    const rightCell = paneCell(right.text, right.kind, right.n, paneWidth);
    const divider = c.dim(" │ ");
    // `paneCell` pads to the pane width, so the divider lands in the same column
    // on every row.
    return `  ${leftCell}${divider}${rightCell}`;
  };

  let oldNumber = 0;
  let newNumber = 0;
  let renderedRows = 0;
  const MAX_ROWS = 120;

  for (const block of blocks) {
    if (block[0]!.kind === "context") {
      // Collapse a long context run to a few lines around the changes, with a gap
      // marker in the middle rather than the whole run.
      const keep = 3;
      const visible = block.length > keep * 2 + 1
        ? [...block.slice(0, keep), null, ...block.slice(block.length - keep)]
        : block;
      for (const entry of visible) {
        if (entry === null) {
          lines.push(c.dim(`  ${"…".padEnd(paneWidth)} │ ${"…".padEnd(paneWidth)}`));
          continue;
        }
        oldNumber += 1;
        newNumber += 1;
        lines.push(renderRow({ text: entry.text, kind: "context", n: oldNumber }, { text: entry.text, kind: "context", n: newNumber }));
      }
      continue;
    }

    // A changed block: walk the removed and added runs in step.
    const removedLines = block.filter((line) => line.kind === "removed");
    const addedLines = block.filter((line) => line.kind === "added");
    const rows = Math.max(removedLines.length, addedLines.length);
    for (let r = 0; r < rows; r += 1) {
      const left = removedLines[r];
      const right = addedLines[r];
      const leftCell = left ? { text: left.text, kind: "removed" as const, n: ++oldNumber } : { text: "", kind: "empty" as const, n: null };
      const rightCell = right ? { text: right.text, kind: "added" as const, n: ++newNumber } : { text: "", kind: "empty" as const, n: null };
      lines.push(renderRow(leftCell, rightCell));
      renderedRows += 1;
    }
  }

  if (changedIndexes.length === 0) lines.push(c.dim("  no textual changes"));
  if (lines.length > MAX_ROWS) {
    return [...lines.slice(0, MAX_ROWS - 1), c.dim(`  … ${lines.length - (MAX_ROWS - 1)} more diff lines`)];
  }
  return lines;
};

/** The old top-to-bottom layout, kept for terminals too narrow for two panes. */
const formatFileChangeLinear = (
  change: RenderableFileChange,
  diff: DiffLine[],
  added: number,
  removed: number,
  changedIndexes: number[],
): string[] => {
  const visibleIndexes = new Set<number>();
  for (const index of changedIndexes) {
    for (let i = Math.max(0, index - 3); i <= Math.min(diff.length - 1, index + 3); i += 1) visibleIndexes.add(i);
  }
  const lines = [
    `${c.purple("▸")} ${c.bold(change.path)}  ${c.added(`+${added}`)} ${c.removed(`−${removed}`)}`,
  ];
  let previous = -1;
  for (const index of [...visibleIndexes].sort((a, b) => a - b)) {
    if (previous >= 0 && index > previous + 1) lines.push(c.dim("    …"));
    const line = diff[index]!;
    const value = line.text.slice(0, 220);
    if (line.kind === "added") lines.push(`  ${c.added(`+ ${value}`)}`);
    else if (line.kind === "removed") lines.push(`  ${c.removed(`− ${value}`)}`);
    else lines.push(`  ${c.dim("  ")}${value}`);
    previous = index;
  }
  if (changedIndexes.length === 0) lines.push(c.dim("  no textual changes"));
  if (lines.length > 124) {
    return [...lines.slice(0, 120), c.dim(`  … ${lines.length - 120} more diff lines`)];
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

/**
 * The token line a finished run prints.
 *
 * `promptTokens` is the whole prompt, cached prefix included, because that is
 * how a provider counts it and how its dashboard shows it. Leaving the cached
 * tokens out makes the figure disagree with the provider by the size of the
 * cache — most of the prompt on a well-cached run.
 */
export const usageLine = (u: {
  promptTokens: number;
  outputTokens: number;
  totalTokens: number;
}): string => {
  const k = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
  return `${k(u.promptTokens)} in · ${k(u.outputTokens)} out · ${k(u.totalTokens)} total`;
};
