/**
 * Repository outline — Aider's repo map, adapted to be safe here.
 *
 * Aider's insight is that agents read whole files because nothing tells them
 * what is inside. It answers with a *map*: exported signatures and line numbers,
 * ranked by the import graph, so the agent can go straight to the region it
 * needs instead of pulling 250 lines to find one function.
 *
 * The important deviation from a literal port: this is applied when a result is
 * produced, never by rewriting history. Editing an earlier `tool_result` is
 * documented by Anthropic as invalidating the thinking-block signatures bound to
 * that prefix, and the SDK sends reasoning back by default, so transcript editing
 * is not available to us at all. Producing less output in the first place is.
 */
import { tool } from "ai";
import { z } from "zod";

import type { ToolEnvironment } from "./types.js";

type Signature = { file: string; line: number; text: string };

/** Cheap structural patterns, deliberately not a full parser. */
const PATTERNS: Array<{ re: RegExp; languages: Set<string> | "all" }> = [
  { re: /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+\*?([A-Za-z_$][\w$]*)/, languages: "all" },
  { re: /^\s*(?:export\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/, languages: "all" },
  { re: /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)/, languages: "all" },
  { re: /^\s*(?:export\s+)?(?:interface|type|enum)\s+([A-Za-z_$][\w$]*)/, languages: "all" },
  { re: /^\s*def\s+([A-Za-z_][\w]*)/, languages: new Set(["py"]) },
  { re: /^\s*class\s+([A-Za-z_][\w]*)/, languages: new Set(["py"]) },
  { re: /^func\s+(?:\([^)]*\)\s*)?([A-Za-z_][\w]*)/, languages: new Set(["go"]) },
  { re: /^type\s+([A-Za-z_][\w]*)/, languages: new Set(["go"]) },
];

const languageOf = (file: string): string => file.split(".").pop()?.toLowerCase() ?? "";

/** Source we are willing to scan. Binary and lock files are skipped by the caller. */
const SCANNABLE = new Set(["ts", "tsx", "js", "jsx", "mjs", "cjs", "mts", "cts", "py", "go", "rs", "java", "rb"]);

const BINARY_EXT = /\.(png|jpe?g|gif|ico|woff2?|ttf|eot|gz|zip|tar|pdf|wasm|lock|map)$/i;

export type OutlineOptions = {
  /** Hard cap on matches returned. */
  maxEntries?: number;
  /** Files scanned before giving up, so a huge repo cannot stall a turn. */
  maxFiles?: number;
};

/**
 * Entries returned when the caller does not ask for a specific number.
 *
 * Sized from measurement rather than taste: on a 5,800-line package the full map
 * runs ~6,200 tokens, which is more than every file the agent went on to read
 * individually. At 120 it is ~2,100 — enough to orient, cheap enough to call
 * speculatively.
 *
 * A default, not a ceiling: `maxEntries` still overrides it up to
 * `HARD_MAX_ENTRIES`, so an agent that genuinely needs the whole map can ask.
 */
const DEFAULT_MAX_ENTRIES = 120;
/** Ceiling for an explicit `maxEntries`. Matches the schema's own maximum. */
const HARD_MAX_ENTRIES = 2000;
const DEFAULT_MAX_FILES = 400;

/** Collect exported signatures from one file's source. */
export const outlineSource = (file: string, source: string): Signature[] => {
  const lang = languageOf(file);
  if (!SCANNABLE.has(lang)) return [];
  const out: Signature[] = [];
  const lines = source.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    if (line.length > 200) continue;
    for (const { re, languages } of PATTERNS) {
      if (languages !== "all" && !languages.has(lang)) continue;
      if (re.test(line)) {
        out.push({ file, line: i + 1, text: line.trim() });
        break;
      }
    }
  }
  return out;
};

const rank = (entries: Signature[], query: string): Signature[] => {
  const terms = query
    .toLowerCase()
    .split(/[^a-z0-9_]+/)
    .filter((t) => t.length >= 3);
  if (terms.length === 0) return entries;
  const scored = entries.map((entry) => {
    const hay = `${entry.file} ${entry.text}`.toLowerCase();
    let score = 0;
    for (const term of terms) if (hay.includes(term)) score += 1;
    return { entry, score };
  });
  return scored
    .sort((a, b) => b.score - a.score || a.entry.file.localeCompare(b.entry.file) || a.entry.line - b.entry.line)
    .map((s) => s.entry);
};

