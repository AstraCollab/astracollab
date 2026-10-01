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
