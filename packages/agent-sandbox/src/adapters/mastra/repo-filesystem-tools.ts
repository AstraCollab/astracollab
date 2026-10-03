import * as nodePath from "node:path";
import { createTool, type Tool } from "@mastra/core/tools";
import {
  FileReadRequiredError,
  WORKSPACE_TOOLS,
  type WorkspaceFilesystem,
} from "@mastra/core/workspace";

import { replaceFileEditStrings } from "./edit-file-replace.js";
import picomatchImport from "picomatch";
import { z } from "zod";

import {
  coerceModelBoolean,
  zModelOptionalBoolean,
  zModelOptionalString,
} from "./zod-model-coercion.js";

/** CJS/ESM interop: some bundlers leave `default` undefined. */
const createPicomatchMatcher = (
  patterns: string[],
  opts: { posix?: boolean; dot?: boolean },
): ((path: string) => boolean) => {
  const pm =
    typeof picomatchImport === "function"
      ? picomatchImport
      : (picomatchImport as unknown as { default?: typeof picomatchImport }).default;
  if (typeof pm !== "function") {
    throw new Error(
      "picomatch is not available as a function — check bundling of @astracollab/agent-sandbox (picomatch default export).",
    );
  }
  return pm(patterns, opts) as (path: string) => boolean;
};

export type CreateCodingRepoFilesystemToolsOptions = {
  /**
   * When true (default), `mastra_workspace_write_file` requires a successful
   * `mastra_workspace_read_file` on the same normalized path first (Mastra default).
   */
  requireReadBeforeWrite?: boolean;
};

const posixJoin = (...parts: string[]): string => {
  const cleaned = parts.filter(Boolean).map((p) => p.replace(/\\/g, "/"));
  return nodePath.posix.join(...cleaned);
};

const normalizePathKey = (fs: WorkspaceFilesystem, path: string): string =>
  fs.resolveAbsolutePath?.(path) ?? path.replace(/\\/g, "/");

const isGlobLike = (value: string): boolean => /[*?[\]{}]/.test(value);

const sanitizeListPattern = (
  raw: string | string[] | undefined,
  listPath: string,
): string | string[] | undefined => {
  const pathNorm = String(listPath ?? ".").replace(/\\/g, "/");
  const badOne = (one: string): boolean => {
    const t = one.trim().replace(/\\/g, "/");
    if (!t.length) return true;
    if (t === pathNorm) return true;
    if (t.startsWith("/") && !isGlobLike(t)) return true;
    return false;
  };
  if (raw === undefined) return undefined;
  if (Array.isArray(raw)) {
    const ok = raw.filter((p) => typeof p === "string" && p.trim().length > 0 && !badOne(p));
    return ok.length ? ok : undefined;
  }
  if (typeof raw !== "string") return undefined;
  return badOne(raw) ? undefined : raw;
};

const applyLineRange = (
  text: string,
  offset?: number,
  limit?: number,
  showLineNumbers = true,
): string => {
  const lines = text.split("\n");
  const start = offset !== undefined ? Math.max(1, offset) : 1;
  const end =
    limit !== undefined ? Math.min(lines.length, start + limit - 1) : lines.length;
  const slice = lines.slice(start - 1, end);
  if (!showLineNumbers) {
    return slice.join("\n");
  }
  return slice.map((line, i) => `${start + i}|${line}`).join("\n");
};

type TreeCtx = {
  lines: string[];
  dirCount: number;
  fileCount: number;
  truncated: boolean;
};

