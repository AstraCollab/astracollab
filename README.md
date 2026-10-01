# AstraCollab agent tools

This pnpm monorepo contains the Not Another Harness agent runtime, the `nah` terminal coding agent, and the NAH documentation site.

## Main packages

| Package | Purpose | Guide |
| --- | --- | --- |
| `@astracollab/not-another-harness` | Small TypeScript agent runtime with streaming events, capped coding tools, budgets, compaction, and JSONL sessions | [Runtime README](packages/not-another-harness/README.md) |
| `@astracollab/nah` | Terminal coding agent for working directly in a project directory | [CLI README](packages/nah/README.md) |

## Requirements

- Node.js 20.6 or newer for the agent packages
- pnpm 10.13.1 (pinned in the root package manifest)

## Get started in the monorepo

```sh
pnpm install
pnpm --filter @astracollab/not-another-harness build
pnpm --filter @astracollab/nah build
```

Start the terminal agent from a project directory with `pnpm --filter @astracollab/nah exec nah`. See the [CLI guide](packages/nah/README.md) for provider setup, permissions, and session commands.

## Workspace layout

- `packages/not-another-harness` — reusable agent runtime and Node.js workspace adapter
- `packages/nah` — CLI package and executable
- `apps/nah` — product site and user documentation
- `apps/payload`, `packages/ai`, `packages/js`, and `packages/nextjs` — supporting applications and shared libraries
