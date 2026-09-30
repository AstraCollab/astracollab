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
      return `edit ${path}`;
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

export const usageLine = (u: {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}): string => {
  const k = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
  return `${k(u.inputTokens)} in · ${k(u.outputTokens)} out · ${k(u.totalTokens)} total`;
};
