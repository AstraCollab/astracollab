import { describe, expect, it } from "vitest";

import { DEFAULT_CAPS, capHead, capTail, sliceFileLines, toLines } from "../src/caps.js";

describe("caps", () => {
  it("passes through short content", () => {
    expect(capHead("a\nb", 10, 100, "hint")).toBe("a\nb");
    expect(capTail("a\nb", 10, 100, "hint")).toBe("a\nb");
  });

  it("does not count the phantom line after a trailing newline", () => {
    expect(toLines("a\nb\n")).toEqual(["a", "b"]);
    expect(toLines("a\nb")).toEqual(["a", "b"]);
    expect(toLines("a\n\n")).toEqual(["a", ""]);
    expect(toLines("")).toEqual([]);
    // A five-line file says it has five lines, so the model does not page for a sixth.
    expect(sliceFileLines("l1\nl2\nl3\nl4\nl5\n").totalLines).toBe(5);
  });

  it("capHead keeps the head and adds a paging notice", () => {
    const big = Array.from({ length: 100 }, (_, i) => `line ${i}`).join("\n");
    const out = capHead(big, 10, 10_000, "page with offset/limit");
    expect(out).toContain("line 0");
    expect(out).toContain("line 9");
    expect(out).not.toContain("line 10\n");
    expect(out).toContain("output truncated");
    expect(out).toContain("page with offset/limit");
  });

  it("capTail keeps the tail (errors live at the end)", () => {
    const big = Array.from({ length: 100 }, (_, i) => `line ${i}`).join("\n");
    const out = capTail(big, 10, 10_000, "hint");
    expect(out).toContain("line 99");
    expect(out).toContain("line 90");
    expect(out.startsWith("[output truncated")).toBe(true);
  });

  it("sliceFileLines numbers lines and respects the hard cap", () => {
    const file = Array.from({ length: 1000 }, (_, i) => `l${i}`).join("\n");
    const { body, totalLines } = sliceFileLines(file, 10, 5);
    expect(body.split("\n")).toEqual(["10|l9", "11|l10", "12|l11", "13|l12", "14|l13"]);
    expect(totalLines).toBe(1000);
    const capped = sliceFileLines(file, 1, undefined);
    // The hard cap is deliberately small: every step replays the transcript, so an
    // oversized read is paid for again on each subsequent step.
    expect(capped.body.split("\n").length).toBe(DEFAULT_CAPS.read.maxLines);
  });
});