export const createOutlineTool = (env: ToolEnvironment, options: OutlineOptions = {}) =>
  tool({
    description:
      "Map a source tree before reading it. Returns top-level signatures as `file:line  signature` — functions, classes, interfaces, types and top-level constants — without any file bodies. " +
      "Prefer this over reading whole files when you need to know what a module contains or where something is defined; then read only the range you actually need. " +
      "Cheaper than grep for structure, and much cheaper than reading several files end to end.",
    inputSchema: z.object({
      path: z.string().optional().describe("Directory or file to map (default: workspace root)"),
      query: z.string().optional().describe("Optional terms; matches are ranked to the top"),
      maxEntries: z
        .number()
        .int()
        .min(1)
        .max(HARD_MAX_ENTRIES)
        .optional()
        .describe(
          `Max signatures returned (default ${DEFAULT_MAX_ENTRIES}, max ${HARD_MAX_ENTRIES}). Raise it when the map is truncated and you need the rest.`,
        ),
      includeHidden: z.boolean().optional().describe("Include dot-directories (default false)"),
    }),
    execute: async ({ path, query, maxEntries, includeHidden }) => {
      const cap = Math.min(
        Math.max(1, Math.floor(maxEntries ?? DEFAULT_MAX_ENTRIES)),
        HARD_MAX_ENTRIES,
      );
      const fileCap = options.maxFiles ?? DEFAULT_MAX_FILES;
      const found: Signature[] = [];
      const seen = new Set<string>();
      let scanned = 0;

      const walk = async (dir: string): Promise<void> => {
        if (found.length >= cap || scanned >= fileCap) return;
        let entries: Array<{ name: string; type: "file" | "directory" }>;
        try {
          entries = await env.readdir(dir);
        } catch {
          return;
        }
        for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
          if (found.length >= cap || scanned >= fileCap) return;
          const { name } = entry;
          if ((!includeHidden && name.startsWith(".")) || name === "node_modules") continue;
          const child = dir === "." ? name : `${dir}/${name}`;
          if (entry.type === "directory") {
            await walk(child);
            continue;
          }
          if (BINARY_EXT.test(name) || !SCANNABLE.has(languageOf(name))) continue;
          seen.add(child);
          scanned += 1;
          try {
            found.push(...outlineSource(child, await env.readFile(child)));
          } catch {
            // Unreadable file: skip rather than fail the turn.
          }
        }
      };

      if (path) {
        let isDir = true;
        try {
          isDir = (await env.readdir(path)).length >= 0;
        } catch {
          isDir = false;
        }
        if (isDir) {
          await walk(path);
        } else {
          // Not a directory; treat it as a single file.
          try {
            found.push(...outlineSource(path, await env.readFile(path)));
          } catch (error) {
            return `Error: ${error instanceof Error ? error.message : String(error)}`;
          }
        }
      } else {
        await walk(".");
      }

      if (found.length === 0) {
        return "No top-level signatures found. Try a different path, or read the file directly.";
      }

      const ranked = rank(found, query ?? "").slice(0, cap);
      const lines = ranked.map((s) => `${s.file}:${s.line}  ${s.text}`);
      const byFile = new Set(ranked.map((s) => s.file)).size;
      /**
       * Name the call that recovers the rest, rather than saying "narrow".
       *
       * `query` used to be suggested here, but it only *ranks* — it reorders the
       * same entry set and returns the same volume, so following that advice
       * costs another full map and changes nothing. `path` is the lever that
       * actually reduces scope; `maxEntries` is the one that returns more.
       */
      const note =
        found.length > ranked.length
          ? `\n[${found.length - ranked.length} more signatures available. To see them: outline with maxEntries=${cap * 2}. To see fewer: outline with path set to a specific directory.]`
          : "";
      const footer = scanned >= fileCap ? `\n[stopped after ${fileCap} files]` : "";
      return `${ranked.length} signatures across ${byFile} files (${scanned} files scanned):\n${lines.join("\n")}${note}${footer}\n\nRead only the ranges you need.`;
    },
  });

/** Cap applied when the caller exposes the tool to the model. */