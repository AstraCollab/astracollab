import type { BlaxelSandboxCodegenClient } from "../blaxel-sandbox-codegen.js";
import { blaxelSemanticSearchAvailable } from "../blaxel-sandbox-codegen.js";
import type { RepoIndexManifest, RepoIndexState } from "./types.js";
import { resolveRepoIndexState, semanticSearchAvailableForState } from "./resolve-state.js";

export type ProgressiveSearchGate = {
  state: RepoIndexState;
  minPercent: number;
  pgvectorAvailable: boolean;
  blaxelAvailable: boolean;
  /** True when implement agent may call semantic search tools. */
  allowSemanticSearch: boolean;
  /** Prefer durable PgVector over live Blaxel sandbox search. */
  preferPgVector: boolean;
};

export const resolveProgressiveSearchGate = (opts: {
  identity: { orgId: string; repoFullName: string; gitHead: string };
  manifest: RepoIndexManifest | null;
  minPercent?: number;
  indexStoreConfigured?: boolean;
  blaxel?: BlaxelSandboxCodegenClient | null;
}): ProgressiveSearchGate => {
  const minPercent = opts.minPercent ?? 80;
  const state = resolveRepoIndexState({
    identity: opts.identity,
    manifest: opts.manifest,
    minPercentForPartial: Math.min(40, minPercent),
    minPercentForReady: minPercent,
  });
  const pgvectorAvailable =
    Boolean(opts.indexStoreConfigured) &&
    semanticSearchAvailableForState(state, minPercent, opts.manifest);
  const blaxelAvailable = blaxelSemanticSearchAvailable(opts.blaxel);
  const preferPgVector = pgvectorAvailable;
  const allowSemanticSearch = pgvectorAvailable || blaxelAvailable;

  return {
    state,
    minPercent,
    pgvectorAvailable,
    blaxelAvailable,
    allowSemanticSearch,
    preferPgVector,
  };
};
