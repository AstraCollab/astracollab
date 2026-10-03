/** Lifecycle state for a repo code index at a specific commit. */
export type RepoIndexState = "none" | "building" | "partial" | "ready" | "stale";

export const REPO_INDEX_MANIFEST_SCHEMA_VERSION = 1;

export type RepoIndexManifest = {
  schemaVersion: typeof REPO_INDEX_MANIFEST_SCHEMA_VERSION;
  orgId: string;
  repoFullName: string;
  gitHead: string;
  merkleRoot: string;
  fileCount: number;
  chunkCount: number;
  embeddedCount: number;
  /** 0–100; semantic search gates on this vs minPercent. */
  percentComplete: number;
  status: Exclude<RepoIndexState, "none" | "stale">;
  updatedAt: string;
  /** Per-file content hashes for incremental diff on the same commit. */
  fileHashes?: FileMerkleEntry[];
};

export type RepoIndexIdentity = {
  orgId: string;
  repoFullName: string;
  gitHead: string;
};

export type FileMerkleEntry = {
  /** Repo-relative POSIX path */
  path: string;
  sha256: string;
  size: number;
};

export type FileMerkleTree = {
  entries: FileMerkleEntry[];
  root: string;
};

export type SourceChunk = {
  id: string;
  path: string;
  startLine: number;
  endLine: number;
  content: string;
  contentHash: string;
};

export type IndexWorkPlan = {
  added: string[];
  changed: string[];
  deleted: string[];
  unchanged: string[];
};

export type SemanticSearchHit = {
  path: string;
  startLine?: number;
  endLine?: number;
  score?: number;
  snippet: string;
};

export type SemanticSearchResult = {
  query: string;
  backend: "pgvector" | "blaxel" | "grep";
  hits: SemanticSearchHit[];
};

/** Host-provided persistence for chunk embeddings (astracollab: PgVector). */
export interface RepoIndexStore {
  upsertChunks(opts: RepoIndexIdentity & { chunks: SourceChunk[]; vectors: number[][] }): Promise<void>;
  deleteChunksForPaths(opts: RepoIndexIdentity & { paths: string[] }): Promise<void>;
  semanticSearch(opts: RepoIndexIdentity & { query: string; topK?: number }): Promise<SemanticSearchHit[]>;
  isConfigured(): boolean;
}

export type EmbedBatchFn = (texts: string[]) => Promise<number[][]>;

export type RepoIndexManifestStore = {
  load(identity: RepoIndexIdentity): Promise<RepoIndexManifest | null>;
  save(manifest: RepoIndexManifest): Promise<void>;
};

export type CodeIndexProfileHints = {
  entryPointPaths?: string[];
  keyDirectoryPaths?: string[];
};

export type StartRepoIndexJobOptions = {
  identity: RepoIndexIdentity;
  repoFs: import("../sandbox-fs/repo-fs-port.js").RepoSandboxFs;
  repoRelativeRoot?: string;
  manifestStore: RepoIndexManifestStore;
  indexStore: RepoIndexStore;
  embedBatch: EmbedBatchFn;
  profileHints?: CodeIndexProfileHints;
  /** Max files to index in one job (safety cap). */
  maxFiles?: number;
  /** Target percent before marking `ready`. */
  readyPercent?: number;
  /** Concurrency for file reads + embed batches. */
  concurrency?: number;
  /** Skip paths matching these picomatch globs (repo-relative). */
  ignoreGlobs?: string[];
  onProgress?: (manifest: RepoIndexManifest) => void | Promise<void>;
};

export type EnsureRepoIndexOptions = {
  identity: RepoIndexIdentity;
  manifestStore: RepoIndexManifestStore;
  /** When true and index not ready, start background job without awaiting completion. */
  background?: boolean;
  minPercentForPartial?: number;
  startJob?: () => Promise<void>;
};

export type EnsureRepoIndexResult = {
  state: RepoIndexState;
  manifest: RepoIndexManifest | null;
  semanticSearchAvailable: boolean;
};
