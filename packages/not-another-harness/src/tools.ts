import { tool } from "ai";
import { z } from "zod";

import { detectScriptedMutation } from "./bash-guard.js";
import { DEFAULT_CAPS, capHead, capTail, resolveCaps, sliceFileLines, toLines, type CapsOverrides } from "./caps.js";
import { createOutlineTool } from "./outline.js";
import { createSearchLedger } from "./search-ledger.js";
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
   * Allow shell commands that rewrite files from an inline script (default
   * false). Left off on purpose: see `bash-guard.ts` for the failure it stops.
   * A saved-script codemod or a real tool like `prettier --write` needs no
   * escape hatch; only the inline interpreter does.
   */
  allowScriptedMutation?: boolean;
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
  /**
   * Override the tool-output caps for this run.
   *
   * The defaults are tuned for an interactive session on a repository, and a
   * different workload legitimately wants different numbers — a batch job that
   * only ever reads small files can afford more per read, and an agent reading a
   * generated file wants fewer. Without this the only options are the defaults or
   * a private copy of the tools.
   */
  caps?: CapsOverrides;
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
 * Refuse scripted rewrites before anything else happens.
 *
 * Applied at the map level rather than inside `bash`, because `withApproval`
 * wraps the tool and would otherwise sit *outside* it — asking a human to
 * approve a command whose scale they cannot possibly judge. A prompt for
 * `python3 - <<EOF ... open(f,'w').write(re.sub(...))` is worse than no prompt:
 * it looks like diligence and buys nothing. The guard has to be the outermost
 * wrapper, which is also why it holds in yolo mode where there is no prompt at
 * all.
 */
const guardScriptedMutation = <T extends { description?: string; execute?: (a: never, c: unknown) => Promise<string> }>(
  t: T,
  allow: boolean,
): T => {
  if (allow || typeof t.execute !== "function") return t;
  const original = t.execute.bind(t);
  return {
    ...t,
    execute: async (input: never, ctx: unknown) => {
      const command = (input as { command?: unknown } | undefined)?.command;
      const scripted = typeof command === "string" ? detectScriptedMutation(command) : null;
      return scripted ? scripted.message : original(input, ctx);
    },
  };
};

/**
 * Lines added and removed between two versions of a file.
 *
 * Counted as a multiset difference rather than a real diff, so it over-reports
 * when lines are merely reordered — fine, because it is only ever used as a
 * scale indicator. The point is that a change can report its own size, so a
 * rewrite that touched four hundred lines says so instead of returning the same
 * cheerful one-liner a two-line fix returns. The model needs that number at the
 * moment it decides what to do next; after the fact nobody diffs.
 */
const lineDelta = (before: string, after: string): { added: number; removed: number } => {
  const tally = (text: string): Map<string, number> => {
    const counts = new Map<string, number>();
    for (const line of toLines(text)) {
      counts.set(line, (counts.get(line) ?? 0) + 1);
    }
    return counts;
  };
  const beforeCounts = tally(before);
  const afterCounts = tally(after);
  let removed = 0;
  for (const [line, n] of beforeCounts) {
    removed += Math.max(0, n - (afterCounts.get(line) ?? 0));
  }
  let added = 0;
  for (const [line, n] of afterCounts) {
    added += Math.max(0, n - (beforeCounts.get(line) ?? 0));
  }
  return { added, removed };
};

/**
 * Report a change's size, but only once it is big enough to be worth the tokens.
 *
 * Below the threshold the notice would fire on almost every edit and train the
 * model to skim past it.
 */
const SCALE_NOTICE_AT = 20;

