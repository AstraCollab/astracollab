import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import * as nodePath from "node:path";

import { DEFAULT_CAPS } from "./caps.js";
import { globStaticPrefix, globToRegExp, hasGlobMagic } from "./glob.js";
import type { ToolEnvironment, WorkspaceRestoreResult, WorkspaceSnapshot, WorkspaceSnapshotEntry } from "./types.js";

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
    throw new Error(
      `${path} is outside the workspace root (${root}). ` +
        `Use a path inside it — if the target is in a sibling package or directory, ` +
        `address it from the root rather than with "..". ` +
        `bash is not confined to the root and can read it if you truly need that.`,
    );
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
  const realRealRoot = await fs.realpath(root);
  let cursor = abs;
  const suffix: string[] = [];

  for (;;) {
    try {
      const realCursor = await fs.realpath(cursor);
      const realCandidate = nodePath.resolve(realCursor, ...suffix);
      if (!isInside(realRealRoot, realCandidate)) {
        throw new Error(
          `${path} resolves outside the workspace root (${root}) through a symlink. ` +
            `Use a path inside the workspace that does not traverse a symlink out of it.`,
        );
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

/** Hard ceiling on captured output so a runaway command cannot exhaust memory. */
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

/**
 * Run a shell command in the workspace root.
 *
 * Three failure modes this deliberately fixes, each of which showed up as an
 * agent appearing to hang:
 *
 * 1. **stdin.** `exec` hands the child an open, never-written stdin pipe, so any
 *    command that reads stdin (`sed` with no file, `cat`, `grep` with no args)
 *    blocks until the timeout — two minutes at the default. Closing stdin gives
 *    those commands an immediate EOF instead.
 * 2. **Cancellation.** The AI SDK passes an abort signal to tool execution; a
 *    command that ignored it kept running after the user pressed Ctrl-C, and the
 *    run only stopped once it finished on its own.
 * 3. **Orphans.** `sh -c "a && b"` leaves grandchildren behind when only the
 *    shell is signalled, so a timed-out command kept burning CPU. Killing the
 *    whole process group cleans up after it.
 */
const runCommand = async (
  root: string,
  command: string,
  opts?: { timeoutSeconds?: number; signal?: AbortSignal },
): Promise<{ stdout: string; stderr: string; exitCode: number }> => {
  const timeoutMs = Math.max(1, opts?.timeoutSeconds ?? 120) * 1000;
  const signal = opts?.signal;

  if (signal?.aborted) {
    return { stdout: "", stderr: "aborted before start", exitCode: 130 };
  }

  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    let aborted = false;

    const child = spawn(command, {
      cwd: root,
      shell: true,
      // "ignore" is the fix for #1: stdin is at EOF, never a blocking pipe.
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
      env: { ...process.env, CI: "true", PAGER: "cat" },
    });

    const kill = () => {
      if (child.pid === undefined) return;
      try {
        // Negative pid targets the process group created by `detached`.
        process.kill(-child.pid, "SIGKILL");
      } catch {
        try {
          child.kill("SIGKILL");
        } catch {
          /* already gone */
        }
      }
    };

    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };

    const finish = (exitCode: number) => {
      if (settled) return;
      settled = true;
      cleanup();
      const note = aborted ? " (aborted)" : timedOut ? " (timed out)" : "";
      resolve({ stdout, stderr: `${stderr}${note}`.trim(), exitCode });
    };

    const onAbort = () => {
      aborted = true;
      kill();
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, timeoutMs);
    // Do not hold the event loop open for a command we are waiting on anyway.
    timer.unref?.();

    child.stdout?.on("data", (chunk: Buffer) => {
      if (stdout.length < MAX_OUTPUT_BYTES) stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      if (stderr.length < MAX_OUTPUT_BYTES) stderr += chunk.toString();
    });
    child.on("error", (error: Error) => {
      stderr += `\n${error.message}`;
      finish(1);
    });
    child.on("close", (code, sig) => {
      finish(sig ? 130 : (code ?? 0));
    });
  });
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

    exec: async (command, opts) => runCommand(root, command, opts),
    snapshot: () => captureWorkspaceSnapshot(root),
    restoreSnapshot: (before, after, paths) => restoreWorkspaceSnapshot(root, before, after, paths),
  };
};
