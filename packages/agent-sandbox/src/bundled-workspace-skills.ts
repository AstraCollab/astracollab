import type { SandboxRuntime } from "./types.js";

import { DEFAULT_CODING_SANDBOX_REPO_DIR } from "./coding-sandbox-repo-path.js";

/**
 * Mastra workspace skill directories (relative to the cloned repo root) after
 * {@link installBundledWorkspaceSkills} runs in the sandbox. Matches upstream:
 * - vercel-labs/next-skills → skills/next-best-practices
 * - MiniMax-AI/skills → skills/fullstack-dev
 * - garrytan/gstack → autoplan
 */
export const BUNDLED_WORKSPACE_SKILL_RELATIVE_PATHS = [
  "./.mastra/bundled-skills/next-best-practices",
  "./.mastra/bundled-skills/fullstack-dev",
  "./.mastra/bundled-skills/autoplan",
] as const;

const bundledSkillInstallScript = `
set -euo pipefail
export GIT_TERMINAL_PROMPT=0
SKILL_ROOT=".mastra/bundled-skills"
mkdir -p "$SKILL_ROOT"

append_exclude() {
  mkdir -p .git/info
  local line=".mastra/bundled-skills/"
  if ! grep -qxF "$line" .git/info/exclude 2>/dev/null; then
    printf '%s\\n' "$line" >> .git/info/exclude
  fi
}

install_sparse_skill() {
  local url="$1"
  local sparse_path="$2"
  local dest_name="$3"
  local tmp
  tmp="$(mktemp -d)"
  git clone --depth 1 --filter=blob:none --sparse "$url" "$tmp/repo"
  ( cd "$tmp/repo" && git sparse-checkout set "$sparse_path" )
  rm -rf "$SKILL_ROOT/$dest_name"
  mv "$tmp/repo/$sparse_path" "$SKILL_ROOT/$dest_name"
  rm -rf "$tmp"
}

install_sparse_skill "https://github.com/vercel-labs/next-skills.git" "skills/next-best-practices" "next-best-practices"
install_sparse_skill "https://github.com/MiniMax-AI/skills.git" "skills/fullstack-dev" "fullstack-dev"
install_sparse_skill "https://github.com/garrytan/gstack.git" "autoplan" "autoplan"

append_exclude
`.trim();

export type InstallBundledWorkspaceSkillsOptions = {
  /** Working directory for `executeCommand` (repo root). Defaults to {@link DEFAULT_CODING_SANDBOX_REPO_DIR}. */
  cwd?: string;
};

/**
 * Shallow sparse-clone upstream Agent Skills into `.mastra/bundled-skills/` and
 * append that directory to `.git/info/exclude` so agent commits do not pick up
 * vendored skill trees.
 *
 * Set `MASTRA_SKIP_BUNDLED_SKILL_INSTALL=1` on the host process to skip (e.g. air-gapped sandboxes).
 */
export const installBundledWorkspaceSkills = async (
  sandbox: SandboxRuntime,
  options?: InstallBundledWorkspaceSkillsOptions,
): Promise<void> => {
  if (
    process.env.MASTRA_SKIP_BUNDLED_SKILL_INSTALL === "1" ||
    process.env.MASTRA_SKIP_BUNDLED_SKILL_INSTALL === "true"
  ) {
    return;
  }
  if (typeof sandbox.executeCommand !== "function") {
    console.warn(
      "[agent-sandbox] installBundledWorkspaceSkills: sandbox has no executeCommand; skipping",
    );
    return;
  }
  const cwd = options?.cwd ?? DEFAULT_CODING_SANDBOX_REPO_DIR;
  try {
    const result = await sandbox.executeCommand("bash", ["-c", bundledSkillInstallScript], {
      cwd,
      timeout: 600_000,
    });
    if (!result.success) {
      console.warn(
        "[agent-sandbox] bundled workspace skills install failed",
        result.stderr?.slice(0, 2000),
      );
    }
  } catch (error) {
    console.warn("[agent-sandbox] bundled workspace skills install threw", error);
  }
};
