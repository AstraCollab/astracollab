import { tool } from "ai";
import { z } from "zod";

import { DEFAULT_CAPS, capHead, capTail, sliceFileLines } from "./caps.js";
import type { ToolEnvironment } from "./types.js";

export type ApprovalDecision = "allow" | "deny";

export type CodingToolsOptions = {
  /** Read-before-edit/write for existing files (default true, like Claude Code). */
  requireReadBeforeWrite?: boolean;
  /** Include the bash tool (default true). Disable for read-only agents. */
  withBash?: boolean;
  /** Working directory shown in tool descriptions (cosmetic). */
  cwdLabel?: string;
  /**
   * Approval gate for mutating tools (edit/write/bash). Called before the
   * side effect happens; return false/"deny" to refuse. When omitted,
   * everything is allowed (Pi-style trust).
   */
  approveToolCall?: (toolName: string, input: unknown) => Promise<boolean>;
  /** Called with the preimage immediately before each built-in file mutation. */
  onFileWrite?: (change: { path: string; existed: boolean; content?: string; after: string }) => void;
  /** Called after an approved shell command completes, for recovery/audit records. */
  onShellCommand?: (command: string) => void;
};

/** Default gate scope: read/list/grep are always auto-allowed. */
export const APPROVAL_GATED_TOOLS = new Set(["edit", "write", "bash"]);

const refused = (toolName: string): string =>
  `DENIED: the user rejected this ${toolName} call. Do not retry the same change; ` +
  "continue with what you have or explain what is blocked.";

/** Wrap mutating tools with an approval gate. */
const withApproval = <T extends { description?: string; execute?: (a: never, c: unknown) => Promise<string> }>(
  t: T,
  name: string,
  approve: (toolName: string, input: unknown) => Promise<boolean>,
): T => {
  if (typeof t.execute !== "function") {
    return t;
  }
  const original = t.execute.bind(t);
  return {
    ...t,
    execute: async (input: never, ctx: unknown) => {
      let ok = true;
      try {
        ok = await approve(name, input);
      } catch {
        ok = false;
      }
      if (!ok) {
        return refused(name);
      }
      return original(input, ctx);
    },
  };
};

const truncate = (s: string, max: number): string =>
  s.length > max ? `${s.slice(0, max)}…` : s;

/**
 * Pi-style minimal, capped tool set: read / list / grep / edit / write / bash.
 *
 * Search is a first-class tool (not unbounded shell) so the model stops burning
 * full-transcript steps on `git grep` — results arrive pre-capped as
 * `path:line: text`.
 */
