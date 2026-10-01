# AstraCollab packages

A pnpm monorepo holding the AstraCollab agent stack, client SDKs, and shared tooling.

The centrepiece is a two-package split: **`@astracollab/not-another-harness`** is the agent SDK — a small, inspectable runtime with streaming events, capped coding tools, token budgets and transcript compaction. **`@astracollab/nah`** is the terminal coding agent built on top of it. Use the SDK to embed an agent in your own product; use the CLI to work in a repository.

## Packages

### Agent

| Package | What it is | Published |
| --- | --- | --- |
| [`@astracollab/not-another-harness`](packages/not-another-harness) | Agent SDK. One explicit loop: prepare context, stream one model response, run its tool calls, decide whether to continue. Typed event stream, capped tools, step/token budgets, mid-run compaction, steerable runs, JSONL sessions, and an optional cognitive-memory layer. | `0.0.1-beta.0` |
| [`@astracollab/nah`](packages/nah) | The `nah` terminal agent. Alternate-screen TUI, mid-turn steering, per-run sessions, permission modes, and the `recall` memory tool. Ships as a CLI; also the package that wires the SDK into a real application. | `0.0.1-beta.0` |

`not-another-harness` takes any AI SDK v5 language model and does not pick a provider or own a terminal UI. `nah` supplies credentials, model selection, project instructions, permissions, persistence, and the interface.

### SDKs

Versions below are the latest published on npm. The only package whose manifest
is ahead of the registry is `sync-engine` (`0.0.1-beta.3` local, `0.0.1-beta.1`
published).

| Package | What it is | Published |
| --- | --- | --- |
| [`@astracollab/ai`](packages/ai) | AI provider SDKs. `@astracollab/ai/cursor` exposes Cursor Composer 2.5 inference through an OpenAI-compatible surface and the Vercel AI SDK. | `0.0.1-beta` |
| [`@astracollab/js`](packages/js) | JavaScript SDK for Node.js and browsers. | `0.0.1` |
| [`@astracollab/nextjs`](packages/nextjs) | Next.js SDK: React hooks and components for file uploads. | `0.0.1` |
| [`@astracollab/sync-engine`](packages/sync-engine) | Client/server sync engine with typed schemas, mutators, and a files resource. | `0.0.1-beta.1` |

### Internal

Not published; used by this repo and its apps.

| Package | What it is |
| --- | --- |
| [`packages/agent-sandbox`](packages/agent-sandbox) | Sandbox SDK monorepo. Framework-neutral core for sandbox filesystems, Git, lifecycle, and S3-compatible snapshots, with Mastra and NAH adapters. |
| [`packages/ui`](packages/ui) | Shared React components (`@repo/ui`, private). |
| [`packages/eslint-config`](packages/eslint-config) | Shared ESLint configuration. |
| [`packages/typescript-config`](packages/typescript-config) | Shared `tsconfig` bases. |

`apps/` holds the product site and documentation. It is not covered here.

## Requirements

- pnpm `10.13.1` (pinned via `packageManager` in the root manifest)
- Node.js `22.19` or newer for `nah`, which uses an alternate-screen TUI
- Node.js `20.6` or newer for `not-another-harness`

## Using the agent

Install the CLI:

```sh
npm install -g @astracollab/nah
cd your-project
nah
```

Or embed the SDK:

```sh
npm install @astracollab/not-another-harness ai zod
npm install @ai-sdk/anthropic   # or another AI SDK v5 provider
```

```ts
import { buildSystemPrompt, createCodingTools, runAgent } from "@astracollab/not-another-harness";
import { createNodeEnvironment } from "@astracollab/not-another-harness/node";

const cwd = process.cwd();
const run = runAgent({
  model, // any AI SDK v5 language model
  prompt: "Explain the session refresh flow",
  system: buildSystemPrompt({ cwdLabel: cwd }),
  tools: createCodingTools(createNodeEnvironment(cwd), {
    approveToolCall: (name, input) => askUser(name, input),
  }),
});

for await (const event of run.events) {
  if (event.type === "text-delta") process.stdout.write(event.text);
}
const result = await run.result;
```

See the [SDK guide](packages/not-another-harness/README.md) for steering, budgets, compaction, and the memory layer, and the [CLI guide](packages/nah/README.md) for providers, permissions, sessions, and the TUI.

## Development

```sh
pnpm install

# Build everything publishable
pnpm --filter @astracollab/not-another-harness build
pnpm --filter @astracollab/nah build

# Typecheck and test one package
pnpm --filter @astracollab/nah lint
pnpm --filter @astracollab/nah test
```

The CLI's live model evaluations are opt-in and need a provider key:

```sh
NAH_EVAL_MODEL=openrouter:some-model NAH_EVAL_REPEATS=3 \
  pnpm --filter @astracollab/nah exec vitest run test/live-evals.test.ts
```

## Publishing

Order matters: `nah` depends on `not-another-harness` at a real semver, so publish the runtime first.

```sh
pnpm --filter @astracollab/not-another-harness publish --access public --tag beta
pnpm --filter @astracollab/nah publish --access public --tag beta
```

Both are currently prereleases. `--tag beta` keeps `latest` free for a stable release; until you publish without it, `npm install -g @astracollab/nah` resolves to the newest version regardless of tag.