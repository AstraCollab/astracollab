/**
 * Opening a URL in the user's browser.
 *
 * The last step of `/studio`, and the one most likely to be wrong on somebody
 * else's machine: the same command opens a browser on macOS, fails silently on a
 * Linux box with no `xdg-open`, and needs `start ""` on Windows because a bare
 * `start <url>` opens the URL in a command prompt window.
 *
 * Probed rather than assumed, and every platform has a fallback of printing the
 * URL — a command that puts the link somewhere you can click it is a success;
 * one that silently does nothing is not.
 */
import { spawn, spawnSync } from "node:child_process";

type OpenTool = { command: string; args: string[] };

const hasCommand = (command: string, platform: NodeJS.Platform = process.platform): boolean => {
  const probe = spawnSync(platform === "win32" ? "where" : "command", platform === "win32" ? [command] : ["-v", command], {
    stdio: "ignore",
  });
  return probe.status === 0;
};

export const detectOpenTool = (
  platform: NodeJS.Platform = process.platform,
  which: (command: string) => boolean = (command: string) => hasCommand(command, platform),
): OpenTool | null => {
  // Partial by design: the three platforms people run this on are listed, and
  // anything else falls through to printing the URL rather than to a guess.
  const candidates: Partial<Record<NodeJS.Platform, OpenTool[]>> = {
    darwin: [{ command: "open", args: [] }],
    // `xdg-open` is the standard on a desktop Linux; the rest are what a headless
    // or minimal box actually has, and a text browser is a better answer than
    // nothing when someone is SSHed in and wants to read the traces.
    linux: [
      { command: "xdg-open", args: [] },
      { command: "gio", args: ["open"] },
      { command: "gnome-open", args: [] },
      { command: "wslview", args: [] },
      { command: "x-www-browser", args: [] },
    ],
    win32: [{ command: "cmd", args: ["/c", "start", ""] }],
  };
  return (candidates[platform] ?? []).find((tool) => which(tool.command)) ?? null;
};

export type OpenResult = { opened: boolean; reason?: string };

/**
 * Open a URL, detached.
 *
 * Detached and unref'd, because the browser is not ours to wait for: a window
 * that takes four seconds to appear must not delay the command that printed its
 * URL, and closing `nah` must not close the browser.
 */
export const openUrl = async (
  url: string,
  options: {
    platform?: NodeJS.Platform;
    tool?: OpenTool | null;
    which?: (command: string) => boolean;
    spawnProcess?: typeof spawn;
  } = {},
): Promise<OpenResult> => {
  const platform = options.platform ?? process.platform;
  const tool = options.tool === undefined ? detectOpenTool(platform, options.which) : options.tool;
  if (!tool) return { opened: false, reason: "no way to open a browser here" };
  const spawnProcess = options.spawnProcess ?? spawn;
  try {
    const child = spawnProcess(tool.command, [...tool.args, url], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.unref();
    return { opened: true };
  } catch (error) {
    return { opened: false, reason: error instanceof Error ? error.message : String(error) };
  }
};
