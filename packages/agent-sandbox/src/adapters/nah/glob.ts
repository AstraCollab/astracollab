import type { RepoFsEntry, RepoSandboxFs } from "../../sandbox-fs/repo-fs-port.js";
import picomatchImport from "picomatch";

/**
 * Glob discovery for the NAH adapter.
 *
 * NAH only registers its `glob` tool when the environment exposes a `glob` function
 * (`createCodingTools` checks `typeof env.glob === "function"`). Without it the model
 * is never offered glob search and must fall back to `list` or `bash find`.
 *
 * Matching is host-side against `listDir` output: the sandbox has no glob primitive on
 * the port, and walking a tree is far cheaper than reading file contents.
 */

type Picomatch = (pattern: string, options?: Record<string, unknown>) => (input: string) => boolean;

const picomatch: Picomatch | undefined =
  typeof picomatchImport === "function"
    ? (picomatchImport as unknown as Picomatch)
    : (picomatchImport as unknown as { default?: Picomatch }).default;

const GLOB_MAGIC = /[*?[\]{}]/;

/**
 * Longest leading run of the pattern with no glob magic, used to limit the walk.
 * `src/adapters/nah/*.ts` becomes `src/adapters/nah`; a leading double-star becomes `.`.
 */
export const globStaticPrefix = (pattern: string): string => {
  const segments = pattern.replace(/^\.\//, "").split("/");
  const literal: string[] = [];
  let stoppedAtMagic = false;
  for (const segment of segments) {
    if (GLOB_MAGIC.test(segment)) {
      stoppedAtMagic = true;
      break;
    }
    literal.push(segment);
  }
  // Only drop the final segment when the whole pattern was literal: then that segment
  // is the entry being matched, not its parent (`src/components` → `src`). When the scan
  // stopped at magic, the last literal collected *is* a directory prefix and is needed
  // (`src/**/*.ts` → `src`).
  if (!stoppedAtMagic && literal.length > 0) {
    literal.pop();
  }
  return literal.join("/") || ".";
};

const joinUnder = (base: string, prefix: string): string => {
  const parts = [base === "." ? "" : base, prefix === "." ? "" : prefix].filter(Boolean);
  return parts.join("/") || ".";
};

const depth = (path: string): number => path.split("/").length - 1;

/** Directories before files, each group alphabetical — matches how a directory tree reads. */
const sortShallowestFirst = (paths: string[]): string[] =>
  [...paths].sort((a, b) => depth(a) - depth(b) || a.localeCompare(b));

export type GlobOptions = {
  pattern: string;
  /** Directory to search under, relative to the repo root. Defaults to the root. */
  path?: string;
  includeHidden?: boolean;
  limit?: number;
};

export type GlobResolver = (options: GlobOptions) => Promise<string[]>;

/**
 * Build a glob resolver over a repo filesystem.
 *
 * Two cost controls, because a recursive listing is one RPC that can return thousands
 * of entries:
 *   - the walk starts at the pattern's static prefix, not the repo root;
 *   - a pattern with no `**` cannot match below its own directory, so the walk is
 *     non-recursive in that case.
 */
export const createGlobResolver = (repoFs: RepoSandboxFs): GlobResolver => {
  const relative = (absolutePath: string): string =>
    absolutePath === repoFs.repoRoot ? "." : absolutePath.slice(repoFs.repoRoot.length + 1);

  return async ({ pattern, path, includeHidden, limit }) => {
    if (!picomatch) {
      throw new Error(
        "glob requires picomatch, which failed to load in this environment.",
      );
    }
    if (!pattern.trim()) {
      return [];
    }

    const baseDir = (path?.trim() || ".").replace(/^\.\//, "").replace(/\/$/, "") || ".";
    // Start the walk at the deeper of the caller's `path` and the pattern's own prefix,
    // so `glob("src/**/*.ts", { path: "src/app" })` does not list the whole of `src`.
    const searchBase = joinUnder(baseDir, globStaticPrefix(pattern));
    const searchRoot = searchBase === "." ? repoFs.repoRoot : `${repoFs.repoRoot}/${searchBase}`;

    // No `**` means the match cannot be nested below its own directory.
    const recursive = pattern.includes("**");

    const entries: RepoFsEntry[] = await repoFs
      .listDir(searchRoot, { recursive })
      .catch(() => [] as RepoFsEntry[]);

    // `listDir` reports repo-relative paths, so a pattern written relative to a narrower
    // `path` has to be re-anchored on that path to still line up.
    const anchoredPattern =
      baseDir !== "." && !pattern.startsWith(baseDir) ? `${baseDir}/${pattern}` : pattern;
    const match = picomatch(anchoredPattern.replace(/^\.\//, ""), {
      dot: includeHidden === true,
    });

    const matched: string[] = [];
    for (const entry of entries) {
      const rel = relative(entry.path);
      if (match(rel)) {
        matched.push(rel);
      }
    }

    const sorted = sortShallowestFirst(matched);
    return typeof limit === "number" && limit > 0 ? sorted.slice(0, limit) : sorted;
  };
};
