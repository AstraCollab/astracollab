import type {
  CloneOptions,
  CommitOptions,
  GitConfigOptions,
} from "../types.js";

const requireSandboxExec = (sandbox: { executeCommand?: unknown }) => {
  if (typeof sandbox.executeCommand !== "function") {
    throw new Error(
      "Sandbox provider does not implement executeCommand(). git helpers require a runnable sandbox.",
    );
  }
};

const buildAuthenticatedHttpsUrl = (url: string, token?: string): string => {
  if (!token) {
    return url;
  }
  return url.replace(/^https:\/\//i, `https://x-access-token:${token}@`);
};

/**
 * Shallow `git clone` (depth 1 by default) over HTTPS with optional
 * `x-access-token` injection — works on every provider that runs git.
 *
 * Caller is responsible for picking a sensible `targetDir` inside the
 * sandbox's writable workspace.
 */
export const cloneRepo = async ({
  sandbox,
  url,
  token,
  branch,
  depth = 1,
  targetDir,
}: CloneOptions): Promise<void> => {
  requireSandboxExec(sandbox);
  const authUrl = buildAuthenticatedHttpsUrl(url, token);
  await sandbox.executeCommand!("git", [
    "clone",
    `--depth=${depth}`,
    `--branch=${branch}`,
    authUrl,
    targetDir,
  ]);
};

/**
 * Set git author identity on a checkout. Useful right after `cloneRepo` so
 * subsequent commits land with the correct attribution.
 */
export const gitConfig = async ({
  sandbox,
  cwd,
  userName,
  userEmail,
}: GitConfigOptions): Promise<void> => {
  requireSandboxExec(sandbox);
  await sandbox.executeCommand!("git", ["config", "user.name", userName], {
    cwd,
  });
  await sandbox.executeCommand!("git", ["config", "user.email", userEmail], {
    cwd,
  });
};

/**
 * Stage everything, commit, and push to the given branch. Returns the
 * `CommandResult` from the `push` so callers can inspect status / stdout.
 */
export const commitAndPush = async ({
  sandbox,
  cwd,
  message,
  branch,
  authorName,
  authorEmail,
}: CommitOptions) => {
  requireSandboxExec(sandbox);
  if (authorName && authorEmail) {
    await gitConfig({
      sandbox,
      cwd,
      userName: authorName,
      userEmail: authorEmail,
    });
  }
  await sandbox.executeCommand!("git", ["add", "-A"], { cwd });
  await sandbox.executeCommand!("git", ["commit", "-m", message], { cwd });
  return sandbox.executeCommand!("git", ["push", "origin", branch], { cwd });
};
