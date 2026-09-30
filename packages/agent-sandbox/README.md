# @astracollab/agent-sandbox

Mastra-aware, vendor-agnostic helpers for orchestrating coding sandboxes.

This package gives you a small set of building blocks for treating any
`WorkspaceSandbox` (from `@mastra/core/workspace`) as a coding workspace:
clone a repo, commit and push, snapshot the working tree to S3-compatible
storage, restore it on the next run, and clean up.

It is **provider-agnostic** — it never imports `@mastra/blaxel`,
`@cloudflare/sandbox`, or any vendor SDK. Callers pass the sandbox in.

## Install

```bash
npm install @astracollab/agent-sandbox @mastra/core
# pick a sandbox provider too, e.g.
npm install @mastra/blaxel
```

## Quick start

```ts
import { Workspace } from "@mastra/core/workspace";
import { BlaxelSandbox } from "@mastra/blaxel";
import {
  createCodingWorkspace,
  cloneRepo,
  commitAndPush,
  snapshotToS3,
  restoreFromS3,
  withSandbox,
} from "@astracollab/agent-sandbox";

const workspace = createCodingWorkspace({
  sandbox: new BlaxelSandbox({ image: "blaxel/ts-app:latest", timeout: "30m" }),
  runId: "run_123",
});

await workspace.init();

await cloneRepo({
  sandbox: workspace.sandbox!,
  url: "https://github.com/myorg/myrepo.git",
  token: process.env.GITHUB_TOKEN!,
  branch: "main",
  targetDir: "/workspace/repo",
});

// …agent does work…

await commitAndPush({
  sandbox: workspace.sandbox!,
  cwd: "/workspace/repo",
  message: "agent: implement feature",
  branch: "agent/feature-xyz",
});

await snapshotToS3({
  sandbox: workspace.sandbox!,
  cwd: "/workspace/repo",
  key: "orgs/org_123/tickets/tic_456/runs/run_789.tar.gz",
  config: {
    endpoint: "https://t3.storage.dev",
    bucket: "astracollab-sandbox-snapshots",
    accessKeyId: process.env.S3_KEY!,
    secretAccessKey: process.env.S3_SECRET!,
  },
});
```

## Blaxel sandbox codegen (HTTP)

Optional helpers for Blaxel’s **Sandbox API** [codegen routes](https://docs.blaxel.ai/Sandboxes/Codegen-tools.md) — **no `@blaxel/core` dependency**. Pass the sandbox API `baseUrl` and a Bearer token (same JWT the control plane uses for that sandbox).

```ts
import {
  createBlaxelSandboxCodegenClient,
  pickBlaxelSandboxApiBaseUrl,
} from "@astracollab/agent-sandbox";

const baseUrl =
  pickBlaxelSandboxApiBaseUrl(await workspace.sandbox?.getInfo?.()) ??
  process.env.BLAXEL_SANDBOX_API_URL!;

const codegen = createBlaxelSandboxCodegenClient({
  baseUrl,
  token: process.env.BLAXEL_SANDBOX_JWT!,
});

await codegen.contentSearch({
  rootPath: "app",
  query: "AppSidebar",
  filePattern: "*.tsx",
});

await codegen.fastApply({
  filePath: "app/src/foo.ts",
  codeEdit:
    "// ... existing code ...\nexport const bar = 1;\n// ... existing code ...",
});
```

Use this from your Mastra agent as **custom tools** (or a thin wrapper) so the model never shells out to missing `rg` / fragile `git grep`.

## API

### `createCodingWorkspace(options)`

Wraps a `WorkspaceSandbox` in a `Workspace` with sensible defaults
(approval-free read tools, write/edit tools that require a prior read).
You provide `skills`, `runId`, and any per-tool overrides; nothing
Astra-specific is baked in.

### Helpers

- `withSandbox(sandbox, fn)` — RAII lifecycle: starts the sandbox, runs your
  function, then destroys it.
- `cloneRepo({ sandbox, url, token, branch, depth?, targetDir })` — git clone
  using `https://x-access-token:$TOKEN@…` so any provider works.
- `commitAndPush({ sandbox, cwd, message, branch })` — stage all, commit,
  push.
- `gitConfig({ sandbox, cwd, userName, userEmail })` — set git identity.
- `snapshotToS3({ sandbox, cwd, key, config, exclude?, background? })` —
  `tar` the working tree (excluding caches by default), pipe to `s5cmd`
  for fast multipart upload. Returns the spawned process PID when run in
  the background.
- `restoreFromS3({ sandbox, key, config, targetDir })` — pull the tarball
  with `s5cmd`, untar into `targetDir`.
- `rotateSnapshotsForTicket({ sandbox, prefix, config })` — list snapshots
  under a `orgs/{orgId}/tickets/{ticketId}/runs/` prefix and delete every
  object except the newest one.
- `paginateAll(fetcher)` — async iterator wrapper around any cursor-based
  list endpoint.
- `withRetry(fn, opts)` — generic retry with exponential backoff.

### Errors

`SandboxApiError` carries `status`, `code`, and `details`. It has predicate
methods (`isQuotaError()`, `isProvisioningError()`, `isAuthError()`,
`isTimeoutError()`, `isNotFoundError()`) so consumers don't have to sniff
magic status codes.

### Tigris example

Tigris is a great default S3-compatible store for sandbox snapshots. The
sandbox image just needs `s5cmd` installed — the helpers do the rest:

```ts
await snapshotToS3({
  sandbox,
  cwd: "/workspace/repo",
  key: `orgs/${orgId}/tickets/${ticketId}/runs/${runId}.tar.gz`,
  config: {
    endpoint: "https://t3.storage.dev",
    bucket: "astracollab-sandbox-snapshots",
    accessKeyId: process.env.SANDBOX_SNAPSHOT_S3_ACCESS_KEY_ID!,
    secretAccessKey: process.env.SANDBOX_SNAPSHOT_S3_SECRET_ACCESS_KEY!,
  },
});
```

## Bundle size

Target ceiling: ~10 KB minified. The package re-exports only what is needed
and externalizes `ofetch` + `@mastra/core` so they aren't duplicated.

## License

MIT — see [`LICENSE`](../../LICENSE).
