import { exec as execCb } from "node:child_process";
import { promises as fs } from "node:fs";
import * as nodePath from "node:path";
import { promisify } from "node:util";

import { DEFAULT_CAPS } from "./caps.js";
import { globStaticPrefix, globToRegExp, hasGlobMagic } from "./glob.js";
import type { ToolEnvironment, WorkspaceRestoreResult, WorkspaceSnapshot, WorkspaceSnapshotEntry } from "./types.js";

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
const SNAPSHOT_SKIP_DIRS = new Set([".git", "node_modules"]);
const SNAPSHOT_MAX_ENTRIES = 12_000;
const SNAPSHOT_MAX_BYTES = 64 * 1024 * 1024;

const captureWorkspaceSnapshot = async (root: string): Promise<WorkspaceSnapshot> => {
  const entries: Record<string, WorkspaceSnapshotEntry> = {};
  const excludedPaths = [".git/**", "**/node_modules/**"];
  let totalBytes = 0;
  let entryCount = 0;
  const fail = (reason: string): WorkspaceSnapshot => ({ complete: false, entries, excludedPaths, reason });
  const visit = async (relative: string): Promise<string | null> => {
    let names: string[];
    try {
      names = await fs.readdir(relative ? nodePath.join(root, relative) : root);
    } catch (error) {
      return `cannot list ${relative || "."}: ${error instanceof Error ? error.message : String(error)}`;
    }
    for (const name of names) {
      const rel = relative ? `${relative}/${name}` : name;
      if (relative === "" && SNAPSHOT_SKIP_DIRS.has(name)) continue;
      if (name === "node_modules" || name === ".git") continue;
      if (entryCount >= SNAPSHOT_MAX_ENTRIES) return `snapshot exceeded ${SNAPSHOT_MAX_ENTRIES} entries`;
      const absolute = nodePath.join(root, ...rel.split("/"));
      let stat;
      try {
        stat = await fs.lstat(absolute);
      } catch (error) {
        return `cannot inspect ${rel}: ${error instanceof Error ? error.message : String(error)}`;
      }
      const mode = stat.mode & 0o7777;
      entryCount += 1;
      if (stat.isDirectory()) {
        entries[rel] = { kind: "directory", mode };
        const error = await visit(rel);
        if (error) return error;
      } else if (stat.isFile()) {
        totalBytes += stat.size;
        if (totalBytes > SNAPSHOT_MAX_BYTES) return `snapshot exceeded ${SNAPSHOT_MAX_BYTES} bytes`;
        const content = await fs.readFile(absolute);
        entries[rel] = { kind: "file", mode, contentBase64: content.toString("base64") };
      } else if (stat.isSymbolicLink()) {
        entries[rel] = { kind: "symlink", mode, target: await fs.readlink(absolute) };
      } else {
        return `unsupported filesystem entry: ${rel}`;
      }
    }
    return null;
  };
  const error = await visit("");
  return error ? fail(error) : { complete: true, entries, excludedPaths };
};

const sameSnapshotEntry = (left: WorkspaceSnapshotEntry | undefined, right: WorkspaceSnapshotEntry | undefined): boolean =>
  JSON.stringify(left) === JSON.stringify(right);

