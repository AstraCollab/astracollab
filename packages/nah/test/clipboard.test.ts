import { describe, expect, it } from "vitest";
import { Key, matchesKey } from "@earendil-works/pi-tui";

import { createClipboardWriter, detectClipboardTool } from "../src/tui/clipboard.js";

const fakeNative = (impl: Partial<{ setText(text: string): Promise<void>; getText(): Promise<string | null> }>) =>
  impl as never;

describe("clipboard tool detection", () => {
  it("prefers the platform's own tool", () => {
    expect(detectClipboardTool("darwin", () => true)?.command).toBe("pbcopy");
    expect(detectClipboardTool("win32", () => true)?.command).toBe("clip");
  });

  it("walks the Linux candidates in order", () => {
    expect(detectClipboardTool("linux", (c) => c === "xclip")?.command).toBe("xclip");
    expect(detectClipboardTool("linux", () => false)).toBeUndefined();
    expect(detectClipboardTool("aix" as NodeJS.Platform, () => true)).toBeUndefined();
  });
});

describe("clipboard writer reports the truth", () => {
  it("returns true only when the native helper really accepted the text", async () => {
    let written: string | null = null;
    const write = createClipboardWriter({
      native: fakeNative({ setText: async (t) => void (written = t) }),
      tool: null,
    });
    expect(await write("hello")).toBe(true);
    expect(written).toBe("hello");
  });

  it("reports failure instead of a false 'Copied!' when nothing can copy", async () => {
    // This is the bug being fixed: pi-tui's default path claims success while
    // writing an OSC 52 escape the terminal may ignore.
    const write = createClipboardWriter({ native: undefined, tool: null });
    const result = await write("some selected text");
    expect(result).not.toBe(true);
    expect(typeof result).toBe("string");
    expect(result).toMatch(/clipboard/i);
  });

  it("falls back to a platform tool when the native helper throws", async () => {
    const write = createClipboardWriter({
      native: fakeNative({
        setText: async () => {
          throw new Error("pasteboard unavailable");
        },
      }),
      // A stand-in for pbcopy: reads stdin and exits 0.
      tool: { command: process.execPath, args: ["-e", "process.stdin.resume()"] },
    });
    expect(await write("recovered via tool")).toBe(true);
  });

  it("reports failure when the platform tool also fails", async () => {
    const write = createClipboardWriter({
      native: undefined,
      tool: { command: process.execPath, args: ["-e", "process.exit(3)"] },
    });
    const result = await write("text");
    expect(result).toBe("Copy failed");
  });

  it("refuses to copy nothing", async () => {
    const write = createClipboardWriter({ native: fakeNative({ setText: async () => {} }), tool: null });
    expect(await write("")).toBe("Nothing selected");
  });

  it("surfaces the native error when there is no fallback", async () => {
    const write = createClipboardWriter({
      native: fakeNative({
        setText: async () => {
          throw new Error("pasteboard locked");
        },
      }),
      tool: null,
    });
    const result = await write("text");
    expect(result).toBe("Copy failed: pasteboard locked");
  });
});

describe("copy keybinding does not collide with abort", () => {
  const CMD_C = "\x1b[99;9u";
  const CTRL_C = "\x03";

  it("distinguishes Cmd+C from Ctrl+C", () => {
    expect(matchesKey(CMD_C, Key.super("c"))).toBe(true);
    expect(matchesKey(CTRL_C, Key.ctrl("c"))).toBe(true);
    // The collision that would break abort if we keyed off a single byte.
    expect(matchesKey(CMD_C, Key.ctrl("c"))).toBe(false);
    expect(matchesKey(CTRL_C, Key.super("c"))).toBe(false);
  });

  it("also accepts Ctrl+Shift+C as a copy key", () => {
    expect(matchesKey("\x1b[99;6u", Key.ctrlShift("c"))).toBe(true);
  });
});
