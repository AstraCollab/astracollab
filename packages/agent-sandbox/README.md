# agent-sandbox-sdk

Open-source, framework-neutral SDK for coding sandboxes, with Mastra and NAH adapters.

The shared core handles sandbox filesystems, Git, lifecycle, and S3-compatible
snapshots. Optional adapters connect it to Mastra `Workspace` or NAH's
`ToolEnvironment` contract. Sandbox providers such as Blaxel, E2B, Modal,
Daytona, local, or self-hosted runtimes are supplied by the application.

## Packages

| Package | Description |
| --- | --- |
| [`@astracollab/agent-sandbox`](./packages/agent-sandbox) | Framework-neutral core plus `./mastra` and `./nah` adapter subpaths; includes `cloneRepo`, `commitAndPush`, `snapshotToS3`, `restoreFromS3`, `withSandbox`, retry/pagination helpers. |

Sandbox providers remain the application's choice; adapt their runtime to
the shared sandbox execution and repository filesystem contracts as needed.

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

This monorepo is **pnpm-first** (`packageManager` in the root `package.json`, `pnpm-workspace.yaml`). Use pnpm from the repository root:

```bash
corepack enable
pnpm install
pnpm -r build
```

### `npm install` and `Unsupported URL Type "link:"`

Do **not** run `npm install` at the **monorepo root** while the tree still has a **`pnpm`-style `node_modules`** (the `.pnpm/` layout). npm can walk into packages such as Vite whose `package.json` lists pnpm-only `link:` devDependency specifiers, which triggers `npm ERR! code EUNSUPPORTEDPROTOCOL` / `Unsupported URL Type "link:"`.

**Fix:** from the repo root, either use pnpm as above, or reset and stay on npm only:

```bash
rm -rf node_modules
npm install
```

To install **only** `@astracollab/agent-sandbox` with npm (no workspace), use the package folder:

```bash
cd packages/agent-sandbox
rm -rf node_modules
npm install
```

## Release

Releases are managed by [Changesets](https://github.com/changesets/changesets).
Open a PR with a `pnpm changeset` entry. The release workflow publishes to
public npm with provenance when the changeset is merged.
