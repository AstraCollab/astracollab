/** Minimal execution/lifecycle surface shared by sandbox provider adapters. */
export interface SandboxRuntime {
  executeCommand?: (
    command: string,
    args: string[],
    options?: { cwd?: string; env?: Record<string, string>; timeout?: number },
  ) => Promise<{ success?: boolean; exitCode?: number; stdout?: string; stderr?: string; result?: string; bytesUploaded?: number }>;
  start?: () => Promise<unknown>;
  destroy?: () => Promise<unknown>;
  processes?: {
    spawn?: (command: string, options?: { cwd?: string; env?: Record<string, string> }) => Promise<{ pid?: string | number }>;
  };
}

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
  sandbox: SandboxRuntime;
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
   * then poll the provider's process output API to await it.
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
  sandbox: SandboxRuntime;
  key: string;
  config: S3SnapshotConfig;
  /** Directory the archive contents should be extracted into. */
  targetDir: string;
  timeoutMs?: number;
}

export interface CloneOptions {
  sandbox: SandboxRuntime;
  /** HTTPS clone URL. The token is injected via `x-access-token`. */
  url: string;
  token?: string;
  branch: string;
  /** Defaults to 1 — shallow clones are dramatically faster. */
  depth?: number;
  targetDir: string;
}

export interface CommitOptions {
  sandbox: SandboxRuntime;
  cwd: string;
  message: string;
  branch: string;
  authorName?: string;
  authorEmail?: string;
}

export interface GitConfigOptions {
  sandbox: SandboxRuntime;
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
  sandbox: SandboxRuntime;
  /**
   * Prefix to scan, e.g. `s3://bucket/orgs/{orgId}/tickets/{ticketId}/runs/`.
   * The helper sorts by ModTime descending and deletes everything except
   * the newest object.
   */
  prefix: string;
  config: S3SnapshotConfig;
}