const changeSummary = (before: string, after: string): string => {
  const { added, removed } = lineDelta(before, after);
  if (added + removed < SCALE_NOTICE_AT) return "";
  return `\n[changed ${added} line(s), removed ${removed}] That is larger than a targeted edit. ` +
    "If that is not what you intended, revert it now and use `edit` with surrounding context.";
};

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
  // Resolved once so a cap cannot be tightened in one place and read from the
  // default in another — which is how two tools end up disagreeing about the same
  // limit.
  const caps = resolveCaps(options.caps);
  const requireRead = options.requireReadBeforeWrite !== false;
  const readPaths = new Set<string>();
  /**
   * Remembers which searches this run already answered, so `grep` can say when
   * it is being asked the same question twice.
   */
  const searches = createSearchLedger();

  const read = tool({
    description:
      "Read a file with 1-based line numbers. Large files are capped at " +
      `${caps.read.maxLines} lines — page further with offset/limit instead of re-reading.`,
    inputSchema: z.object({
      path: z.string().min(1).describe("File path"),
      offset: z.number().int().min(1).optional().describe("First line to read (1-based)"),
      limit: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe(`Max lines to return (capped at ${caps.read.maxLines})`),
    }),
    execute: async ({ path, offset, limit }) => {
      try {
        const content = await env.readFile(path);
        readPaths.add(normalizeWorkspacePath(path));
        const { body, totalLines, start, end } = sliceFileLines(content, offset, limit, caps.read.maxLines);
        /**
         * Say exactly what to call next.
         *
         * The old notice — "page with offset/limit" — named the parameters but
         * not the values, so the model reached for `bash` instead (`sed -n
         * '180,300p'`, `grep -n '^export'`) and paid for the same lines twice in
         * a form nothing could page. A notice that includes the literal next
         * `offset` removes the guesswork that sends the agent to the shell.
         */
        const notice =
          totalLines > end
            ? `\n[truncated: lines ${start}-${end} of ${totalLines}. Next: read with offset=${end + 1}. Do not re-read from the start.]`
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
    if (depth > maxDepth || lines.length > caps.list.maxLines) {
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
        caps.list.maxLines,
        caps.list.maxChars,
        "Narrow with path/maxDepth or use grep to find files by content.",
      );
    },
  });

  const grep = tool({
    description:
      "Search file contents. Returns matching FILE PATHS by default, not the matching lines — measured at ~9x fewer tokens, because most searches are triage and the lines are only needed for the one or two files you then read. " +
      "Pass outputMode:\"content\" for `path:line: text`, or \"count\" for a per-file tally. Prefer this over bash for finding symbols/strings; then read the specific files. `path` may be a file, a directory, or a glob.",
    inputSchema: z.object({
      pattern: z.string().min(1).describe("Text or regex to search for"),
      path: z.string().optional().describe("File/dir/glob filter (workspace-relative)"),
      outputMode: z
        .enum(["files_with_matches", "content", "count"])
        .optional()
        .describe(
          "files_with_matches: paths only (default). content: `path:line: text`. count: matches per file plus a total.",
        ),
      ignoreCase: z.boolean().optional(),
      includeHidden: z.boolean().optional().describe("Search dotfiles and dot-directories (default false)"),
      maxResults: z
        .number()
        .int()
        .min(1)
        .max(caps.grep.maxMatches)
        .optional()
        .describe(
          `Max results — files in the default mode, matching lines in "content" (default 50, max ${caps.grep.maxMatches})`,
        ),
    }),
    execute: async ({ pattern, path, outputMode, ignoreCase, includeHidden, maxResults }) => {
      const limit = Math.min(maxResults ?? 50, caps.grep.maxMatches);
      const mode = outputMode ?? "files_with_matches";
      let raw: string;
      try {
        raw = await env.grep({
          pattern,
          path,
          ignoreCase: ignoreCase ?? false,
          maxPerFile: caps.grep.maxPerFile,
          includeHidden: includeHidden ?? false,
        });
      } catch (e) {
        return `Error: ${e instanceof Error ? e.message : String(e)}`;
      }
      const lines = raw
        .split("\n")
        .map((l) => l.replace(/\r$/, ""))
        .filter((l) => l.trim().length > 0);
      if (lines.length === 0) {
        return `No matches for "${pattern}".`;
      }

      /**
       * The file part of a `path:line: text` record.
       *
       * The format is ambiguous and splitting on the first colon gets it wrong:
       * `od:d.ts:1: needle` must yield `od:d.ts`, not `od`. The line number is the
       * one unambiguous part — it is always digits followed by a colon — so match
       * on that and let the file be whatever precedes it, shortest first. This
       * stays correct when the matched *text* contains colons or something that
       * looks like a line number, because the first `:<digits>:` is the real one.
       */
      const fileOf = (line: string): string => /^(.*?):(\d+):/.exec(line)?.[1] ?? line;

      if (mode === "content") {
        const capped = lines.map((l) => truncate(l, caps.grep.lineMaxChars));
        const shown = capped.slice(0, limit);
        const more =
          capped.length > shown.length
            ? `\n[${capped.length - shown.length} more matches — narrow with path]`
            : "";
        const notice = searches.note(pattern, path, lines.map(fileOf)) ?? "";
        return `${shown.length} match${shown.length === 1 ? "" : "es"} for "${pattern}":\n${shown.join("\n")}${more}${notice}`;
      }

      const files = [...new Set(lines.map(fileOf))];
      const notice = searches.note(pattern, path, files) ?? "";

      if (mode === "count") {
        const counts = new Map<string, number>();
        for (const line of lines) {
          const file = fileOf(line);
          counts.set(file, (counts.get(file) ?? 0) + 1);
        }
        const entries = [...counts.entries()].slice(0, limit);
        const shown = entries.map(([file, n]) => `${n}  ${file}`);
        const total = lines.length;
        const more = counts.size > entries.length ? `\n[${counts.size - entries.length} more files]` : "";
        return `${total} match${total === 1 ? "" : "es"} in ${counts.size} file${counts.size === 1 ? "" : "s"}:\n${shown.join("\n")}${more}${notice}`;
      }

      // files_with_matches — the default, and roughly a ninth the tokens.
      const shown = files.slice(0, limit);
      const more =
        files.length > shown.length ? `\n[${files.length - shown.length} more files — narrow with path]` : "";
      const hint =
        shown.length === 1
          ? `\nTo see the matching lines: grep with path="${shown[0]}" and outputMode:"content".`
          : `\nTo see matching lines, re-run with outputMode:"content" — narrow with path to the file you care about first.`;
      return `${files.length} file${files.length === 1 ? "" : "s"} match "${pattern}":\n${shown.join("\n")}${more}${hint}${notice}`;
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
      searches.clear();
      return `Replaced ${replace_all === true ? occurrences : 1} occurrence${occurrences === 1 ? "" : "s"} in ${path}${changeSummary(content, next)}`;
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
      searches.clear();
      return `Wrote ${content.length} characters to ${path}${previous === undefined ? "" : changeSummary(previous, content)}`;
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
        .max(caps.glob.maxMatches)
        .optional()
        .describe(`Max paths to return (default ${caps.glob.maxMatches})`),
    }),
    execute: async ({ pattern, path, includeHidden, limit }) => {
      if (typeof env.glob !== "function") {
        return "Error: this environment does not support glob. Use list or bash find instead.";
      }
      const cap = Math.min(limit ?? caps.glob.maxMatches, caps.glob.maxMatches);
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
      "Run a shell command in the workspace root: builds, tests, git, installs. Output is tail-capped — 30 KB on success, 10 KB when the command fails — and the cap notice tells you how much was cut. " +
      "Do not use bash for file listing or content search (use list/grep). " +
      "Unlike the file tools, bash is NOT confined to the workspace root — it runs with the root as its working directory but can `cd` anywhere. That is deliberate: a shell cannot be reliably path-checked, and blocking it would break ordinary monorepo work like `git -C ../sibling`. Prefer the file tools for anything inside the workspace. " +
      "It will refuse an inline interpreter script that writes files (`python3 - <<EOF`, `node -e`, `perl -pi -e`): use edit/replace_all instead, or write a script file with `write` and run it. Running an interpreter purely to read or analyse is fine.",
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
        /**
         * A failing command gets a much tighter budget than a successful one.
         *
         * The useful part of a failure is at the end, and nobody needs 30 KB of
         * it; the reference implementation makes the same split, and it is the
         * cheapest saving available because failure output is where the bulk
         * tends to be.
         */
        const commandCaps = res.exitCode === 0 ? caps.bash : caps.bashFailure;
      // A shell command can have changed anything, so prior search results are no
      // longer a reliable answer to "have I already looked here?".
      searches.clear();
        /**
         * The notice deliberately does NOT suggest re-running with `| tail -n N`.
         *
         * That advice was the documented cause of a regression here: an audit run
         * capped at 120 lines had the agent re-execute the whole command to see the
         * tail, paying for byte-identical output a second time and ending up more
         * expensive than if it had never been capped. So it names what was cut and
         * points at the command's own output filter, which is cheap to re-run
         * because it was never the expensive part.
         */
        const hint = "Do not re-run the command to see the rest — re-run it with a narrower filter (| head, | grep, | tail) so the expensive work is not repeated.";
        const out = [
          res.stdout.trim().length > 0
            ? capTail(res.stdout, commandCaps.maxLines, commandCaps.maxChars, hint)
            : "",
          res.stderr.trim().length > 0
            ? `stderr:\n${capTail(res.stderr, commandCaps.maxLines, commandCaps.maxChars, hint)}`
            : "",
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
  // Outside the approval wrapper on purpose: see `guardScriptedMutation`.
  // Absent entirely when `withBash: false`, which is a supported configuration.
  if (tools.bash) {
    tools.bash = guardScriptedMutation(tools.bash as never, options.allowScriptedMutation === true);
  }
  return tools;
};
