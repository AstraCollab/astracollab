export * from "./types.js";
export { SandboxApiError, isSandboxApiError } from "./errors.js";
export { createHttpClient, type HttpClientConfig, type HttpRequestInit } from "./client.js";
export { createCodingWorkspace, buildBuiltinWorkspaceFilesystemToolsDisabled } from "./workspace.js";

export type { RepoSandboxFs, RepoFsEntry } from "./sandbox-fs/repo-fs-port.js";
export { RepoPathError, normalizeUnderRepoRoot } from "./sandbox-fs/path-utils.js";
export { createBlaxelRepoSandboxFs } from "./sandbox-fs/blaxel-repo-fs.js";
export {
  RepoWorkspaceFilesystem,
  createRepoWorkspaceFilesystemFromBlaxel,
  createCodingRepoFilesystemTools,
} from "./adapters/mastra/index.js";
export type {
  RepoWorkspaceFilesystemOptions,
  CreateCodingRepoFilesystemToolsOptions,
} from "./adapters/mastra/index.js";

export { DEFAULT_CODING_SANDBOX_REPO_DIR } from "./coding-sandbox-repo-path.js";
export {
  BUNDLED_WORKSPACE_SKILL_RELATIVE_PATHS,
  installBundledWorkspaceSkills,
  type InstallBundledWorkspaceSkillsOptions,
} from "./bundled-workspace-skills.js";
export { buildCodingWorkspaceSkillsResolver } from "./skills-resolver.js";

export { withSandbox } from "./helpers/lifecycle.js";
export { withRetry } from "./helpers/retry.js";
export { paginateAll } from "./helpers/pagination.js";
export { cloneRepo, commitAndPush, gitConfig } from "./helpers/git.js";
export {
  snapshotToS3,
  restoreFromS3,
  rotateSnapshotsForTicket,
} from "./helpers/snapshot.js";

export {
  createBlaxelSandboxCodegenClient,
  encodeBlaxelWorkspacePathForUrl,
  normalizeBlaxelSandboxBaseUrl,
  pickBlaxelSandboxApiBaseUrl,
  blaxelSemanticSearchAvailable,
  type BlaxelCodeRerankingFile,
  type BlaxelCodeRerankingParams,
  type BlaxelCodeRerankingResult,
  type BlaxelContentSearchMatch,
  type BlaxelContentSearchParams,
  type BlaxelContentSearchResult,
  type BlaxelFastApplyParams,
  type BlaxelFastApplyResult,
  type BlaxelSandboxCodegenClient,
  type BlaxelSandboxCodegenConfig,
} from "./blaxel-sandbox-codegen.js";

export {
  REPO_INDEX_MANIFEST_SCHEMA_VERSION,
  buildFileMerkleFromEntries,
  chunkSourceFile,
  computePercentComplete,
  ensureRepoIndex,
  hashContent,
  hybridSemanticSearch,
  isIndexablePath,
  planIndexWork,
  prioritizeIndexPaths,
  resolveRepoIndexState,
  semanticSearchAvailableForState,
  startRepoIndexJob,
  resolveProgressiveSearchGate,
  walkIndexableFiles,
  type ProgressiveSearchGate,
  type CodeIndexProfileHints,
  type EmbedBatchFn,
  type EnsureRepoIndexOptions,
  type EnsureRepoIndexResult,
  type FileMerkleEntry,
  type FileMerkleTree,
  type RepoIndexIdentity,
  type RepoIndexManifest,
  type RepoIndexManifestStore,
  type RepoIndexState,
  type RepoIndexStore,
  type SemanticSearchHit,
  type SemanticSearchResult,
  type SourceChunk,
  type StartRepoIndexJobOptions,
} from "./code-index/index.js";
