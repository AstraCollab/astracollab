import type { HarnessEvent } from "not-another-harness";

import { toolLabel } from "./render.js";

const clipTo = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n)}…` : s);

/**
 * A delegated child's progress → one transcript line, or nothing.
 *
 * Children are loud in a way the parent is not: one child spends a step on a
 * handful of tool calls surrounded by text deltas, so a fan-out of three emits
 * hundreds of events, and printing them all buries the turn that asked for them.
 * What a reader is watching is which child is doing what, so the step and tool
 * calls survive and the prose does not.
 *
 * `null` is the common case rather than an error — it is what keeps a fan-out
 * legible instead of a wall of deltas.
 */
export const childEventLine = (title: string, event: HarnessEvent): string | null => {
  const who = clipTo(title, 28);
  switch (event.type) {
    // The gap between two step markers is the only sign a long tool call is
    // still working, which is what makes a slow child read as slow rather than
    // as stuck.
    case "step-start":
      return `  · ${who} · step ${event.step}`;
    case "tool-call":
      return `  ↳ ${who} · ${toolLabel(event.toolName, event.input)}`;
    default:
      return null;
  }
};