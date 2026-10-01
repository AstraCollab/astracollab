import { tool } from "ai";
import { z } from "zod";

import { DEFAULT_CAPS, capHead, capTail, sliceFileLines } from "./caps.js";
import { createOutlineTool } from "./outline.js";
import type { ToolEnvironment } from "./types.js";

export type ApprovalDecision = "allow" | "deny";

export type CodingToolsOptions = {
  /** Read-before-edit/write for existing files (default true, like Claude Code). */
  requireReadBeforeWrite?: boolean;
  /** Include the bash tool (default true). Disable for read-only agents. */
  withBash?: boolean;
  /** Include the glob discovery tool when the environment supports it (default true). */
  withGlob?: boolean;
  /** Include the repository outline tool (default true). */
  withOutline?: boolean;
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

/** Default gate scope: read/list/grep/glob are always auto-allowed. */
export const APPROVAL_GATED_TOOLS = new Set(["edit", "write", "bash"]);

/**
 * Lexically normalize a workspace-relative path so that `./a/b`, `a//b`, and
 * `a/b` are treated as the same file. Without this the read-before-write gate
 * rejects an edit the model just performed a valid read for, purely because the
 * two path spellings differ — which reads to the model like a broken tool.
 */
export const normalizeWorkspacePath = (path: string): string => {
  const segments: string[] = [];
  for (const segment of path.split(/[/\\]+/)) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  return segments.join("/") || ".";
};

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
        readPaths.add(normalizeWorkspacePath(path));
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
      "Search file contents — returns capped `path:line: text` matches. Prefer this over bash for finding symbols/strings; then read the specific files. `path` may be a file, a directory, or a glob.",
    inputSchema: z.object({
      pattern: z.string().min(1).describe("Text or regex to search for"),
      path: z.string().optional().describe("File/dir/glob filter (workspace-relative)"),
      ignoreCase: z.boolean().optional(),
      includeHidden: z.boolean().optional().describe("Search dotfiles and dot-directories (default false)"),
      maxResults: z
        .number()
        .int()
        .min(1)
        .max(DEFAULT_CAPS.grep.maxMatches)
        .optional()
        .describe(`Max matching lines (default 50, max ${DEFAULT_CAPS.grep.maxMatches})`),
    }),
    execute: async ({ pattern, path, ignoreCase, includeHidden, maxResults }) => {
      const limit = Math.min(maxResults ?? 50, DEFAULT_CAPS.grep.maxMatches);
      let raw: string;
      try {
        raw = await env.grep({
          pattern,
          path,
          ignoreCase: ignoreCase ?? false,
          maxPerFile: DEFAULT_CAPS.grep.maxPerFile,
          includeHidden: includeHidden ?? false,
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
    /**
     * Anthropic's tool-design guidance calls the description "by far the most
     * important factor in tool performance", and asks for 3-4 sentences: what it
     * does, when to use it and when not to, what each parameter means, and the
     * caveats. This was one sentence, so uniqueness failures and read-first
     * behaviour were left to guesswork.
     */
    description:
      "Replace an exact, contiguous run of text in one file. Use it for a targeted change to an existing file; use `write` for a new file or a full rewrite, and a single scripted `bash` pass when the same mechanical change applies across many files. " +
      "`old_string` must match the file byte for byte, including indentation, and must appear exactly once unless `replace_all` is true - include a few surrounding lines of context to make it unique. " +
      "Pass the text WITHOUT the line-number prefixes that `read` adds; the prefixes are for you to navigate with, not part of the file. " +
      "You do not need to read a file before replacing text in it: if you already know the exact string, edit directly, and if the match fails the error reports how many occurrences were found. " +
      "Set `replace_all` only when every occurrence in that one file should change - it never reaches other files.",
    inputSchema: z.object({
      path: z.string().min(1),
      old_string: z.string(),
      new_string: z.string(),
      replace_all: z.boolean().optional(),
    }),
    execute: async ({ path, old_string, new_string, replace_all }) => {
      const key = normalizeWorkspacePath(path);
      if (requireRead && !readPaths.has(key)) {
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
      if (replace_all === true && old_string.trim().length <= 3 && occurrences > 1) {
        return `Error: replace_all is blocked for ambiguous strings of three characters or fewer (${occurrences} matches in ${path}). Use a longer exact phrase with context to avoid changing common words throughout the file.`;
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
      readPaths.add(key);
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
      const key = normalizeWorkspacePath(path);
      if (requireRead && !readPaths.has(key) && (await env.exists(path))) {
        return `Error: read "${path}" with the read tool before overwriting.`;
      }
      const existed = await env.exists(path);
      const previous = existed ? await env.readFile(path) : undefined;
      await env.writeFile(path, content);
      options.onFileWrite?.({ path, existed, ...(previous === undefined ? {} : { content: previous }), after: content });
      readPaths.add(key);
      return `Wrote ${content.length} characters to ${path}`;
    },
  });

  const glob = tool({
    description:
      "Find files by name/path pattern before reading them — supports `*` (within a segment), `**` (any depth), `?`, and `{a,b}`. " +
      "Use this to locate a file or to enumerate a set of files (e.g. `**/page.tsx`, `apps/*/src/**/*.tsx`, `**/*.{test,spec}.ts`) " +
      "instead of walking directories one level at a time. Returns workspace-relative paths.",
    inputSchema: z.object({
      pattern: z.string().min(1).describe("Glob pattern, e.g. **/page.tsx"),
      path: z.string().optional().describe("Directory to search under (default .)"),
      includeHidden: z.boolean().optional().describe("Include dotfiles (default false)"),
      limit: z
        .number()
        .int()
        .min(1)
        .max(DEFAULT_CAPS.glob.maxMatches)
        .optional()
        .describe(`Max paths to return (default ${DEFAULT_CAPS.glob.maxMatches})`),
    }),
    execute: async ({ pattern, path, includeHidden, limit }) => {
      if (typeof env.glob !== "function") {
        return "Error: this environment does not support glob. Use list or bash find instead.";
      }
      const cap = Math.min(limit ?? DEFAULT_CAPS.glob.maxMatches, DEFAULT_CAPS.glob.maxMatches);
      try {
        const matches = await env.glob({ pattern, path, includeHidden: includeHidden ?? false, limit: cap });
        if (matches.length === 0) {
          return `No files match "${pattern}"${path ? ` under ${path}` : ""}.`;
        }
        return `${matches.length} match${matches.length === 1 ? "" : "es"} for "${pattern}":\n${matches.join("\n")}`;
      } catch (e) {
        return `Error: ${e instanceof Error ? e.message : String(e)}`;
      }
    },
  });

  const bash = tool({
    description:
      "Run a shell command in the workspace root: builds, tests, git, installs. Output is tail-capped (last 300 lines / 30 KB) — re-run narrower (e.g. `tail`) when you need specific output. Do not use bash for file listing or content search (use list/grep).",
    inputSchema: z.object({
      command: z.string().min(1),
      timeoutSeconds: z.number().int().min(1).max(1800).optional().describe("Default 120s"),
    }),
    execute: async ({ command, timeoutSeconds }, callOptions) => {
      try {
        // `callOptions.abortSignal` comes from the AI SDK and is what makes
        // Ctrl-C stop a long command instead of merely looking like it did.
        const res = await env.exec(command, {
          timeoutSeconds: timeoutSeconds ?? 120,
          signal: (callOptions as { abortSignal?: AbortSignal } | undefined)?.abortSignal,
        });
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
  if (options.withOutline !== false) {
    tools.outline = createOutlineTool(env);
  }
  if (options.withBash !== false) {
    tools.bash = bash;
  }
  if (options.withGlob !== false && typeof env.glob === "function") {
    tools.glob = glob;
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