const listDirTree = async (
  fs: WorkspaceFilesystem,
  absDir: string,
  relFromListRoot: string,
  depth: number,
  maxDepth: number,
  opts: {
    showHidden: boolean;
    dirsOnly: boolean;
    exclude?: string;
    extension?: string;
    globMatcher?: (rel: string) => boolean;
  },
  ctx: TreeCtx,
): Promise<void> => {
  if (depth >= maxDepth) {
    ctx.truncated = true;
    return;
  }
  let entries;
  try {
    entries = await fs.readdir(absDir);
  } catch {
    return;
  }
  let filtered = entries;
  if (!opts.showHidden) {
    filtered = filtered.filter((e) => !e.name.startsWith("."));
  }
  if (opts.exclude) {
    const ex = opts.exclude;
    filtered = filtered.filter((e) => !e.name.includes(ex));
  }
  if (opts.extension && !opts.dirsOnly) {
    const ext = opts.extension.startsWith(".") ? opts.extension : `.${opts.extension}`;
    filtered = filtered.filter((e) => {
      if (e.type === "directory") return true;
      return e.name.endsWith(ext);
    });
  }
  if (opts.globMatcher && !opts.dirsOnly) {
    filtered = filtered.filter((e) => {
      if (e.type === "directory") return true;
      const rel = relFromListRoot ? `${relFromListRoot}/${e.name}` : e.name;
      return opts.globMatcher!(rel);
    });
  }
  if (opts.dirsOnly) {
    filtered = filtered.filter((e) => e.type === "directory");
  }
  filtered.sort((a, b) => {
    if (a.type === "directory" && b.type !== "directory") return -1;
    if (a.type !== "directory" && b.type === "directory") return 1;
    return a.name.localeCompare(b.name);
  });
  const indent = "\t".repeat(depth);
  for (const entry of filtered) {
    ctx.lines.push(`${indent}${entry.name}`);
    if (entry.type === "directory") {
      ctx.dirCount++;
      const nextAbs = posixJoin(absDir, entry.name);
      const nextRel = relFromListRoot ? `${relFromListRoot}/${entry.name}` : entry.name;
      await listDirTree(fs, nextAbs, nextRel, depth + 1, maxDepth, opts, ctx);
    } else {
      ctx.fileCount++;
    }
  }
};

/**
 * Mastra-compatible `mastra_workspace_*` tools backed only by {@link WorkspaceFilesystem}
 * (e.g. {@link RepoWorkspaceFilesystem} over Blaxel). No `Workspace` tool wrapper, no
 * stream `writer.custom` — suitable when built-in workspace FS tools are disabled.
 */
