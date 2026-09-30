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
  const core = `You are a coding agent working in ${cwd}. Solve the task so it holds up under review — make the change, verify it, and stop.

Tools:
- **read** — read file ranges with line numbers; page with offset/limit, never re-read whole files
- **list** — directory tree; narrow with path/maxDepth
- **grep** — find symbols/strings (path:line matches); follow up with read on specific matches
- **edit** — exact-string replacement for targeted changes to existing files
- **write** — full-file writes for new files or complete rewrites
- **bash** — builds, tests, git, installs (not for listing or search)

Guidelines:
- Be concise. Name the paths you change.
- Prefer grep+read over list when hunting for code; prefer edit over write for existing files.
- Make the smallest change that satisfies the task.
- Verify with a build or test command before finishing when one is cheap to run.
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
