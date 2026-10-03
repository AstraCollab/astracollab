import type { RepoIndexIdentity, RepoIndexManifest, RepoIndexState } from "./types.js";

export const computePercentComplete = (embeddedCount: number, chunkCount: number): number => {
  if (chunkCount <= 0) {
    return embeddedCount > 0 ? 100 : 0;
  }
  return Math.min(100, Math.round((embeddedCount / chunkCount) * 100));
};

export const resolveRepoIndexState = (opts: {
  identity: RepoIndexIdentity;
  manifest: RepoIndexManifest | null | undefined;
  minPercentForPartial?: number;
  minPercentForReady?: number;
}): RepoIndexState => {
  const gitHead = opts.identity.gitHead.trim();
  if (!gitHead) {
    return "none";
  }

  const manifest = opts.manifest;
  if (!manifest) {
    return "none";
  }

  if (
    manifest.orgId !== opts.identity.orgId ||
    manifest.repoFullName !== opts.identity.repoFullName
  ) {
    return "stale";
  }

  if (manifest.gitHead.trim() !== gitHead) {
    return "stale";
  }

  const partialMin = opts.minPercentForPartial ?? 40;
  const readyMin = opts.minPercentForReady ?? 80;
  const pct = manifest.percentComplete;

  if (manifest.status === "building") {
    return "building";
  }

  if (manifest.status === "ready" || pct >= readyMin) {
    return "ready";
  }

  if (manifest.status === "partial" || pct >= partialMin) {
    return "partial";
  }

  if (pct > 0) {
    return "building";
  }

  return "none";
};

export const semanticSearchAvailableForState = (
  state: RepoIndexState,
  minPercent: number,
  manifest: RepoIndexManifest | null,
): boolean => {
  if (state === "ready") {
    return true;
  }
  if ((state === "partial" || state === "building") && manifest) {
    return manifest.percentComplete >= minPercent;
  }
  return false;
};
