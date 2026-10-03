export type {
  CodeIndexProfileHints,
  EmbedBatchFn,
  EnsureRepoIndexOptions,
  EnsureRepoIndexResult,
  FileMerkleEntry,
  FileMerkleTree,
  IndexWorkPlan,
  RepoIndexIdentity,
  RepoIndexManifest,
  RepoIndexManifestStore,
  RepoIndexState,
  RepoIndexStore,
  SemanticSearchHit,
  SemanticSearchResult,
  SourceChunk,
  StartRepoIndexJobOptions,
} from "./types.js";
export { REPO_INDEX_MANIFEST_SCHEMA_VERSION } from "./types.js";
export { buildFileMerkleFromEntries, hashContent, hashFileMerkleRoot, planIndexWork } from "./merkle.js";
export { chunkSourceFile, isIndexablePath, prioritizeIndexPaths } from "./chunk.js";
export {
  computePercentComplete,
  resolveRepoIndexState,
  semanticSearchAvailableForState,
} from "./resolve-state.js";
export { walkIndexableFiles } from "./walk-repo.js";
export { startRepoIndexJob } from "./start-repo-index-job.js";
export { ensureRepoIndex } from "./ensure-repo-index.js";
export { hybridSemanticSearch, type HybridSemanticSearchOptions } from "./semantic-search.js";
export { resolveProgressiveSearchGate, type ProgressiveSearchGate } from "./progressive-gate.js";