export const createCodingTools = (
  env: ToolEnvironment,
  options: CodingToolsOptions = {},
): Record<string, unknown> => {
  const requireRead = options.requireReadBeforeWrite !== false;
  const readPaths = new Set<string>();

  const read = tool({
    description:
      "Read a file with 1-based line numbers. Large files are capped at " +
      `${DEFAULT_CAPS.read.maxLines} lines — page further with offset/limit instead of re-reading.`,
    inputSchema: z.object({
      path: z.string().min(1).describe("File path"),
      offset: z.number().int().min(1).optional().describe("First line to read (1-based)"),
      limit: z.number().int().min(1).optional().describe("Max lines (default/hard cap 400)"),
    }),
    execute: async ({ path, offset, limit }) => {
      try {
        const content = await env.readFile(path);
        readPaths.add(path);
        const { body, totalLines } = sliceFileLines(content, offset, limit);
        const notice =
          totalLines > (offset ?? 1) - 1 + Math.min(limit ?? DEFAULT_CAPS.read.maxLines, DEFAULT_CAPS.read.maxLines)
            ? `\n[file has ${totalLines} lines total — page with offset/limit]`
            : "";
        return `${body}${notice}`;
      } catch (e) {
        return `Error: ${e instanceof Error ? e.message : String(e)}`;
      }
    },
  });

  const buildTree = async (
    dir: string,
    depth: number,
    maxDepth: number,
    lines: string[],
    showHidden: boolean,
  ): Promise<void> => {
    if (depth > maxDepth || lines.length > DEFAULT_CAPS.list.maxLines) {
      return;
    }
    let entries;
    try {
      entries = await env.readdir(dir);
    } catch {
      return;
    }
    const filtered = entries
      .filter((e) => showHidden || !e.name.startsWith("."))
      .filter((e) => e.name !== "node_modules")
      .sort((a, b) =>
        a.type === b.type ? a.name.localeCompare(b.name) : a.type === "directory" ? -1 : 1,
      );
    for (const entry of filtered) {
      lines.push(`${"  ".repeat(depth)}${entry.name}${entry.type === "directory" ? "/" : ""}`);
      if (entry.type === "directory") {
        await buildTree(
          dir === "." ? entry.name : `${dir}/${entry.name}`,
          depth + 1,
          maxDepth,
          lines,
          showHidden,
        );
      }
    }
  };

  const list = tool({
    description:
      "List a directory as an indented tree (directories end with /). Narrow with path/maxDepth; output is capped — do not list the whole repo without a concrete reason.",
    inputSchema: z.object({
      path: z.string().optional().describe("Directory to list (default .)"),
      maxDepth: z.number().int().min(1).max(6).optional().describe("Tree depth (default 2)"),
      showHidden: z.boolean().optional().describe("Include dotfiles (default false)"),
    }),
    execute: async ({ path, maxDepth, showHidden }) => {
      const lines: string[] = [];
      await buildTree(path ?? ".", 0, maxDepth ?? 2, lines, showHidden ?? false);
      if (lines.length === 0) {
        return `(empty or missing directory: ${path ?? "."})`;
      }
      return capHead(
        lines.join("\n"),
        DEFAULT_CAPS.list.maxLines,
        DEFAULT_CAPS.list.maxChars,
        "Narrow with path/maxDepth or use grep to find files by content.",
      );
    },
  });

  const grep = tool({
    description:
      "Search file contents — returns capped `path:line: text` matches. Prefer this over bash for finding symbols/strings; then read the specific files.",
    inputSchema: z.object({
      pattern: z.string().min(1).describe("Text or regex to search for"),
      path: z.string().optional().describe("File/dir/glob filter (workspace-relative)"),
      ignoreCase: z.boolean().optional(),
      maxResults: z
        .number()
        .int()
        .min(1)
        .max(DEFAULT_CAPS.grep.maxMatches)
        .optional()
        .describe(`Max matching lines (default 50, max ${DEFAULT_CAPS.grep.maxMatches})`),
    }),
    execute: async ({ pattern, path, ignoreCase, maxResults }) => {
      const limit = Math.min(maxResults ?? 50, DEFAULT_CAPS.grep.maxMatches);
      let raw: string;
      try {
        raw = await env.grep({
          pattern,
          path,
          ignoreCase: ignoreCase ?? false,
          maxPerFile: DEFAULT_CAPS.grep.maxPerFile,
        });
      } catch (e) {
        return `Error: ${e instanceof Error ? e.message : String(e)}`;
      }
      const lines = raw
        .split("\n")
        .map((l) => l.replace(/\r$/, ""))
        .filter((l) => l.trim().length > 0)
        .map((l) => truncate(l, DEFAULT_CAPS.grep.lineMaxChars));
      if (lines.length === 0) {
        return `No matches for "${pattern}".`;
      }
      const shown = lines.slice(0, limit);
      const more = lines.length > shown.length ? `\n[truncated — narrow with path]` : "";
      return `${shown.length} match${shown.length === 1 ? "" : "es"} for "${pattern}":\n${shown.join("\n")}${more}`;
    },
  });

  const edit = tool({
    description:
      "Replace exact text in a file. old_string must match exactly and be unique (unless replace_all). Read the file first; do not include line-number prefixes in old_string/new_string.",
    inputSchema: z.object({
      path: z.string().min(1),
      old_string: z.string(),
      new_string: z.string(),
      replace_all: z.boolean().optional(),
    }),
    execute: async ({ path, old_string, new_string, replace_all }) => {
      if (requireRead && !readPaths.has(path)) {
        return `Error: read "${path}" with the read tool before editing.`;
      }
      let content: string;
      try {
        content = await env.readFile(path);
      } catch (e) {
        return `Error: ${e instanceof Error ? e.message : String(e)}`;
      }
      const occurrences = content.split(old_string).length - 1;
      if (occurrences === 0) {
        return `Error: old_string not found in ${path}. Re-read the file for current contents.`;
      }
      if (replace_all === true && old_string.trim().length <= 3) {
        return `Error: replace_all is blocked for strings of three characters or fewer (${occurrences} matches in ${path}). Use a longer exact phrase with context to avoid changing common words throughout the file.`;
      }
      if (occurrences > 1 && replace_all !== true) {
        return `Error: old_string appears ${occurrences} times in ${path}. Add surrounding context or set replace_all.`;
      }
      const next =
        replace_all === true
          ? content.split(old_string).join(new_string)
          : content.replace(old_string, new_string);
      await env.writeFile(path, next);
      options.onFileWrite?.({ path, existed: true, content, after: next });
      readPaths.add(path);
      return `Replaced ${replace_all === true ? occurrences : 1} occurrence${occurrences === 1 ? "" : "s"} in ${path}`;
    },
  });

  const write = tool({
    description:
      "Write a full file (creates parent dirs). Existing files must be read first — prefer edit for targeted changes to existing files.",
    inputSchema: z.object({
      path: z.string().min(1),
      content: z.string(),
    }),
    execute: async ({ path, content }) => {
      if (requireRead && !readPaths.has(path) && (await env.exists(path))) {
        return `Error: read "${path}" with the read tool before overwriting.`;
      }
      const existed = await env.exists(path);
      const previous = existed ? await env.readFile(path) : undefined;
      await env.writeFile(path, content);
      options.onFileWrite?.({ path, existed, ...(previous === undefined ? {} : { content: previous }), after: content });
      readPaths.add(path);
      return `Wrote ${content.length} characters to ${path}`;
    },
  });

  const bash = tool({
    description:
      "Run a shell command in the workspace root: builds, tests, git, installs. Output is tail-capped (last 300 lines / 30 KB) — re-run narrower (e.g. `tail`) when you need specific output. Do not use bash for file listing or content search (use list/grep).",
    inputSchema: z.object({
      command: z.string().min(1),
      timeoutSeconds: z.number().int().min(1).max(1800).optional().describe("Default 120s"),
    }),
    execute: async ({ command, timeoutSeconds }) => {
      try {
        const res = await env.exec(command, { timeoutSeconds: timeoutSeconds ?? 120 });
        options.onShellCommand?.(`${command} [exit ${res.exitCode}]`);
        const hint = "Re-run with a narrower command or `| tail -n N`.";
        const out = [
          res.stdout.trim().length > 0 ? capTail(res.stdout, DEFAULT_CAPS.bash.maxLines, DEFAULT_CAPS.bash.maxChars, hint) : "",
          res.stderr.trim().length > 0 ? `stderr:\n${capTail(res.stderr, 100, 10_000, hint)}` : "",
          `exit ${res.exitCode}`,
        ]
          .filter(Boolean)
          .join("\n");
        return out;
      } catch (e) {
        options.onShellCommand?.(`${command} [error: ${e instanceof Error ? e.message : String(e)}]`);
        return `Error: ${e instanceof Error ? e.message : String(e)}`;
      }
    },
  });

  const tools: Record<string, unknown> = { read, list, grep, edit, write };
  if (options.withBash !== false) {
    tools.bash = bash;
  }
  if (options.approveToolCall) {
    const approve = options.approveToolCall;
    for (const name of Object.keys(tools)) {
      if (APPROVAL_GATED_TOOLS.has(name)) {
        tools[name] = withApproval(tools[name] as never, name, approve);
      }
    }
  }
  return tools;
};