export const createCodingRepoFilesystemTools = (
  filesystem: WorkspaceFilesystem,
  options: CreateCodingRepoFilesystemToolsOptions = {},
): Record<string, Tool> => {
  if (typeof filesystem.readFile !== "function" || typeof filesystem.readdir !== "function") {
    throw new Error(
      "createCodingRepoFilesystemTools: workspace.filesystem must implement readFile and readdir. " +
        `Got readFile=${typeof filesystem.readFile}, readdir=${typeof filesystem.readdir} (provider=${String(filesystem.provider)}).`,
    );
  }

  const requireReadBeforeWrite = options.requireReadBeforeWrite !== false;
  const readPaths = new Set<string>();

  const readFileBound = filesystem.readFile.bind(filesystem);
  const writeFileBound = filesystem.writeFile.bind(filesystem);
  const readdirBound = filesystem.readdir.bind(filesystem);
  const existsBound = filesystem.exists.bind(filesystem);
  const statBound = filesystem.stat.bind(filesystem);

  const readFileTool = createTool({
    id: WORKSPACE_TOOLS.FILESYSTEM.READ_FILE,
    description:
      "Read the contents of a file from the workspace filesystem. Use offset/limit parameters to read specific line ranges for large files.",
    inputSchema: z.object({
      path: z.string().describe('The path to the file to read (e.g. "data/config.json")'),
      encoding: z
        .enum(["utf-8", "utf8", "base64", "hex", "binary"])
        .optional()
        .describe(
          "The encoding to use when reading the file. Defaults to utf-8 for text files.",
        ),
      offset: z.coerce
        .number()
        .optional()
        .describe("Line number to start reading from (1-indexed). If omitted, starts from line 1."),
      limit: z.coerce
        .number()
        .optional()
        .describe("Maximum number of lines to read. If omitted, reads to the end of the file."),
      showLineNumbers: zModelOptionalBoolean(true).describe(
        "Whether to prefix each line with its line number (default: true)",
      ),
    }),
    execute: async ({ path, encoding, offset, limit, showLineNumbers = true }) => {
      const effectiveEncoding = encoding ?? "utf-8";
      const fullContent = await readFileBound(path, { encoding: effectiveEncoding });
      readPaths.add(normalizePathKey(filesystem, path));
      if (typeof fullContent !== "string") {
        const st = await statBound(path);
        return `${st.path} (${st.size} bytes, ${effectiveEncoding})\n[binary content omitted]`;
      }
      const out = applyLineRange(fullContent, offset, limit, showLineNumbers);
      return out;
    },
  });

  const writeFileTool = createTool({
    id: WORKSPACE_TOOLS.FILESYSTEM.WRITE_FILE,
    description:
      "Write or overwrite a file in the workspace filesystem. Pass the full file body as `content`. For paths that do not exist yet, you may write without a prior read (creates the file). For existing paths, read the file first when read-before-write is enforced.",
    inputSchema: z.object({
      path: z.string().describe("Path to the file to write"),
      content: z.string().describe("Full file contents"),
      overwrite: z
        .preprocess((val) => {
          if (val === undefined) {
            return undefined;
          }
          return coerceModelBoolean(val, true);
        }, z.boolean().optional())
        .describe("If false, fail when the file already exists"),
    }),
    execute: async ({ path, content, overwrite }) => {
      const pathKey = normalizePathKey(filesystem, path);
      const exists = await existsBound(path);
      if (requireReadBeforeWrite && !readPaths.has(pathKey)) {
        // Existing files must be read first (avoids blind overwrites). New paths may be
        // created without a prior read — otherwise read_file fails with "file not found"
        // and the agent cannot add files via write_file alone.
        if (exists) {
          throw new FileReadRequiredError(
            path,
            `You must read "${path}" with mastra_workspace_read_file before writing.`,
          );
        }
      }
      if (exists && overwrite === false) {
        return `Error: File already exists at ${path} (overwrite is false).`;
      }
      try {
        await writeFileBound(path, content, { recursive: true });
      } catch (e) {
        const detail = e instanceof Error ? e.message : String(e);
        throw new Error(`Failed to write "${path}": ${detail}`);
      }
      readPaths.add(pathKey);
      return `Wrote ${content.length} characters to ${path}`;
    },
  });

  const listFilesTool = createTool({
    id: WORKSPACE_TOOLS.FILESYSTEM.LIST_FILES,
    description: `List files and directories in the workspace filesystem.
Returns a compact tab-indented listing. Use \`path\` for the directory; \`pattern\` is only for glob file filters (e.g. **/*.ts) — never mirror \`path\` into \`pattern\`.`,
    inputSchema: z.object({
      path: z.string().default(".").describe("Directory path to list"),
      // Models often emit JSON numbers as strings; coerce so validation does not hard-fail the step.
      maxDepth: z.coerce.number().optional().default(2).describe("Maximum depth to descend (default: 2)."),
      showHidden: zModelOptionalBoolean(false).describe('Show hidden files (default: false).'),
      dirsOnly: zModelOptionalBoolean(false).describe("Directories only (default: false)."),
      exclude: zModelOptionalString.describe('Exclude pattern (e.g. "node_modules").'),
      extension: zModelOptionalString.describe('Filter by extension (e.g. ".ts").'),
      pattern: z
        .union([z.string(), z.array(z.string())])
        .optional()
        .describe("Glob filter only — not a directory path."),
      respectGitignore: zModelOptionalBoolean(true).describe("Respect .gitignore (default: true)."),
    }),
    execute: async ({
      path: listPath = ".",
      maxDepth = 2,
      showHidden,
      dirsOnly,
      exclude,
      extension,
      pattern,
      respectGitignore: _respectGitignore,
    }) => {
      void _respectGitignore;
      const cleanedPattern = sanitizeListPattern(pattern, listPath);
      let globMatcher: ((rel: string) => boolean) | undefined;
      if (cleanedPattern) {
        const patterns = Array.isArray(cleanedPattern) ? cleanedPattern : [cleanedPattern];
        const normalized = patterns.map((p) => p.replace(/^\//, ""));
        globMatcher = createPicomatchMatcher(normalized, { posix: true, dot: showHidden ?? false });
      }
      const ctx: TreeCtx = {
        lines: ["."],
        dirCount: 0,
        fileCount: 0,
        truncated: false,
      };
      await listDirTree(
        { ...filesystem, readdir: readdirBound } as WorkspaceFilesystem,
        listPath,
        "",
        0,
        maxDepth,
        {
          showHidden: showHidden ?? false,
          dirsOnly: dirsOnly ?? false,
          exclude: exclude || undefined,
          extension: extension || undefined,
          globMatcher,
        },
        ctx,
      );
      const dirPart = ctx.dirCount === 1 ? "1 directory" : `${ctx.dirCount} directories`;
      const filePart = ctx.fileCount === 1 ? "1 file" : `${ctx.fileCount} files`;
      let summary = `${dirPart}, ${filePart}`;
      if (ctx.truncated) {
        summary += ` (truncated at depth ${maxDepth})`;
      }
      return `${ctx.lines.join("\n")}\n\n${summary}`;
    },
  });

  const editFileTool = createTool({
    id: WORKSPACE_TOOLS.FILESYSTEM.EDIT_FILE,
    description: `Edit a file by replacing exact text. Read the file first. \`old_string\` must match exactly (unique unless \`replace_all\` is true). Do not include line-number prefixes from read output in \`old_string\` / \`new_string\`.`,
    inputSchema: z.object({
      path: z.string().describe("Path to the file to edit"),
      old_string: z.string().describe("Exact text to find and replace"),
      new_string: z.string().describe("Replacement text"),
      replace_all: zModelOptionalBoolean(false).describe(
        "Replace all occurrences when true (default false)",
      ),
    }),
    execute: async ({ path, old_string, new_string, replace_all: replaceAll }) => {
      const pathKey = normalizePathKey(filesystem, path);
      if (requireReadBeforeWrite && !readPaths.has(pathKey)) {
        throw new FileReadRequiredError(
          path,
          `You must read "${path}" with mastra_workspace_read_file before editing.`,
        );
      }
      const content = await readFileBound(path, { encoding: "utf-8" });
      if (typeof content !== "string") {
        return "Cannot edit binary files. Use mastra_workspace_write_file instead.";
      }
      try {
        const result = replaceFileEditStrings(
          content,
          old_string,
          new_string,
          replaceAll ?? false,
        );
        await writeFileBound(path, result.content, { recursive: true, overwrite: true });
        readPaths.add(pathKey);
        return `Replaced ${result.replacements} occurrence${result.replacements !== 1 ? "s" : ""} in ${path}`;
      } catch (e) {
        const detail = e instanceof Error ? e.message : String(e);
        if (
          detail.includes("not found") ||
          detail.includes("appears") ||
          detail.includes("replace_all")
        ) {
          return `Error: ${detail}`;
        }
        throw new Error(`Failed to edit "${path}": ${detail}`);
      }
    },
  });

  return {
    [WORKSPACE_TOOLS.FILESYSTEM.READ_FILE]: readFileTool,
    [WORKSPACE_TOOLS.FILESYSTEM.WRITE_FILE]: writeFileTool,
    [WORKSPACE_TOOLS.FILESYSTEM.EDIT_FILE]: editFileTool,
    [WORKSPACE_TOOLS.FILESYSTEM.LIST_FILES]: listFilesTool,
  } as Record<string, Tool>;
};
