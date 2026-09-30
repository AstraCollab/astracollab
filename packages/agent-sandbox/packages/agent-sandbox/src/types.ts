import type { SandboxInstance } from "@blaxel/core";
import type {
  SkillSource,
  SkillsResolver,
  WorkspaceSandbox,
  WorkspaceToolsConfig,
} from "@mastra/core/workspace";

/**
 * Sandbox provider literals. Use a string union rather than an enum so the
 * type stays cheap, tree-shakeable, and extensible by consumers.
 */
export type ProviderName =
  | "blaxel"
  | "cloudflare"
  | "e2b"
  | "modal"
  | "daytona"
  | "hetzner"
  | "fly"
  | "local"
  | (string & {});

export interface CodingWorkspaceOptions {
  /** A `WorkspaceSandbox` instance (Blaxel, E2B, Modal, Daytona, local, …). */
  sandbox: WorkspaceSandbox;
  /** Stable identifier for this run, used as the workspace id. */
  runId: string;
  /**
   * Absolute path to the git clone inside the sandbox (default `/workspace/repo`).
   * Used when {@link getBlaxelInstance} is set to wire Mastra `Workspace.filesystem`.
   */
  repoRoot?: string;
  /**
   * When set (typically Blaxel), builds a Mastra {@link WorkspaceFilesystem} over
   * `SandboxInstance.fs` so agents get `read_file` / `write_file` without MCP `fs*`.
   * Must be callable only after `await workspace.init()` / sandbox start.
   */
  getBlaxelInstance?: () => SandboxInstance;
  /**
   * Optional GitHub token. The SDK itself never reads this — pass it
   * to `cloneRepo` / `commitAndPush` when you call them. Stored on the
   * options for symmetry with the prompt-injection helpers in the docs.
   */
  githubToken?: string;
  /** Skill paths or a Mastra `SkillsResolver` (static array or dynamic function). */
  skills?: SkillsResolver;
  /**
   * When set, Mastra discovers workspace skills via this source (e.g. {@link LocalSkillSource}).
   * If omitted, Mastra may fall back to the workspace filesystem for discovery — which can break
   * for Blaxel-backed repo filesystems where skill paths are not host-local.
   */
  skillSource?: SkillSource;
  /**
   * When true, Mastra built-in workspace FS tools (`mastra_workspace_read_file`, etc.)
   * are disabled so the host can register {@link createCodingRepoFilesystemTools} on the
   * `Agent` instead — same tool ids, no Mastra workspace `writer` streaming in those tools.
   */
  useAstraRepoFilesystemTools?: boolean;
  /** Per-tool overrides (merged onto the defaults defined in this package). */
  tools?: WorkspaceToolsConfig;
  /** Enable debug logging (no-ops in production by default). */
  debug?: boolean;
  /** Override the auto-generated `id` (defaults to `agent-run-${runId}`). */
  id?: string;
}

/**
 * Generic S3-compatible snapshot configuration. Works with Tigris, AWS S3,
 * Cloudflare R2, MinIO — anything `s5cmd` can talk to.
 */
export interface S3SnapshotConfig {
  endpoint: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Optional explicit region (defaults to `auto` for S3-compatible stores). */
  region?: string;
}

export interface SnapshotOptions {
  sandbox: WorkspaceSandbox;
  /** Working directory inside the sandbox that contains the repo. */
  cwd: string;
  /** Object key, e.g. `orgs/{orgId}/tickets/{ticketId}/runs/{runId}.tar.gz`. */
  key: string;
  config: S3SnapshotConfig;
  /**
   * Tar excludes. Defaults to typical caches (`.next/cache`, `.turbo`,
   * `node_modules/.cache`, `coverage`, …). Pass an empty array to disable.
   */
  exclude?: string[];
  /**
   * When true, run the tar+upload as a sandbox-side background process and
   * return the spawned PID without waiting for completion. The workflow can
   * then poll `get_process_output` (Mastra suspend/resume) to await it.
   */
  background?: boolean;
  /** Timeout in ms for the foreground call (ignored when `background: true`). */
  timeoutMs?: number;
}

export interface SnapshotResult {
  /** Same key that was uploaded — useful for chaining. */
  key: string;
  /** Compressed size in bytes when available. */
  bytes?: number;
  /** Process id when run in the background. */
  pid?: number | string;
}

export interface RestoreOptions {
  sandbox: WorkspaceSandbox;
  key: string;
  config: S3SnapshotConfig;
  /** Directory the archive contents should be extracted into. */
  targetDir: string;
  timeoutMs?: number;
}

export interface CloneOptions {
  sandbox: WorkspaceSandbox;
  /** HTTPS clone URL. The token is injected via `x-access-token`. */
  url: string;
  token?: string;
  branch: string;
  /** Defaults to 1 — shallow clones are dramatically faster. */
  depth?: number;
  targetDir: string;
}

export interface CommitOptions {
  sandbox: WorkspaceSandbox;
  cwd: string;
  message: string;
  branch: string;
  authorName?: string;
  authorEmail?: string;
}

export interface GitConfigOptions {
  sandbox: WorkspaceSandbox;
  cwd: string;
  userName: string;
  userEmail: string;
}

export interface RetryOptions {
  attempts?: number;
  baseDelayMs?: number;
  factor?: number;
  /** Optional predicate; if it returns false, the error is rethrown immediately. */
  shouldRetry?: (error: unknown, attempt: number) => boolean;
}

export interface PageFetchResult<T> {
  items: T[];
  /** Opaque cursor; pass it back to the fetcher to read the next page. */
  nextCursor?: string | null;
}

export type PageFetcher<T> = (
  cursor: string | undefined,
) => Promise<PageFetchResult<T>>;

export interface RotateSnapshotsOptions {
  sandbox: WorkspaceSandbox;
  /**
   * Prefix to scan, e.g. `s3://bucket/orgs/{orgId}/tickets/{ticketId}/runs/`.
   * The helper sorts by ModTime descending and deletes everything except
   * the newest object.
   */
  prefix: string;
  config: S3SnapshotConfig;
}
