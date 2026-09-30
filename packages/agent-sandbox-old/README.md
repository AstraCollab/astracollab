# agent-sandbox-sdk

Open-source SDK for orchestrating Mastra `Workspace` coding sandboxes.

This monorepo houses small, type-first, ESM-first packages built for Mastra
users who want to drive a `WorkspaceSandbox` (Blaxel, E2B, Modal, Daytona,
local, or a self-hosted runtime) without hand-rolling the lifecycle, git,
or snapshot plumbing.

## Packages

| Package | Description |
| --- | --- |
| [`@astracollab/agent-sandbox`](./packages/agent-sandbox) | Core SDK: `createCodingWorkspace`, `cloneRepo`, `commitAndPush`, `snapshotToS3`, `restoreFromS3`, `withSandbox`, retry/pagination helpers. Mastra-aware, vendor-agnostic. |

Future packages (deferred) will add concrete sandbox providers (e.g. a
self-hosted Hetzner/Fly/Cloudflare runtime) that implement Mastra's
`WorkspaceSandbox` interface.

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
- **No vendor SDK imports** in `@astracollab/agent-sandbox`. Callers pass in
  the `WorkspaceSandbox` instance themselves.
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
