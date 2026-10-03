# @astracollab/agent-sandbox

Framework-neutral helpers for coding sandboxes, with separate Mastra and NAH adapters.

The core package handles repository filesystems, Git operations, snapshots,
and sandbox lifecycle without depending on an agent framework. Framework
integrations are opt-in subpaths: `@astracollab/agent-sandbox/mastra` and
`@astracollab/agent-sandbox/nah`. Provider-specific sandbox instances are
passed in by the caller.

## Install

```bash
npm install @astracollab/agent-sandbox ofetch
# pick a sandbox provider too, e.g.
npm install @mastra/blaxel
# install only the framework adapter you use
npm install @mastra/core
# or use NAH's AI SDK harness
npm install not-another-harness ai zod
```

## Quick start

```ts
import { createCodingWorkspace } from "@astracollab/agent-sandbox/mastra";
import { BlaxelSandbox } from "@mastra/blaxel";
import {
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

Use this from your agent runtime as a custom tool or thin wrapper when you want sandbox-side code search and edits.

## Framework adapters

### Mastra

Import Mastra integration from `@astracollab/agent-sandbox/mastra`. It provides
`createCodingWorkspace`, `RepoWorkspaceFilesystem`, and Mastra-compatible
filesystem tools. The core package does not import Mastra.

### NAH

Import `createNahToolEnvironment` from
`@astracollab/agent-sandbox/nah` to adapt the shared repo filesystem and
sandbox command runner to NAH's `ToolEnvironment` contract:

```ts
import { createNahToolEnvironment } from "@astracollab/agent-sandbox/nah";
import { createCodingTools } from "not-another-harness";

const environment = createNahToolEnvironment({ repoFs, sandbox });
const tools = createCodingTools(environment);
```

Each adapter is an integration layer over the same filesystem and sandbox
helpers. Choose one or both based on the agent runtime in your application.

## Core API

The framework-neutral root exports sandbox types, filesystem ports, Blaxel
filesystem construction, Git helpers, snapshot helpers, retry/pagination,
and code-index utilities. Agent-specific setup is exported only from adapter
subpaths.

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

The core package stays framework-neutral; adapter subpaths externalize their
framework peers so applications can install only what they use.

## License

MIT — see [`LICENSE`](./LICENSE).

## Design rules

- **ofetch over axios** for any HTTP work (smaller bundle, Workers-friendly).
- **Factory functions over constructors** (`createCodingWorkspace`,
  `createHttpClient`).
- **Custom errors with semantic predicates** (`SandboxApiError` with
  `isQuotaError`, `isProvisioningError`, …).
- **Helpers as separate exports** so consumers can compose differently.
- **Types-first** with literal unions instead of enums.
- **Vite library mode** with `formats: ["es", "cjs"]`, ESM-first, sourcemaps
  on, `vite-plugin-dts` for declarations.
- **Framework-neutral core.** Mastra and NAH integrations live in adapter
  subpaths; callers pass their sandbox provider runtime to the shared helpers.
- **No Astra-specific defaults** baked in. `skills`, `runId` formatting, git
  identity, and image choices are caller-provided.

## Development

This package is a member of the **repository-root** pnpm workspace — there is no
nested workspace and no second lockfile. Use pnpm from the repository root:

```bash
corepack enable
pnpm install
pnpm --filter @astracollab/agent-sandbox build
pnpm --filter @astracollab/agent-sandbox test
```

### `npm install` and `Unsupported URL Type "link:"`

Do **not** run `npm install` at the **repository root** while the tree still has a
**pnpm-style `node_modules`** (the `.pnpm/` layout). npm can walk into packages
such as Vite whose `package.json` lists pnpm-only `link:` devDependency
specifiers, which triggers `npm ERR! code EUNSUPPORTEDPROTOCOL` /
`Unsupported URL Type "link:"`.

**Fix:** from the repo root, either use pnpm as above, or reset and stay on npm
only:

```bash
rm -rf node_modules
npm install
```

## Release

Released from the **repository root**, alongside `cogmemory`,
`not-another-harness`, and `nah-ai`:

```bash
pnpm release:publish
```

This package previously carried its own nested workspace, its own lockfile, and a
Changesets release workflow. That workflow could never run — GitHub Actions only
reads `.github/workflows` from the repository root — so the package was not
publishable by either mechanism. It is now built, versioned, and published with
the rest of the monorepo.
