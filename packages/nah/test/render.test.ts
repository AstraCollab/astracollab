/**
 * Code-change diffs, rendered side by side.
 *
 * The layout is the contract: old on the left, new on the right, aligned row for
 * row. These pin the pairing (a changed line shares a row), the gutters (a deletion
 * has no new line number, an addition no old one), and the narrow-terminal fallback
 * to the linear layout.
 */
import { describe, expect, it } from "vitest";

import { formatFileChange } from "../src/render.js";

const before = ["one", "two", "three"].join("\n");
const after = ["one", "TWO", "three", "four"].join("\n");

describe("formatFileChange", () => {
  it("lays old and new side by side when the terminal is wide enough", () => {
    const lines = formatFileChange({ path: "src/x.ts", existed: true, content: before, after }, 120);
    // One header, then one row per diff line. `one`/`three` are context, `two`→
    // `TWO` is one changed row, and `four` is an addition with an empty left pane.
    const rows = lines.slice(1);
    expect(rows.some((row) => row.includes("│"))).toBe(true);
    // The changed line sits on one row: `two` on the left, `TWO` on the right.
    const changed = rows.find((row) => row.includes("two") || row.includes("TWO"));
    expect(changed).toBeDefined();
    expect(changed).toContain("two");
    expect(changed).toContain("TWO");
  });

  it("falls back to the linear layout on a narrow terminal", () => {
    const lines = formatFileChange({ path: "src/x.ts", existed: true, content: before, after }, 80);
    // No two-pane divider, and the old `+`/`−` prefix layout instead.
    expect(lines.some((line) => line.includes("│"))).toBe(false);
    expect(lines.some((line) => line.includes("+ TWO"))).toBe(true);
  });

  it("shows an addition with no left pane and a deletion with no right pane", () => {
    const added = formatFileChange({ path: "src/x.ts", existed: false, after: "const x = 1;\n" }, 120);
    const addedRows = added.slice(1);
    expect(addedRows).toHaveLength(1);
    // A new file: the left gutter is blank, the right shows the line.
    expect(addedRows[0]).toContain("+ const x = 1;");
    // No phantom removal for the trailing newline.
    expect(added.join("\n")).toContain("−0");

    const removed = formatFileChange({ path: "src/x.ts", existed: true, content: "const x = 1;\n", after: "" }, 120);
    const removedRows = removed.slice(1);
    expect(removedRows).toHaveLength(1);
    expect(removedRows[0]).toContain("− const x = 1;");
  });

  it("does not invent a trailing empty line from a trailing newline", () => {
    // `before`/`after` both end in a newline; the diff must not show a phantom
    // extra context row for it.
    const lines = formatFileChange(
      { path: "src/x.ts", existed: true, content: "a\nb\n", after: "a\nc\n" },
      120,
    );
    const rows = lines.slice(1);
    // a (context), b→c (changed): exactly two rows, no trailing empty.
    expect(rows).toHaveLength(2);
  });
});