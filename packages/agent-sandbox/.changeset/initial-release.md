---
"@astracollab/agent-sandbox": minor
---

Initial release: shared sandbox core, `./mastra` and `./nah` adapters,
`withSandbox`, `cloneRepo`,
`commitAndPush`, `snapshotToS3`, `restoreFromS3`,
`rotateSnapshotsForTicket`, `withRetry`, `paginateAll`,
`SandboxApiError`, and `createHttpClient`.

- Framework-neutral core with opt-in Mastra and NAH integrations.
- ESM-first, CJS shipped alongside, sourcemaps on, ~5–10 KB target.
- Generic `S3SnapshotConfig` (Tigris / S3 / R2 / MinIO).
