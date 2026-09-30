import { exec as execCb } from "node:child_process";
import { promises as fs } from "node:fs";
import * as nodePath from "node:path";
import { promisify } from "node:util";

import { DEFAULT_CAPS } from "./caps.js";
import type { ToolEnvironment } from "./types.js";

const execAsync = promisify(execCb);

const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  ".next",
  "dist",
  "build",
  ".turbo",
  "coverage",
]);

const BINARY_EXT = /\.(png|jpe?g|gif|ico|woff2?|ttf|eot|gz|zip|tar|pdf|wasm|lock|map)$/i;

const resolveInside = (cwd: string, path: string): string => {
  const abs = nodePath.resolve(cwd, path);
  const root = nodePath.resolve(cwd);
  if (abs !== root && !abs.startsWith(root + nodePath.sep)) {
    throw new Error(`path escapes workspace root: ${path}`);
  }
  return abs;
};

const toRegExp = (pattern: string, ignoreCase: boolean): RegExp => {
  try {
    return new RegExp(pattern, ignoreCase ? "i" : "");
  } catch {
    const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(escaped, ignoreCase ? "i" : "");
  }
};

const grepDir = async (
  absRoot: string,
  dir: string,
  re: RegExp,
  perFileCounts: Map<string, number>,
  out: string[],
  maxMatches: number,
): Promise<void> => {
  if (out.length >= maxMatches) {
    return;
  }
  let entries;
  try {
    entries = await fs.readdir(nodePath.join(absRoot, dir), { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (out.length >= maxMatches) {
      return;
    }
    if (entry.name.startsWith(".") || SKIP_DIRS.has(entry.name)) {
      continue;
    }
    const rel = dir === "." ? entry.name : `${dir}/${entry.name}`;
    if (entry.isDirectory()) {
      await grepDir(absRoot, rel, re, perFileCounts, out, maxMatches);
      continue;
    }
    if (!entry.isFile() || BINARY_EXT.test(entry.name)) {
      continue;
    }
    const perFile = perFileCounts.get(rel) ?? 0;
    if (perFile >= DEFAULT_CAPS.grep.maxPerFile) {
      continue;
    }
    let content: string;
    try {
      content = await fs.readFile(nodePath.join(absRoot, rel), "utf8");
    } catch {
      continue;
    }
    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i] ?? "";
      if (!re.test(line)) {
        continue;
      }
      out.push(`${rel}:${i + 1}: ${line}`);
      perFileCounts.set(rel, (perFileCounts.get(rel) ?? 0) + 1);
      if (out.length >= maxMatches) {
        return;
      }
      if ((perFileCounts.get(rel) ?? 0) >= DEFAULT_CAPS.grep.maxPerFile) {
        break;
      }
    }
  }
};

/**
 * Local-filesystem ToolEnvironment rooted at `cwd` (paths may not escape it).
 * Grep is a portable in-process walk — no ripgrep/git dependency.
 */
export const createNodeEnvironment = (cwd: string): ToolEnvironment => {
  const root = nodePath.resolve(cwd);

  return {
    readFile: async (path) => fs.readFile(resolveInside(root, path), "utf8"),

    writeFile: async (path, content) => {
      const abs = resolveInside(root, path);
      await fs.mkdir(nodePath.dirname(abs), { recursive: true });
      await fs.writeFile(abs, content, "utf8");
    },

    exists: async (path) => {
      try {
        await fs.access(resolveInside(root, path));
        return true;
      } catch {
        return false;
      }
    },

    readdir: async (dir) => {
      const entries = await fs.readdir(resolveInside(root, dir), { withFileTypes: true });
      return entries.map((e) => ({
        name: e.name,
        type: (e.isDirectory() ? "directory" : "file") as "file" | "directory",
      }));
    },

    grep: async ({ pattern, path, ignoreCase }) => {
      const re = toRegExp(pattern, ignoreCase ?? false);
      const out: string[] = [];
      const perFileCounts = new Map<string, number>();
      let startDir = ".";
      if (path?.trim()) {
        const abs = resolveInside(root, path.trim());
        const rel = nodePath.relative(root, abs).split(nodePath.sep).join("/");
        let stat;
        try {
          stat = await fs.stat(abs);
        } catch {
          return "";
        }
        if (stat.isFile()) {
          const content = await fs.readFile(abs, "utf8");
          content.split("\n").forEach((line, i) => {
            if (out.length < DEFAULT_CAPS.grep.maxMatches && re.test(line)) {
              out.push(`${rel}:${i + 1}: ${line}`);
            }
          });
          return out.join("\n");
        }
        startDir = rel || ".";
      }
      await grepDir(root, startDir, re, perFileCounts, out, DEFAULT_CAPS.grep.maxMatches);
      return out.join("\n");
    },

    exec: async (command, opts) => {
      const timeoutMs = Math.max(1, opts?.timeoutSeconds ?? 120) * 1000;
      try {
        const { stdout, stderr } = await execAsync(command, {
          cwd: root,
          timeout: timeoutMs,
          maxBuffer: 8 * 1024 * 1024,
          env: { ...process.env, CI: "true", PAGER: "cat" },
        });
        return { stdout: stdout ?? "", stderr: stderr ?? "", exitCode: 0 };
      } catch (e) {
        const err = e as { stdout?: string; stderr?: string; code?: unknown; killed?: boolean };
        const killed = err.killed === true ? " (timed out)" : "";
        return {
          stdout: err.stdout ?? "",
          stderr: `${err.stderr ?? ""}${killed}`.trim(),
          exitCode: typeof err.code === "number" ? err.code : 1,
        };
      }
    },
  };
};
