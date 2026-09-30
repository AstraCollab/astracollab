---
"@astracollab/agent-sandbox": minor
---

Initial release: `createCodingWorkspace`, `withSandbox`, `cloneRepo`,
`commitAndPush`, `snapshotToS3`, `restoreFromS3`,
`rotateSnapshotsForTicket`, `withRetry`, `paginateAll`,
`SandboxApiError`, and `createHttpClient`.

- Mastra-aware (`Workspace` from `@mastra/core/workspace`), vendor-agnostic.
- ESM-first, CJS shipped alongside, sourcemaps on, ~5–10 KB target.
- Generic `S3SnapshotConfig` (Tigris / S3 / R2 / MinIO).
