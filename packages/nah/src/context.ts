import { promises as fs } from "node:fs";
import * as nodePath from "node:path";
import { createHash } from "node:crypto";
import * as os from "node:os";

import { buildSystemPrompt } from "@astracollab/not-another-harness";

/** Discover AGENTS.md / CLAUDE.md upward from cwd (Pi/Claude-Code convention). */
export const loadContextFiles = async (
  cwd: string,
): Promise<Array<{ path: string; content: string }>> => {
  const out: Array<{ path: string; content: string }> = [];
  const seen = new Set<string>();
  let dir = nodePath.resolve(cwd);
  for (;;) {
    for (const name of ["AGENTS.md", "CLAUDE.md"]) {
      const p = nodePath.join(dir, name);
      const key = p.toLowerCase();
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      try {
        const content = await fs.readFile(p, "utf8");
        if (content.trim()) {
          out.push({ path: nodePath.relative(cwd, p) || name, content: content.trim() });
        }
      } catch {
        // not present at this level
      }
    }
    const parent = nodePath.dirname(dir);
    if (parent === dir) {
      break;
    }
    dir = parent;
  }
  return out;
};

export const buildNahSystemPrompt = async (cwd: string): Promise<string> => {
  const contextFiles = await loadContextFiles(cwd);
  return buildSystemPrompt({ cwdLabel: cwd, contextFiles });
};

export const defaultSessionFile = (cwd: string): string =>
  nodePath.join(
    os.homedir(),
    ".nah",
    "sessions",
    `${createHash("sha1").update(nodePath.resolve(cwd)).digest("hex").slice(0, 12)}.jsonl`,
  );

export const resolveSessionFile = (cwd: string, reference: string): string => {
  const defaultFile = defaultSessionFile(cwd);
  const sessionPrefix = nodePath.basename(defaultFile, ".jsonl");
  const isSessionId = /^[a-f0-9]{12}(?:-[0-9]+)?(?:\.[a-zA-Z0-9_-]{1,48})?$/i.test(reference);
  if (
    isSessionId &&
    (reference === sessionPrefix || reference.startsWith(`${sessionPrefix}-`) || reference.startsWith(`${sessionPrefix}.`))
  ) {
    return nodePath.join(nodePath.dirname(defaultFile), `${reference}.jsonl`);
  }
  return nodePath.resolve(cwd, reference);
};

const sessionPrefixFor = (cwd: string): string => nodePath.basename(defaultSessionFile(cwd), ".jsonl");

/** Every session file belonging to this cwd, newest first. */
const listSessions = async (cwd: string): Promise<Array<{ id: string; path: string; modified: number }>> => {
  const defaultFile = defaultSessionFile(cwd);
  const directory = nodePath.dirname(defaultFile);
  const prefix = sessionPrefixFor(cwd);
  try {
    const names = await fs.readdir(directory);
    const found = await Promise.all(
      names
        .filter(
          (name) =>
            name.endsWith(".jsonl") &&
            (name === `${prefix}.jsonl` || name.startsWith(`${prefix}-`) || name.startsWith(`${prefix}.`)),
        )
        .map(async (name) => {
          const path = nodePath.join(directory, name);
          try {
            const info = await fs.stat(path);
            return { id: name.slice(0, -".jsonl".length), path, modified: info.mtimeMs };
          } catch {
            return null;
          }
        }),
    );
    return found
      .filter((entry): entry is { id: string; path: string; modified: number } => entry !== null)
      .sort((a, b) => b.modified - a.modified);
  } catch {
    return [];
  }
};

const hasContent = async (file: string): Promise<boolean> => {
  try {
    const info = await fs.stat(file);
    return info.size > 0;
  } catch {
    return false;
  }
};

/**
 * The session `-c` should resume: the most recently touched one for this cwd.
 *
 * Previously this was hardcoded to the default filename. Now that each fresh run
 * allocates its own file, the "most recent session" is whichever was written
 * last — otherwise `--continue` would keep reopening the first, empty one.
 */
export const latestSessionFile = async (cwd: string): Promise<string> => {
  const sessions = await listSessions(cwd);
  return sessions[0]?.path ?? defaultSessionFile(cwd);
};

/**
 * A fresh session file for a new run.
 *
 * Reusing the default file meant a "new" run silently chained its messages onto
 * the previous run's tail: the file grew, but the transcript started empty, so
 * prior history was invisible yet unreachable. Each run now gets its own file,
 * following the same convention as `/session new` and `/branch <name>`. The
 * default file is still used for the very first run in a directory.
 */
export const allocateSessionFile = async (cwd: string): Promise<string> => {
  const defaultFile = defaultSessionFile(cwd);
  if (!(await hasContent(defaultFile))) {
    return defaultFile;
  }
  const taken = new Set((await listSessions(cwd)).map((session) => session.id));
  const prefix = sessionPrefixFor(cwd);
  for (let n = 2; n < 10_000; n += 1) {
    const id = `${prefix}-${n}`;
    if (taken.has(id)) continue;
    return nodePath.join(nodePath.dirname(defaultFile), `${id}.jsonl`);
  }
  // Practically unreachable; a timestamp still guarantees uniqueness.
  return `${defaultFile.replace(/\.jsonl$/, `-${Date.now()}.jsonl`)}`;
};

/** Session ids for this cwd, newest first (used by `/session list`). */
export const listSessionIds = async (cwd: string): Promise<Array<{ id: string; modified: number }>> =>
  (await listSessions(cwd)).map(({ id, modified }) => ({ id, modified }));

/** Read @file inclusions (Pi-style) and prepend them to the prompt. */
export const withFileInclusions = async (
  cwd: string,
  files: string[],
  prompt: string,
): Promise<string> => {
  if (files.length === 0) {
    return prompt;
  }
  const parts: string[] = [];
  for (const f of files) {
    try {
      const content = await fs.readFile(nodePath.resolve(cwd, f), "utf8");
      parts.push(`<file path="${f}">\n${content}\n</file>`);
    } catch {
      parts.push(`<file path="${f}">[could not read file]</file>`);
    }
  }
  return [...parts, "", prompt].join("\n");
};
