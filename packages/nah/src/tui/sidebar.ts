/**
 * Right-hand context panel.
 *
 * The transcript says what happened; this says what state the session is in.
 * Everything here is already known to the process — nothing is computed per
 * frame and there is no extra model call — so the panel costs a `render` of a
 * few dozen cached strings and can be repainted on every event.
 *
 * The session id sits at the top because it is the one field you need when
 * something goes wrong: it is the filename under `~/.nah/sessions`, so
 * `/resume <id>` and a bug report both key off what is printed here.
 */
import type { Component } from "@earendil-works/pi-tui";

import { c, stripAnsi } from "../render.js";

export type SidebarData = {
  /** Session file stem, e.g. the 12-char hash of the cwd. */
  sessionId: string;
  cwd: string;
  modelProvider: string;
  modelId: string;
  /** Latest provider-reported input size, i.e. the current prompt footprint. */
  contextUsedTokens: number;
  /** True when that figure is derived rather than reported. */
  contextEstimated: boolean;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  turns: number;
  permissions: string;
  /** Transient provider message, e.g. "anthropic retry 1…". */
  providerStatus: string | null;
  /** Entries that `/undo` can still roll back. */
  undoDepth: number;
  /** Steps in the task ledger, when one exists. */
  planSteps: number | null;
};

/** 1.2k / 3.4m, matching the status line's notation. */
export const formatTokens = (value: number): string =>
  value >= 1_000_000 ? `${(value / 1_000_000).toFixed(1)}m` : value >= 1_000 ? `${(value / 1_000).toFixed(1)}k` : String(value);

/** Clip on visible width, so ANSI colour in a value cannot push it over. */
const clip = (value: string, max: number): string => {
  const plain = stripAnsi(value);
  return plain.length > max ? `${plain.slice(0, Math.max(0, max - 1))}…` : value;
};

/** Collapse a long path to its last two segments. */
const shortPath = (value: string): string => {
  const parts = value.split("/").filter(Boolean);
  if (parts.length <= 2) return value;
  return `…/${parts.slice(-2).join("/")}`;
};

/**
 * The panel's lines, as plain text plus colour.
 *
 * Exported separately from the component so the layout can be asserted without a
 * terminal, and so the wrapping rules are testable in isolation.
 */
export const formatSidebar = (data: SidebarData, width: number): string[] => {
  const lines: string[] = [];
  const section = (label: string) => lines.push(c.dim(label.toUpperCase()));
  const row = (value: string) => lines.push(clip(value, width));

  section("session");
  row(c.bold(data.sessionId));
  row(c.dim(shortPath(data.cwd)));

  section("model");
  row(c.cyan(data.modelProvider));
  row(clip(data.modelId, width));

  section("context");
  // `~` marks the figure as derived, the same convention as the status line.
  row(`${data.contextEstimated ? "~" : ""}${formatTokens(data.contextUsedTokens)} used`);
  row(c.dim(`↑${formatTokens(data.inputTokens)} in`));
  row(c.dim(`↓${formatTokens(data.outputTokens)} out`));
  row(c.dim(`${formatTokens(data.totalTokens)} total`));

  section("session state");
  row(`${data.turns} turn${data.turns === 1 ? "" : "s"}`);
  row(c.magenta(`mode ${data.permissions}`));
  if (data.planSteps !== null) row(c.dim(`plan ${data.planSteps} step${data.planSteps === 1 ? "" : "s"}`));
  if (data.undoDepth > 0) row(c.dim(`${data.undoDepth} undoable`));
  if (data.providerStatus) row(c.yellow(clip(data.providerStatus, width)));

  return lines;
};

/**
 * The panel as a `Component`, with a rule down its left edge.
 *
 * `render` only receives a width, never the viewport height, so the rule is
 * padded out using the terminal's row count. The layout truncates a child that
 * renders taller than its box, so an off-by-one here costs a rule segment
 * rather than a broken frame.
 */
export class ContextSidebar implements Component {
  constructor(
    private readonly read: () => SidebarData,
    private readonly rows: () => number = () => process.stdout.rows ?? 24,
  ) {}

  render(width: number): string[] {
    const inner = Math.max(1, width - 2);
    const content = formatSidebar(this.read(), inner).map((line) => `${c.dim("│")} ${line}`);
    const target = Math.max(content.length, this.rows());
    // Blank rules below the content rather than gaps, so the panel reads as one
    // surface instead of stopping mid-column.
    for (let i = content.length; i < target; i += 1) content.push(c.dim("│"));
    return content;
  }

  invalidate(): void {
    // Nothing is cached: the data is read fresh on every frame, which is what
    // lets token counts update without the host having to notify anyone.
  }
}