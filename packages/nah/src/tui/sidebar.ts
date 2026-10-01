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
import { formatUsd } from "../budget.js";

export type SidebarData = {
  /** Session file stem, e.g. the 12-char hash of the cwd. */
  sessionId: string;
  cwd: string;
  modelProvider: string;
  modelId: string;
  /** Size of the most recent request, i.e. the current context footprint. */
  contextUsedTokens: number;
  /** True when that figure is derived rather than reported. */
  contextEstimated: boolean;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  /** Cumulative prompt-cache read tokens. */
  cacheReadTokens: number;
  /** Cumulative prompt-cache write tokens. */
  cacheWriteTokens: number;
  /** Cache hit rate of the most recent request, 0..1. */
  cacheHitRate: number;
  /** Cumulative spend this session in USD; 0 when rates are unknown. */
  spendUsd: number;
  /** Spend rail for the current turn, or null to show only what has been spent. */
  spendLimitUsd: number | null;
  turns: number;
  permissions: string;
  /** Transient provider message, e.g. "anthropic retry 1…". */
  providerStatus: string | null;
  /** Entries that `/undo` can still roll back. */
  undoDepth: number;
  /** Steps in the task ledger, when one exists. */
  planSteps: number | null;
  /** Directory the file tools are confined to. Equals `cwd` unless widened. */
  workspaceRoot: string | null;
};

/** 1.2k / 3.4m, matching the status line's notation. */
export const formatTokens = (value: number): string =>
  value >= 1_000_000 ? `${(value / 1_000_000).toFixed(1)}m` : value >= 1_000 ? `${(value / 1_000).toFixed(1)}k` : String(value);

/**
 * Minimum input before a cache hit rate is worth showing.
 *
 * The first request of a run is nearly all cache *write*, so the rate legitimately
 * starts at zero. Rendering "0%" in red on turn one would be a false alarm, so
 * the figure only appears once there is enough volume to mean anything.
 */
const CACHE_RATE_MIN_TOKENS = 20_000;

/** Below this the harness is re-writing its prefix more than it reads it back. */
const HEALTHY_HIT_RATE = 0.8;
const POOR_HIT_RATE = 0.4;

/** Clip on visible width, so ANSI colour in a value cannot push it over. */
const clip = (value: string, max: number): string => {
  const plain = stripAnsi(value);
  return plain.length > max ? `${plain.slice(0, Math.max(0, max - 1))}…` : value;
};

/** A counter that is missing or corrupt reads as zero rather than NaN. */
const finite = (value: number | undefined): number =>
  typeof value === "number" && Number.isFinite(value) ? value : 0;

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
  // Only when it differs from `cwd`: in a monorepo the root is usually one level
  // up, and an agent refused a sibling package should be able to see why.
  if (data.workspaceRoot && data.workspaceRoot !== data.cwd) {
    row(c.dim(`root ${shortPath(data.workspaceRoot)}`));
  }

  section("model");
  row(c.cyan(data.modelProvider));
  row(clip(data.modelId, width));

  section("context");
  // `~` marks the figure as derived, the same convention as the status line.
  row(`${data.contextEstimated ? "~" : ""}${formatTokens(data.contextUsedTokens)} used`);
  /**
   * The hit rate is the diagnostic that matters most here: below ~80% the run is
   * rewriting its prefix instead of reading it back, which costs roughly 10x on
   * every subsequent step and is invisible everywhere else on this panel.
   *
   * Counters are coerced rather than trusted. This runs per frame, and these come
   * from a session file that may predate the fields — a NaN here would throw
   * inside the render loop and take the terminal with it.
   */
  const cacheRead = finite(data.cacheReadTokens);
  const cacheWrite = finite(data.cacheWriteTokens);
  const freshInput = finite(data.inputTokens);
  const hitRate = Number.isFinite(data.cacheHitRate) ? Math.min(1, Math.max(0, data.cacheHitRate)) : 0;
  const inputTotal = cacheRead + cacheWrite + freshInput;
  const rate =
    inputTotal >= CACHE_RATE_MIN_TOKENS && hitRate > 0 ? `${Math.round(hitRate * 100)}% cached` : null;
  row(c.dim(`↑${formatTokens(freshInput)} in${rate ? ` · ${rate}` : ""}`));
  row(c.dim(`↓${formatTokens(data.outputTokens)} out`));
  row(c.dim(`${formatTokens(data.totalTokens)} total`));
  if (rate) {
    // Colour only once it is a real signal, for the same reason as the threshold.
    const tone = hitRate >= HEALTHY_HIT_RATE ? c.dim : hitRate >= POOR_HIT_RATE ? c.yellow : c.red;
    row(tone(`cache ${rate}`));
  }
  // Spend against the rail. A budget nobody can see is a budget that looks
  // arbitrary when it fires.
  const spend = finite(data.spendUsd);
  if (spend > 0 || data.spendLimitUsd != null) {
    const limit = Number.isFinite(data.spendLimitUsd as number) ? (data.spendLimitUsd as number) : null;
    row(c.dim(limit === null ? `${formatUsd(spend)} spent` : `${formatUsd(spend)} / ${formatUsd(limit)}`));
  }

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