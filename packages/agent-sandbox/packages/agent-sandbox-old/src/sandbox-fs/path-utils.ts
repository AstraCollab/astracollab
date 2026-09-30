import * as posix from "node:path/posix";

export class RepoPathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RepoPathError";
  }
}

export const normalizeUnderRepoRoot = (repoRoot: string, path: string): string => {
  const root = repoRoot.endsWith("/") ? repoRoot.slice(0, -1) : repoRoot;
  const raw = path.startsWith("/") ? path : posix.join(root, path);
  const normalized = posix.normalize(raw);
  if (normalized !== root && !normalized.startsWith(`${root}/`)) {
    throw new RepoPathError(`Path escapes repo root: ${path}`);
  }
  return normalized;
};
