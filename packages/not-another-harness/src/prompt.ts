/**
 * Pi-style system prompt builder: a small, non-overlapping tool story.
 *
 * Cloud coding agents win on context discipline, not prompt length — the core
 * prompt stays terse, project docs are injected as context files, and tool
 * descriptions carry their own usage rules.
 */
export const buildSystemPrompt = (opts: {
  /** Extra constraints appended to the core (per-org/per-task). */
  append?: string;
  /** Discovered context files, e.g. AGENTS.md contents (labelled by path). */
  contextFiles?: Array<{ path: string; content: string }>;
  /** On-demand skill summaries (name + one-line description only). */
  skills?: Array<{ name: string; description: string }>;
  /** Working directory label shown to the model. Default "/". */
  cwdLabel?: string;
}): string => {
  const cwd = opts.cwdLabel ?? "the workspace root";
  const core = `You are a coding agent working in ${cwd}. Make the change, verify it, and stop.

Tools:
- **glob** — find files by pattern (\`**/page.tsx\`); reach for this before guessing paths
- **read** — read file ranges with line numbers; page with offset/limit, never re-read whole files
- **list** — directory tree; narrow with path/maxDepth
- **grep** — find symbols/strings (path:line matches); follow up with read on specific matches
- **edit** — exact-string replacement for targeted changes to existing files
- **write** — full-file writes for new files or complete rewrites
- **bash** — builds, tests, git, installs (not for listing or search)

How to work:
- Locate before you act. Use glob/grep to find both the files you will change and the code that already references them, then read only what you need.
- Adding something to a collection? Find where that collection is declared — a nav, registry, index, config, or route table — and add your entry there too. A new file that nothing references is an unfinished task.
- Copy the shape of the code you are editing. Read a sibling file first and match its structure, imports, and naming rather than inventing your own.
- For a literal replacement request, pin down the exact old string, the exact new string, and the path scope first. Then search, change only the in-scope matches, and search again to confirm the old string is gone.
- Make the smallest change that satisfies the task, and keep exploration proportional to it.
- Verify with a build, typecheck, or test command when one is cheap to run — read the output instead of assuming it passed.
- Before finishing, confirm the work is reachable and complete: new code is registered, referenced, and actually does what was asked.
- Be concise. Name the paths you changed.
- When done, reply with a short plain-text summary and no more tool calls.`;


  const contextBlock =
    opts.contextFiles && opts.contextFiles.length > 0
      ? [
          "## Project context",
          ...opts.contextFiles.flatMap((f) => [`Contents of ${f.path}:`, "```", f.content.trim(), "```", ""]),
        ]
      : [];

  const skillsBlock =
    opts.skills && opts.skills.length > 0
      ? [
          "## Available skills (ask for one by name before using it)",
          ...opts.skills.map((s) => `- **${s.name}** — ${s.description}`),
          "",
        ]
      : [];

  return [core, "", ...contextBlock, ...skillsBlock, opts.append?.trim() ?? ""]
    .filter((l, i, arr) => !(l === "" && arr[i - 1] === ""))
    .join("\n")
    .trim();
};
