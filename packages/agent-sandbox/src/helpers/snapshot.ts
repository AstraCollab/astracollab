import type {
  RestoreOptions,
  RotateSnapshotsOptions,
  S3SnapshotConfig,
  SnapshotOptions,
  SnapshotResult,
} from "../types.js";

const DEFAULT_EXCLUDES = [
  ".next/cache/**",
  ".turbo/**",
  "node_modules/.cache/**",
  "coverage/**",
  ".pytest_cache/**",
  "__pycache__/**",
  ".venv/**",
  "*.log",
];

const requireSandboxExec = (sandbox: { executeCommand?: unknown }) => {
  if (typeof sandbox.executeCommand !== "function") {
    throw new Error(
      "Sandbox provider does not implement executeCommand(). snapshot helpers require a runnable sandbox.",
    );
  }
};

const buildS5cmdEnv = (config: S3SnapshotConfig): Record<string, string> => ({
  AWS_ACCESS_KEY_ID: config.accessKeyId,
  AWS_SECRET_ACCESS_KEY: config.secretAccessKey,
  AWS_REGION: config.region ?? "auto",
  S3_ENDPOINT_URL: config.endpoint,
});

const buildTarExcludeArgs = (exclude: string[]): string =>
  exclude
    .map((pattern) => `--exclude=${JSON.stringify(pattern)}`)
    .join(" ");

const buildShellQuote = (value: string) => `'${value.replace(/'/g, "'\\''")}'`;

/**
 * Snapshot a working tree to S3-compatible storage as a `.tar.gz` archive.
 *
 * Pipes `tar c | s5cmd pipe`, so:
 * - the archive is streamed directly (no on-disk intermediate),
 * - multipart upload happens inside `s5cmd` for speed,
 * - the sandbox image only needs `tar` + `s5cmd` (both small).
 *
 * Pass `background: true` to spawn the upload as a sandbox-side background
 * process and return its PID immediately — Mastra workflows can then poll
 * `get_process_output` (with suspend/resume) to await it without holding
 * the Worker invocation open.
 */
export const snapshotToS3 = async ({
  sandbox,
  cwd,
  key,
  config,
  exclude,
  background,
  timeoutMs,
}: SnapshotOptions): Promise<SnapshotResult> => {
  requireSandboxExec(sandbox);

  const excludeArgs = buildTarExcludeArgs(exclude ?? DEFAULT_EXCLUDES);
  const s3Url = `s3://${config.bucket}/${key}`;
  const command = [
    `cd ${buildShellQuote(cwd)}`,
    `tar -cz ${excludeArgs} . | s5cmd --endpoint-url ${buildShellQuote(config.endpoint)} pipe ${buildShellQuote(s3Url)}`,
  ].join(" && ");

  const env = buildS5cmdEnv(config);

  if (background && sandbox.processes?.spawn) {
    const handle = await sandbox.processes.spawn(`bash -lc ${buildShellQuote(command)}`, {
      env,
      cwd,
    });
    return { key, pid: handle.pid };
  }

  const result = await sandbox.executeCommand!("bash", ["-lc", command], {
    env,
    cwd,
    timeout: timeoutMs,
  });
  return {
    key,
    bytes:
      typeof (result as { bytesUploaded?: number }).bytesUploaded === "number"
        ? (result as { bytesUploaded?: number }).bytesUploaded
        : undefined,
  };
};

/**
 * Restore a `.tar.gz` snapshot from S3 into `targetDir`. Creates the dir if
 * missing. Uses `s5cmd cat | tar -xz` so nothing hits the sandbox disk in
 * between.
 */
export const restoreFromS3 = async ({
  sandbox,
  key,
  config,
  targetDir,
  timeoutMs,
}: RestoreOptions): Promise<void> => {
  requireSandboxExec(sandbox);

  const s3Url = `s3://${config.bucket}/${key}`;
  const command = [
    `mkdir -p ${buildShellQuote(targetDir)}`,
    `s5cmd --endpoint-url ${buildShellQuote(config.endpoint)} cat ${buildShellQuote(s3Url)} | tar -xz -C ${buildShellQuote(targetDir)}`,
  ].join(" && ");

  await sandbox.executeCommand!("bash", ["-lc", command], {
    env: buildS5cmdEnv(config),
    timeout: timeoutMs,
  });
};

/**
 * Rotate snapshots so only the newest object under `prefix` remains. The
 * prefix should typically be `s3://bucket/orgs/{orgId}/tickets/{ticketId}/runs/`
 * — this keeps a single snapshot per ticket in steady state.
 *
 * Implemented as `s5cmd ls | sort by ModTime | rm everything except the
 * last entry`. Cheap (~zero or one delete per ticket); provider-portable
 * because everything happens inside the sandbox.
 */
export const rotateSnapshotsForTicket = async ({
  sandbox,
  prefix,
  config,
}: RotateSnapshotsOptions): Promise<{ deleted: number }> => {
  requireSandboxExec(sandbox);

  const normalizedPrefix = prefix.endsWith("/") ? prefix : `${prefix}/`;
  const env = buildS5cmdEnv(config);

  const listCommand = `s5cmd --endpoint-url ${buildShellQuote(config.endpoint)} ls ${buildShellQuote(`${normalizedPrefix}*`)} | sort -r | tail -n +2 | awk '{print $NF}'`;
  const listResult = await sandbox.executeCommand!("bash", ["-lc", listCommand], { env });
  const stdout =
    (listResult as { stdout?: string }).stdout ??
    (listResult as { result?: string }).result ??
    "";
  const keysToDelete = stdout
    .split("\n")
    .map((s: string) => s.trim())
    .filter((s: string) => s.length > 0);

  if (keysToDelete.length === 0) {
    return { deleted: 0 };
  }

  for (const objectName of keysToDelete) {
    const targetUrl = objectName.startsWith("s3://")
      ? objectName
      : `${normalizedPrefix}${objectName}`;
    await sandbox.executeCommand!(
      "bash",
      [
        "-lc",
        `s5cmd --endpoint-url ${buildShellQuote(config.endpoint)} rm ${buildShellQuote(targetUrl)}`,
      ],
      { env },
    );
  }

  return { deleted: keysToDelete.length };
};
