/**
 * Shell command construction for the NAH adapter.
 *
 * `grep` runs *inside* the sandbox rather than being emulated host-side. The previous
 * implementation walked the tree with `listDir` and pulled every candidate file across
 * the Blaxel RPC boundary to test a regex in Node, which on a real repository means a
 * full file read per candidate — hundreds of round trips for one search. Delegating to
 * `git grep` (already git-indexed, and what the Mastra coding agent already uses) turns
 * that into one call.
 */

/** POSIX single-quote. The only safe way to pass a model-authored pattern to a shell. */
export const shellQuote = (value: string): string => `'${value.replace(/'/g, "'\\''")}'`;

/**
 * Bounded so a pathological pattern cannot hold an agent turn open. Lower than the
 * adapter's default `exec` timeout because grep is the one command we expect to be slow.
 */
export const GREP_TIMEOUT_SECONDS = 60;

export type GrepCommandOptions = {
  pattern: string;
  /** Repo-relative path, file, directory, or glob. Omitted searches the whole repo. */
  target?: string;
  ignoreCase?: boolean;
  maxPerFile?: number;
};

/**
 * `git grep` in a `bash -lc` command, with a `grep -r` fallback.
 *
 * Two details that matter for a coding agent:
 *
 *   - `--untracked`: a plain `git grep` only searches tracked files, so a file the agent
 *     just wrote would be invisible to its own next search. `--untracked` includes it
 *     while still respecting `.gitignore`.
 *   - exit-status routing: `git grep` exits 0 on match, **1 on no match**, and >1 on
 *     error (e.g. not a repository, bad regex). Only >1 should fall through to
 *     `grep -r`. A plain `git grep … || grep -r` conflates "no matches" with "git
 *     failed" and silently re-scans the tree on every empty search.
 */
export const buildGrepCommand = ({
  pattern,
  target,
  ignoreCase,
  maxPerFile,
}: GrepCommandOptions): string => {
  const quotedPattern = shellQuote(pattern);
  const quotedTarget = target ? shellQuote(target) : "";
  const limit = maxPerFile && maxPerFile > 0 ? String(Math.floor(maxPerFile)) : "";
  const caseFlag = ignoreCase ? " -i" : "";

  const gitPart = [
    "git grep -nI --untracked",
    limit ? `-m ${limit}` : "",
    caseFlag,
    "-E --",
    quotedPattern,
    quotedTarget,
  ]
    .filter(Boolean)
    .join(" ");

  const grepPart = [
    "grep -rnI",
    limit ? `-m ${limit}` : "",
    caseFlag,
    "-E --",
    quotedPattern,
    quotedTarget,
  ]
    .filter(Boolean)
    .join(" ");

  // Run from the repo root so git grep emits repo-relative paths, which is the format
  // NAH's grep tool parses (`path:line: text`) and what the model should see.
  return [
    "{",
    gitPart,
    "rc=$?",
    `if [ "$rc" -gt 1 ]; then ${grepPart}; fi`,
    "}",
  ].join("; ");
};

/** Matches NAH's `path:line:` prefix. The path group is non-greedy so a colon inside a filename survives. */
const MATCH_LINE = /^(.*?):(\d+):(.*)$/;

export type ParsedGrepLine = { path: string; line: number; text: string };

export const parseGrepLine = (line: string): ParsedGrepLine | null => {
  const match = MATCH_LINE.exec(line);
  if (!match) return null;
  return { path: match[1]!, line: Number(match[2]), text: match[3] ?? "" };
};

/** True when any segment of a repo-relative path is a dotfile (`.git`, `.env`, `src/.cache`). */
export const isHiddenPath = (relativePath: string): boolean =>
  relativePath
    .replace(/^\.\//, "")
    .split("/")
    .some((segment) => segment.startsWith(".") && segment.length > 1);

/**
 * Drop dotfile hits and anything not in `path:line:` shape.
 *
 * `git grep` searches tracked dotfiles (`.eslintrc.json` and friends), so honouring
 * `includeHidden: false` means filtering the output. Non-matching lines are dropped
 * because NAH's grep tool renders `path` from this field and a bare `12: foo` would be
 * attributed to a file literally named `12`.
 */
export const filterGrepOutput = (
  stdout: string,
  options: { includeHidden?: boolean },
): string => {
  const includeHidden = options.includeHidden === true;
  const kept: string[] = [];
  for (const raw of stdout.split("\n")) {
    if (raw.length === 0) continue;
    const parsed = parseGrepLine(raw);
    if (!parsed) continue;
    if (!includeHidden && isHiddenPath(parsed.path)) continue;
    kept.push(raw);
  }
  return kept.join("\n");
};
