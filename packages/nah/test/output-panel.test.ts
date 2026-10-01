import { describe, expect, it } from "vitest";

import { TurnOutput } from "../src/tui/output.js";
import type { RenderableFileChange } from "../src/render.js";

const strip = (value: string): string =>
  value
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\u001b\]8;;\u0007/g, "");

/**
 * Panel rows are found by their fill, not by an exact escape sequence.
 *
 * The fill sets foreground and background in one SGR, so matching a literal
 * `ESC[48;5;236m` would break the moment the fill changes - and would silently
 * turn these tests into no-ops that pass while checking nothing.
 */
const isPanel = (line: string): boolean => line.includes("48;5;236m");
const isErrorPanel = (line: string): boolean => line.includes("48;5;52m");
/** Remove only the fill's own sequences, leaving any nested colour visible. */
const stripFill = (line: string): string =>
  line.replace(/\u001b\[38;5;255;48;5;(?:236|52)m|\u001b\[0m/g, "");

const bash = (output: TurnOutput, command: string) =>
  output.apply({ type: "tool-call", toolName: "bash", input: { command } } as never);

const result = (output: TurnOutput, text: string, isError = false) =>
  output.apply({ type: "tool-result", toolName: "bash", input: {}, output: text, isError } as never);

describe("shell commands", () => {
  it("keeps a command that used to be truncated past 50 characters", () => {
    const output = new TurnOutput();
    const command = "pnpm vitest run --coverage --reporter=verbose packages/not-another-harness/test";
    bash(output, command);
    // `toolLabel` clips at 50 characters, so this is the exact case that used to
    // render as `pnpm vitest run --coverage --reporter=verb…`.
    expect(strip(output.render(120).join("\n"))).toContain(command);
  });

  it("preserves every line of a multi-line invocation", () => {
    const output = new TurnOutput();
    bash(output, "npx tsc --noEmit \\\n  && npx vite build \\\n  && git push");
    const rendered = strip(output.render(100).join("\n"));
    expect(rendered).toContain("npx tsc --noEmit");
    expect(rendered).toContain("&& npx vite build");
    expect(rendered).toContain("&& git push");
  });

  it("paints the command as a near-white-on-dark panel", () => {
    const output = new TurnOutput();
    bash(output, "pnpm test");
    const line = output.render(60)[0]!;
    expect(isPanel(line)).toBe(true);
    // Explicit foreground rather than whatever the terminal default happens to
    // be, and a fill that spans the pane edge to edge.
    expect(line).toContain("38;5;255");
    expect(strip(line)).toHaveLength(60);
  });

  it("keeps a command's output inside the same panel", () => {
    const output = new TurnOutput();
    bash(output, "pnpm test");
    result(output, "3 files passed\n66 tests");

    const panel = output.render(70).filter(isPanel);
    // Command and output share one surface, the opencode shape, rather than a
    // filled command above a bare line of narration.
    expect(panel).toHaveLength(3);
    const joined = strip(panel.join("\n"));
    expect(joined).toContain("pnpm test");
    expect(joined).toContain("3 files passed");
    expect(joined).toContain("66 tests");
  });

  it("bounds a long output and counts what it dropped", () => {
    const output = new TurnOutput();
    bash(output, "pnpm build");
    result(output, Array.from({ length: 40 }, (_, i) => `log line ${i + 1}`).join("\n"));

    const rendered = strip(output.render(70).join("\n"));
    expect(rendered).toContain("log line 12");
    expect(rendered).not.toContain("log line 13");
    // Dropped lines are counted, not silently discarded.
    expect(rendered).toContain("… 28 more lines");
  });

  it("tints the whole panel when the command fails", () => {
    const output = new TurnOutput();
    bash(output, "pnpm test");
    result(output, "FAIL test/a.test.ts\n  expected 1 to be 2", true);

    const panel = output.render(60).filter(isErrorPanel);
    expect(panel).toHaveLength(3);
    expect(strip(panel.join("\n"))).toContain("expected 1 to be 2");
  });

  it("strips colour out of command output before it enters a panel", () => {
    const output = new TurnOutput();
    bash(output, "pnpm test");
    // tsc and vitest both colour their failures; that must not reach a row that
    // is padded to the pane width.
    result(output, "\u001b[31mFAIL\u001b[39m test/a.test.ts\n\u001b[2m  at Object.<anonymous>\u001b[0m");

    const panel = output.render(60).filter(isPanel);
    expect(panel).toHaveLength(3);
    for (const line of panel) expect(stripFill(line)).not.toContain("\u001b");
    expect(strip(panel.join("\n"))).toContain("FAIL test/a.test.ts");
  });

  it("keeps nested colour out of the panel so a row cannot overflow its column", () => {
    const output = new TurnOutput();
    // Two calls, so the `×N identical` line is inside the panel too.
    bash(output, "npx tsc --noEmit \\\n  && npx vite build");
    bash(output, "npx tsc --noEmit \\\n  && npx vite build");

    const panel = output.render(60).filter(isPanel);
    // Guards against the whole test going vacuous if colour is disabled.
    expect(panel.length).toBeGreaterThan(0);
    for (const line of panel) {
      // A nested SGR sequence makes the row longer in bytes than it is in
      // columns, so the layout's width clamp cuts the closing escape off
      // mid-sequence and the background bleeds onto the following line.
      expect(stripFill(line), "panel rows must not carry their own colour").not.toContain("\u001b");
    }
  });

  it("collapses identical consecutive commands but not merely similar ones", () => {
    const output = new TurnOutput();
    bash(output, "pnpm vitest run");
    bash(output, "pnpm vitest run");
    bash(output, "pnpm vitest run");
    bash(output, "pnpm vitest run --coverage");

    const rendered = strip(output.render(80).join("\n"));
    expect(rendered).toContain("×3 identical");
    // Different invocations share the `pnpm vitest run` prefix; keying collapse
    // on the clipped label would have merged these into one line.
    expect(rendered).toContain("pnpm vitest run --coverage");
  });

  it("leaves other tools on their existing one-line form", () => {
    const output = new TurnOutput();
    output.apply({ type: "tool-call", toolName: "read", input: { path: "src/app.ts" } } as never);
    const line = output.render(60)[0]!;
    expect(isPanel(line)).toBe(false);
    expect(strip(line)).toContain("read src/app.ts");
  });

  it("still renders other tools' results as their own line", () => {
    const output = new TurnOutput();
    bash(output, "true");
    result(output, "");
    output.apply({ type: "tool-call", toolName: "read", input: { path: "a.ts" } } as never);
    output.apply({
      type: "tool-result",
      toolName: "write",
      input: { path: "a.ts" },
      output: "wrote 12 lines",
      isError: false,
    } as never);
    expect(strip(output.render(60).join("\n"))).toContain("wrote 12 lines");
  });
});

/**
 * A `step-finish` with a real request breakdown.
 *
 * These tests cast events with `as never`, so TypeScript cannot catch a missing
 * field - the renderer has to survive one anyway.
 */
const requestBreakdown = (totalInputTokens: number) => ({
  totalInputTokens,
  cachedInputTokens: Math.round(totalInputTokens * 0.8),
  cacheCreationInputTokens: 0,
  freshInputTokens: Math.round(totalInputTokens * 0.2),
  hitRate: 0.8,
});

const finish = (output: TurnOutput, totalTokens: number) =>
  output.apply({
    type: "finish",
    reason: "completed",
    text: "",
    usage: { inputTokens: totalTokens - 100, outputTokens: 100, totalTokens, estimated: false },
  } as never);

describe("usage figures", () => {
  it("names the cumulative total as throughput, not as a context size", () => {
    const output = new TurnOutput();
    output.apply({ type: "step-finish", request: requestBreakdown(31_200) } as never);
    finish(output, 315_640);
    const line = strip(output.render(90).join("\n"));
    // The two figures that could not be reconciled against a provider's
    // per-request log are now both present and both labelled.
    expect(line).toContain("315.6k processed");
    expect(line).toContain("31.2k in last request");
  });

  it("omits the request figure when no step has finished", () => {
    const output = new TurnOutput();
    finish(output, 1100);
    const line = strip(output.render(90).join("\n"));
    expect(line).toContain("1.1k processed");
    expect(line).not.toContain("in last request");
  });

  it("survives a step-finish with no request breakdown", () => {
    const output = new TurnOutput();
    // The type requires `request`, but a renderer that throws on a malformed
    // event would take the whole transcript pane down with it.
    output.apply({ type: "step-finish" } as never);
    finish(output, 1100);
    expect(strip(output.render(90).join("\n"))).toContain("1.1k processed");
  });
});

describe("vertical rhythm", () => {
  const lines = (output: TurnOutput, width = 60) => output.render(width);
  const isBlank = (line: string) => strip(line).trim().length === 0;
  const blanks = (output: TurnOutput, width = 60) => lines(output, width).filter(isBlank).length;

  it("separates different kinds of block with a blank line", () => {
    const output = new TurnOutput();
    output.addLine("❯ fix it", "user");
    output.appendStream("Here is what I found.");
    bash(output, "pnpm test");
    output.appendStream("Fixed.");
    // user -> prose -> tool -> prose, so every transition gets air.
    expect(blanks(output)).toBe(3);
  });

  it("keeps same-kind blocks tight", () => {
    const output = new TurnOutput();
    output.apply({ type: "tool-call", toolName: "read", input: { path: "a.ts" } } as never);
    output.apply({ type: "tool-call", toolName: "read", input: { path: "b.ts" } } as never);
    output.apply({ type: "tool-call", toolName: "read", input: { path: "c.ts" } } as never);
    // Three consecutive calls are one passage, not three paragraphs.
    expect(blanks(output)).toBe(0);
  });

  it("does not open the transcript on empty space", () => {
    const output = new TurnOutput();
    output.appendStream("First thing said.");
    expect(isBlank(lines(output)[0]!)).toBe(false);
  });

  it("keeps a command and its own output in one block", () => {
    const output = new TurnOutput();
    output.addLine("❯ run it", "user");
    bash(output, "pnpm test");
    result(output, "66 tests");
    // The result is absorbed by the panel, so no gap opens between them.
    expect(blanks(output)).toBe(1);
    expect(strip(lines(output)[0]!)).toContain("❯ run it");
  });

  it("keeps a multi-line diff together instead of paragraphing every row", () => {
    const changes: RenderableFileChange[] = [
      { path: "src/a.ts", existed: false, after: "l1\nl2\nl3\nl4" },
    ];
    const output = new TurnOutput(() => changes);
    output.apply({ type: "tool-call", toolName: "read", input: { path: "a.ts" } } as never);
    output.apply({ type: "step-finish", request: requestBreakdown(1000) } as never);

    // Asserted on the diff's content rows rather than on blank-line counts: at
    // narrow widths pi-tui renders the box-drawing rules as empty, which is a
    // separate pre-existing quirk and would make a count assertion meaningless.
    const rendered = lines(output, 80).map(strip);
    const rows = rendered.map((line, i) => (/\+\s+l\d/.test(line) ? i : -1)).filter((i) => i >= 0);
    expect(rows).toHaveLength(4);
    // Consecutive, with no separator row wedged between any of them.
    expect(rows).toEqual([rows[0], rows[0]! + 1, rows[0]! + 2, rows[0]! + 3]);
  });

  it("renders a blank line for an explicit gap", () => {
    const output = new TurnOutput();
    output.addLine("before");
    output.addGap();
    output.addLine("after");
    // `addGap` used to be invisible: pi-tui's `Text` returns no rows at all for
    // whitespace-only content, so the separator rendered as nothing.
    expect(blanks(output)).toBe(1);
    // And it must not double up with the automatic gap.
    expect(lines(output)).toHaveLength(3);
  });
});