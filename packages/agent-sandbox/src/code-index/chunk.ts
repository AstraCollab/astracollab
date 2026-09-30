import { createHash } from "node:crypto";

import type { SourceChunk } from "./types.js";
import { hashContent } from "./merkle.js";

const DEFAULT_MAX_CHUNK_CHARS = 2400;
const DEFAULT_MIN_CHUNK_LINES = 8;

const indexableExtensions = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".py",
  ".go",
  ".rs",
  ".java",
  ".kt",
  ".rb",
  ".php",
  ".cs",
  ".swift",
  ".vue",
  ".svelte",
  ".md",
  ".json",
  ".yaml",
  ".yml",
  ".toml",
  ".sql",
  ".graphql",
  ".prisma",
  ".css",
  ".scss",
  ".html",
]);

export const isIndexablePath = (repoRelativePath: string): boolean => {
  const lower = repoRelativePath.toLowerCase();
  if (
    lower.includes("/node_modules/") ||
    lower.includes("/.git/") ||
    lower.includes("/dist/") ||
    lower.includes("/build/") ||
    lower.includes("/.next/") ||
    lower.includes("/coverage/") ||
    lower.startsWith(".")
  ) {
    return false;
  }
  const dot = lower.lastIndexOf(".");
  if (dot < 0) {
    return false;
  }
  return indexableExtensions.has(lower.slice(dot));
};

const chunkId = (path: string, startLine: number, endLine: number, contentHash: string): string =>
  `${path}:${startLine}-${endLine}:${contentHash.slice(0, 12)}`;

/**
 * Split source into line-bounded chunks (~2k chars). Syntactic AST chunking can replace this later.
 */
export const chunkSourceFile = (
  repoRelativePath: string,
  content: string,
  opts?: { maxChunkChars?: number },
): SourceChunk[] => {
  const maxChars = opts?.maxChunkChars ?? DEFAULT_MAX_CHUNK_CHARS;
  const lines = content.split(/\r?\n/);
  const chunks: SourceChunk[] = [];

  let start = 0;
  let buf: string[] = [];
  let bufLen = 0;

  const flush = (endLineInclusive: number) => {
    if (buf.length === 0) {
      return;
    }
    const text = buf.join("\n");
    const contentHash = hashContent(text);
    const endLine = endLineInclusive + 1;
    chunks.push({
      id: chunkId(repoRelativePath, start + 1, endLine, contentHash),
      path: repoRelativePath,
      startLine: start + 1,
      endLine,
      content: text,
      contentHash,
    });
    buf = [];
    bufLen = 0;
    start = endLineInclusive + 1;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const nextLen = bufLen + line.length + (buf.length > 0 ? 1 : 0);
    if (buf.length >= DEFAULT_MIN_CHUNK_LINES && nextLen > maxChars) {
      flush(i - 1);
    }
    buf.push(line);
    bufLen = nextLen;
  }

  if (buf.length > 0) {
    flush(lines.length - 1);
  }

  return chunks;
};

export const prioritizeIndexPaths = (
  paths: string[],
  hints?: { entryPointPaths?: string[]; keyDirectoryPaths?: string[] },
): string[] => {
  const priority = new Set<string>();
  for (const ep of hints?.entryPointPaths ?? []) {
    const norm = ep.replace(/^\/+/, "");
    priority.add(norm);
    const parts = norm.split("/");
    for (let i = 1; i < parts.length; i++) {
      priority.add(parts.slice(0, i).join("/"));
    }
  }
  for (const dir of hints?.keyDirectoryPaths ?? []) {
    const norm = dir.replace(/^\/+/, "").replace(/\/+$/, "");
    priority.add(norm);
  }

  const score = (p: string): number => {
    if (priority.has(p)) {
      return 0;
    }
    for (const pref of priority) {
      if (p.startsWith(`${pref}/`) || p === pref) {
        return 1;
      }
    }
    return 2;
  };

  return [...paths].sort((a, b) => score(a) - score(b) || a.localeCompare(b));
};
