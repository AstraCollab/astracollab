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
