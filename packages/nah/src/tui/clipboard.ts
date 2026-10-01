/**
 * Clipboard support for the alternate-screen TUI.
 *
 * pi-tui's default copy path writes an OSC 52 escape sequence and then flashes
 * "Copied!" unconditionally. Terminals that do not implement OSC 52 — Terminal.app,
 * tmux without clipboard passthrough, several multiplexers — leave the system
 * clipboard untouched while the UI confidently claims success. Passing
 * `copySelection` lets the host do the copy itself and report what actually
 * happened, including failure.
 */
import { spawnSync } from "node:child_process";
import { getNativeClipboard, type NativeClipboard } from "@earendil-works/pi-tui";

type ClipboardTool = { command: string; args: string[] };

/** Detect a command-line clipboard writer for the current platform. */
export const detectClipboardTool = (
  platform: NodeJS.Platform = process.platform,
  which: (command: string) => boolean = hasCommand,
): ClipboardTool | undefined => {
  const candidates: Record<string, ClipboardTool[]> = {
    darwin: [{ command: "pbcopy", args: [] }],
    linux: [
      { command: "wl-copy", args: [] },
      { command: "xclip", args: ["-selection", "clipboard"] },
      { command: "xsel", args: ["--clipboard", "--input"] },
    ],
    win32: [{ command: "clip", args: [] }],
  };
  return (candidates[platform] ?? []).find((tool) => which(tool.command));
};

function hasCommand(command: string): boolean {
  const probe = spawnSync(process.platform === "win32" ? "where" : "command", process.platform === "win32" ? [command] : ["-v", command], {
    stdio: "ignore",
  });
  return probe.status === 0;
}

export type CopyResult = boolean | string;

export type ClipboardWriterOptions = {
  /** Injectable for tests. */
  native?: NativeClipboard | undefined;
  tool?: ClipboardTool | undefined | null;
};

/**
 * Build the `copySelection` callback for `TuiAltScreen`.
 *
 * Order: the native helper pi-tui ships (verified by contract — it rejects on
 * transfer failure), then a platform clipboard tool, and only then an honest
 * failure message rather than a false "Copied!".
 */
export const createClipboardWriter = (options: ClipboardWriterOptions = {}) => {
  // `in` rather than `!== undefined`: callers must be able to pass `undefined`
  // to mean "no clipboard here" for tests, which an `!== undefined` check would
  // silently turn back into the real native helper.
  const native = "native" in options ? options.native : getNativeClipboard();
  const tool = "tool" in options ? options.tool : detectClipboardTool();

  return async (text: string): Promise<CopyResult> => {
    if (text.length === 0) return "Nothing selected";

    if (native?.setText) {
      try {
        await native.setText(text);
        return true;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        // Fall through: a working CLI tool is better than an error.
        if (!tool) return `Copy failed: ${message}`;
      }
    }

    if (tool) {
      try {
        const result = spawnSync(tool.command, tool.args, {
          input: text,
          encoding: "utf8",
        });
        if (result.status === 0) return true;
        const stderr = typeof result.stderr === "string" ? result.stderr.trim() : "";
        return stderr ? `Copy failed: ${stderr}` : "Copy failed";
      } catch (error) {
        return `Copy failed: ${error instanceof Error ? error.message : String(error)}`;
      }
    }

    return "No clipboard available — install wl-clipboard / xclip / xsel, or use a terminal that supports OSC 52";
  };
};