const restoreWorkspaceSnapshot = async (
  root: string,
  before: WorkspaceSnapshot,
  after: WorkspaceSnapshot,
  paths: string[],
): Promise<WorkspaceRestoreResult> => {
  if (!before.complete || !after.complete) throw new Error("cannot restore an incomplete workspace snapshot");
  for (const rel of paths) {
    if (!rel || nodePath.isAbsolute(rel) || rel.split(/[\\/]/).some((part) => !part || part === "." || part === ".." || part === ".git" || part === "node_modules")) {
      throw new Error(`invalid or excluded snapshot path: ${rel}`);
    }
  }
  const current = await captureWorkspaceSnapshot(root);
  if (!current.complete) throw new Error(`cannot verify workspace before restore: ${current.reason ?? "snapshot incomplete"}`);
  const conflicts = paths.filter((rel) => !sameSnapshotEntry(current.entries[rel], after.entries[rel]));
  if (conflicts.length) return { restoredPaths: [], conflicts };

  const uniquePaths = [...new Set(paths)];
  const selectedPaths = new Set(uniquePaths);
  const ensureDirectoryRemovable = async (rel: string): Promise<void> => {
    const absolute = nodePath.resolve(root, ...rel.split("/"));
    for (const name of await fs.readdir(absolute)) {
      const child = `${rel}/${name}`;
      if (!selectedPaths.has(child)) throw new Error(`cannot restore ${rel}; it contains unsnapshotted path ${child}`);
      const childPath = nodePath.join(absolute, name);
      if ((await fs.lstat(childPath)).isDirectory()) await ensureDirectoryRemovable(child);
    }
  };
  for (const rel of uniquePaths) {
    const desired = before.entries[rel];
    const present = current.entries[rel];
    if (present?.kind === "directory" && (!desired || desired.kind !== "directory")) await ensureDirectoryRemovable(rel);
  }

  const ordered = [...uniquePaths].sort((a, b) => b.split("/").length - a.split("/").length || b.localeCompare(a));
  for (const rel of ordered) {
    const desired = before.entries[rel];
    const present = current.entries[rel];
    if (!present || (desired && present.kind === desired.kind)) continue;
    const absolute = nodePath.resolve(root, ...rel.split("/"));
    if (!isInside(nodePath.resolve(root), absolute)) throw new Error(`snapshot path escapes workspace: ${rel}`);
    if (present.kind === "directory") await fs.rmdir(absolute);
    else await fs.rm(absolute, { force: true });
  }

  const restoring = uniquePaths.filter((rel) => before.entries[rel]).sort((a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b));
  for (const rel of restoring) {
    const entry = before.entries[rel]!;
    const absolute = nodePath.resolve(root, ...rel.split("/"));
    if (!isInside(nodePath.resolve(root), absolute)) throw new Error(`snapshot path escapes workspace: ${rel}`);
    await fs.mkdir(nodePath.dirname(absolute), { recursive: true });
    if (entry.kind === "directory") {
      await fs.mkdir(absolute, { recursive: true });
      await fs.chmod(absolute, entry.mode);
    } else if (entry.kind === "file") {
      await fs.writeFile(absolute, Buffer.from(entry.contentBase64, "base64"));
      await fs.chmod(absolute, entry.mode);
    } else {
      try { await fs.unlink(absolute); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      await fs.symlink(entry.target, absolute);
    }
  }
  return { restoredPaths: uniquePaths, conflicts: [] };
};

const resolveInside = (cwd: string, path: string): string => {
  const abs = nodePath.resolve(cwd, path);
  const root = nodePath.resolve(cwd);
  if (abs !== root && !abs.startsWith(root + nodePath.sep)) {
    throw new Error(`path escapes workspace root: ${path}`);
  }
  return abs;
};

const isInside = (root: string, candidate: string): boolean =>
  candidate === root || candidate.startsWith(root + nodePath.sep);

const resolveSafe = async (
  root: string,
  path: string,
  allowMissing = false,
): Promise<string> => {
  const abs = resolveInside(root, path);
  const realRoot = await fs.realpath(root);
  let cursor = abs;
  const suffix: string[] = [];

  for (;;) {
    try {
      const realCursor = await fs.realpath(cursor);
      const realCandidate = nodePath.resolve(realCursor, ...suffix);
      if (!isInside(realRoot, realCandidate)) {
        throw new Error(`path escapes workspace root: ${path}`);
      }
      return abs;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (!allowMissing || (code !== "ENOENT" && code !== "ENOTDIR")) {
        throw error;
      }

      try {
        const entry = await fs.lstat(cursor);
        if (entry.isSymbolicLink()) {
          throw new Error(`symlink paths are not allowed: ${path}`);
        }
      } catch (statError) {
        const statCode = (statError as NodeJS.ErrnoException).code;
        if (statCode !== "ENOENT" && statCode !== "ENOTDIR") {
          throw statError;
        }
      }

      const parent = nodePath.dirname(cursor);
      if (parent === cursor) {
        throw error;
      }
      suffix.unshift(nodePath.basename(cursor));
      cursor = parent;
    }
  }
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
  includeHidden: boolean,
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
    if ((!includeHidden && entry.name.startsWith(".")) || SKIP_DIRS.has(entry.name)) {
      continue;
    }
    const rel = dir === "." ? entry.name : `${dir}/${entry.name}`;
    if (entry.isDirectory()) {
      await grepDir(absRoot, rel, re, perFileCounts, out, maxMatches, includeHidden);
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
 * Walk the workspace collecting paths matching `pattern`.
 *
 * Skips straight to the pattern's literal prefix when it has one, so a pattern
 * rooted at a directory never traverses the rest of the repository.
 */
const globFiles = async (
  root: string,
  pattern: string,
  startDir: string,
  includeHidden: boolean,
  limit: number,
): Promise<string[]> => {
  const re = globToRegExp(pattern);
  const found: string[] = [];

  const walk = async (relDir: string): Promise<void> => {
    if (found.length >= limit) return;
    let entries;
    try {
      entries = await fs.readdir(nodePath.join(root, relDir), { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (found.length >= limit) return;
      if ((!includeHidden && entry.name.startsWith(".")) || SKIP_DIRS.has(entry.name)) continue;
      const rel = relDir === "." ? entry.name : `${relDir}/${entry.name}`;
      if (entry.isDirectory()) {
        await walk(rel);
      } else if (entry.isFile() && re.test(rel)) {
        found.push(rel);
      }
    }
  };

  await walk(startDir === "." ? "." : startDir);
  return found.sort();
};

/**
 * Local-filesystem ToolEnvironment rooted at `cwd` (paths may not escape it).
 * Grep and glob are portable in-process walks — no ripgrep/git dependency.
 */
export const createNodeEnvironment = (cwd: string): ToolEnvironment => {
  const root = nodePath.resolve(cwd);

  return {
    readFile: async (path) => fs.readFile(await resolveSafe(root, path), "utf8"),

    writeFile: async (path, content) => {
      const abs = await resolveSafe(root, path, true);
      await fs.mkdir(nodePath.dirname(abs), { recursive: true });
      await fs.writeFile(abs, content, "utf8");
    },

    deleteFile: async (path) => {
      await fs.unlink(await resolveSafe(root, path));
    },

    exists: async (path) => {
      try {
        await resolveSafe(root, path);
        return true;
      } catch {
        return false;
      }
    },

    readdir: async (dir) => {
      const entries = await fs.readdir(await resolveSafe(root, dir), { withFileTypes: true });
      return entries.map((e) => ({
        name: e.name,
        type: (e.isDirectory() ? "directory" : "file") as "file" | "directory",
      }));
    },

    grep: async ({ pattern, path, ignoreCase, includeHidden }) => {
      const re = toRegExp(pattern, ignoreCase ?? false);
      const out: string[] = [];
      const perFileCounts = new Map<string, number>();
      let startDir = ".";

      if (path?.trim()) {
        const raw = path.trim();
        // A glob in `path` is a file set, not a directory to walk blindly.
        if (hasGlobMagic(raw)) {
          const matches = await globFiles(root, raw, ".", includeHidden ?? false, DEFAULT_CAPS.grep.maxMatches);
          for (const rel of matches) {
            if (out.length >= DEFAULT_CAPS.grep.maxMatches) break;
            let content: string;
            try {
              content = await fs.readFile(nodePath.join(root, rel), "utf8");
            } catch {
              continue;
            }
            content.split("\n").forEach((line, i) => {
              if (out.length < DEFAULT_CAPS.grep.maxMatches && re.test(line)) {
                out.push(`${rel}:${i + 1}: ${line}`);
              }
            });
          }
          return out.join("\n");
        }
        const abs = await resolveSafe(root, raw);
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
      await grepDir(root, startDir, re, perFileCounts, out, DEFAULT_CAPS.grep.maxMatches, includeHidden ?? false);
      return out.join("\n");
    },

    glob: async ({ pattern, path, includeHidden, limit }) => {
      const cap = Math.max(1, Math.min(limit ?? DEFAULT_CAPS.glob.maxMatches, DEFAULT_CAPS.glob.maxMatches));
      const searchRoot = path?.trim() ? path.trim() : ".";
      const combined = searchRoot === "." || searchRoot === "" ? pattern : `${searchRoot.replace(/\/$/, "")}/${pattern}`;

      // Descend straight to the pattern's literal prefix when one exists.
      let startDir = ".";
      if (!hasGlobMagic(searchRoot) && searchRoot !== ".") {
        const abs = await resolveSafe(root, searchRoot);
        startDir = nodePath.relative(root, abs).split(nodePath.sep).join("/") || ".";
      } else {
        const prefix = globStaticPrefix(combined);
        if (prefix.length > 0) {
          const dir = prefix.join("/");
          try {
            await fs.stat(nodePath.join(root, dir));
            startDir = dir;
          } catch {
            startDir = ".";
          }
        }
      }
      return globFiles(root, combined, startDir, includeHidden ?? false, cap);
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
    snapshot: () => captureWorkspaceSnapshot(root),
    restoreSnapshot: (before, after, paths) => restoreWorkspaceSnapshot(root, before, after, paths),
  };
};
