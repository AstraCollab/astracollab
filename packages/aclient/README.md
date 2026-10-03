# `@astracollab/aclient`

The `@astracollab/client` agent surface, running on
[`not-another-harness`](../../not-another-harness) instead of Mastra.

## Why the tools are here and not in the harness

Every tool sanitiser in this package is a workaround for a **model** emitting input
its schema rejects — one provider writing `"True"` for a boolean, one mirroring a
directory path into a glob field. Those are facts about traffic, and they change
monthly. Putting them in the harness would teach it about one customer's models.

So the harness stays a harness: loop, tiers, tools, budgets, telemetry. Anything
shaped like "this product's traffic does X" lives here.

That is also the answer to `writer.custom`: the patch it replaces existed because
Mastra's optional chaining on `writer.custom` throws. The harness has no `writer`
concept, so the bug has nowhere to occur and the patch simply disappears.

## What is ported

| From the client | Here | Notes |
|---|---|---|
| `sanitize*Input` per tool | `tool-input.ts` | Same shapes, plus a `wrapToolsWithSanitisers` helper instead of one wrapper per tool |
| `patch-mastra-workspace-list-files-booleans` | `coerceOptionalBoolean` / `Number` / `String` | In terminal behaviour, not in a dist patch |
| `patch-mastra-workspace-list-files-pattern` | `sanitiseListFilesInput` | Drops a `pattern` that merely repeats `path`; leaves a real glob alone |
| `patch-mastra-workspace-writer-custom` | *deleted* | No `writer` concept to guard |
| `coding-agent.ts` `prepareStep` | `createPrepareStep` | **Step numbering changed — read below** |
| `Agent.generate/stream` | `createCodingAgentRun` | Returns the harness handle, so streaming, steering and tracing are unchanged |
| `tracingOptions.tags/metadata` | `runAgent({ tags })` | |

## The one thing to check in review

**Mastra's `prepareStep` numbers steps from 0. The harness numbers them from 1.**

```
Mastra:  if (requireFirstTool && stepNumber === 0) return { toolChoice: "required" }
Harness: if (requireFirstToolAllowed && stepNumber === 1) return { toolChoice: "required" }
```

A bound moved by one typechecks, survives review, and quietly requires a tool one
step too late. Every step-indexed rule in `createPrepareStep` carries the number
it was ported from, and `test/port.test.ts` asserts the first-step behaviour
directly rather than through an agent run.

## Usage

```ts
import { createCodingAgentRun, wrapToolsWithSanitisers } from "@astracollab/aclient";
import { createNodeEnvironment } from "not-another-harness/node";

const run = createCodingAgentRun({
  model,
  environment: createNodeEnvironment(cwd),
  approve: async (toolName) => askTheUser(toolName),
  mode: "implement",
  forceToolChoiceUntilFirstTool: true,
  requireFirstTool: true,
  workflow: "agent-ticket-pr",
  prompt: "implement the ticket",
});

for await (const event of run.events) render(event);
const result = await run.result;
```

Tools come from the harness and are wrapped on the way out:

```ts
const tools = wrapToolsWithSanitisers(createCodingTools(env, { approveToolCall }));
```

## Still Mastra, deliberately

Workflows, ClickHouse observability, pgvector memory, server/auth and the Studio
stay on `@mastra/core`. This migration replaces the **agent**, and the app depends
on both until that changes. Choosing that seam is a decision, not a side effect —
worth making explicitly rather than discovering it at the end.

## Develop

```sh
pnpm test        # vitest
pnpm lint        # tsc --noEmit
pnpm build       # dist/
```