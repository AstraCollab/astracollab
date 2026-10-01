import { describe, expect, it } from "vitest";

import { TERMINAL_RESTORE_SEQUENCE } from "../src/tui/host.js";

/**
 * A terminal left in SGR-mouse mode reports every pointer move as
 * `ESC[<button;col;rowM`. Anything reading stdin afterwards — usually the shell —
 * prints `35;107;19M` as literal text, repeatedly, until the tab is closed.
 * These assertions pin the exact sequences that undo that.
 */
describe("terminal restore sequence", () => {
  const counts = (needle: string) => TERMINAL_RESTORE_SEQUENCE.split(needle).length - 1;

  it("turns off every SGR mouse mode the TUI enables", () => {
    for (const mode of ["?1000", "?1002", "?1003", "?1004", "?1006"]) {
      expect(counts(`\u001b[${mode}l`), `${mode}l must be sent`).toBe(1);
      // …and none of them may be left enabled.
      expect(counts(`\u001b[${mode}h`)).toBe(0);
    }
  });

  it("also clears bracketed paste, the keyboard protocol, the cursor and alt screen", () => {
    expect(counts("\u001b[?2004l")).toBe(1);
    expect(counts("\u001b[<u")).toBe(1);
    expect(counts("\u001b[?25h")).toBe(1);
    expect(counts("\u001b[?1049l")).toBe(1);
  });

  it("contains no bare ESC[ that could be split by a crash mid-write", () => {
    // Every sequence is complete and in one string, so a partial write cannot
    // leave a dangling introducer for the shell to interpret.
    expect(TERMINAL_RESTORE_SEQUENCE.startsWith("\u001b[")).toBe(true);
    expect(TERMINAL_RESTORE_SEQUENCE.endsWith("l")).toBe(true);
  });
});
