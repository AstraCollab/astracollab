# `@astracollab/agents`

Per-agent configuration for AstraCollab, running on
[`not-another-harness`](../../not-another-harness) instead of Mastra.

It is named in the plural because it is the home for *agent* definitions rather
than one of them: today the ticket-coding agent and the workspace assistant, and
whatever comes next. The harness owns the loop, the tools and the generic guards;
everything here is what makes a particular agent behave the way this product needs
it to.

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
import { createCodingAgentRun, wrapToolsWithSanitisers } from "@astracollab/agents";
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

## Memory

```ts
import { runWithMemory, withMemoryContext } from "@astracollab/agents";

const { result, context, degraded, learning } = await runWithMemory(
  { memory: cognitiveMemory, stateStore, key: chatId },
  { userMessage, run: (context) => runAssistant(context) },
);
```

Three pieces, in the order they are used:

- **`MemorySource`** — `load()` for the transcript, `save(SessionUpdate)` for the
  way back. Deliberately the shape the harness already speaks (`messages` in,
  `sessionUpdate` out), and deliberately **not** in the harness: NAH is a published
  package, and `session-manager.ts` already states the doctrine that the harness must
  not become a second source of truth for a transcript. Not `prepareStep` either —
  that runs per *step*, so retrieval would fire once per step.
- **`createFallbackMemory`** — read legacy Mastra history, write only to the new
  store. One-way on purpose: the old store is frozen and read-only, so there is no
  dual-write to diverge. Migrates lazily, per thread, on first touch.
- **`runWithMemory`** — the whole turn: build context, run, learn. In that order,
  which is the point; the ordering cannot then be got wrong at a call site.

**A memory failure never fails a turn.** `load` and `save` are wrapped so a store
outage degrades the turn instead of ending it, and the degradation is *returned*
rather than swallowed — a silent skip is indistinguishable from a working one until
the fact you taught it never comes back. A circuit breaker stops paying the timeout
on every turn once the store is clearly down.

**Sync or async context, both supported.** `getPromptContext` may return a string or a
promise, because the engine is synchronous and the service is HTTP. Accepting only sync
would quietly exclude the service, and an adapter that fired an unawaited request and
returned `""` would give a turn with no memory and no error.

**Import it from `cogmemory/engine` if you are not calling the service.** The root
entry carries a top-level `import { ofetch }`, and that throws
`ERR_MODULE_NOT_FOUND` in a pnpm workspace — including this monorepo — even though
the engine never makes a network call. `cogmemory/engine` has no such import.

**Durable facts come from `cogmemory`, and are lexical.** No embeddings: its
`MemoryItem.embedding` field is optional and nothing populates it by default, and its
ranking is token overlap, so recall does not depend on model quality and costs no
first-token latency. `MemorySource` is a structural interface, so this package does
not depend on `cogmemory` — the app passes the engine.

Two things the engine requires, both found by running it rather than reading it:

- **`postTurnAsync` is called as a method, never detached.** `cogmemory`'s engine is
  a class, so `const learn = memory.postTurnAsync; learn(turn)` runs it with `this`
  undefined and dies inside on `this.stats`.
- **A missing snapshot is not passed to `loadSnapshot`.** The real one reads
  `snapshot.l0` immediately and throws on `null`, so a brand-new thread would break
  memory on its first turn.

**Plain facts: deterministic rules DO cover them — but only via the service.**
`cogmemory` ships `extractDeterministic`, which captures URLs, stated requirements
("always / never / must / remember to") and **"X is Y" assignments** — so "Billing
contact is ops@acme.test" *is* extractable without a model. Two things to know:

- The **bare `CognitiveMemory` engine does not call it.** `postTurnAsync` on the engine
  only tries a model-backed `extract`, then falls back to a much narrower regex
  (`memory.ts:857`) that matches requirements alone. Embedded naively, plain
  assignments are silently lost.
- The **`@astracollab/cognitive-memory` service does call it**, and runs it *first*,
  with the model layered on top (`apps/cognitive-memory/src/server/engine/memory-engine.ts:681`),
  so a plainly-stated fact is captured even when the model refuses or hedges. It also
  skips extraction on questions, which stops the assistant's own answers being stored
  back as memories.

So the client's choice is real but different from what it first looks like: **embed the
engine and you must wire `extractDeterministic` yourself**, or **talk to the service**
and get rules-plus-model for free. The service is the better default here — it is
multi-tenant, persists state, and is already the deployment's memory.

## Still Mastra, deliberately

Workflows, ClickHouse observability, server/auth and the Studio stay on
`@mastra/core`. This migration replaces the **agent**, and the app depends on both
until that changes. Choosing that seam is a decision, not a side effect — worth
making explicitly rather than discovering it at the end.

pgvector memory is the one that moves, and it moves *away*: the plan is lexical
recall over data the app can already filter in SQL, not a vector index over
conversation messages.

## Develop

```sh
pnpm test        # vitest
pnpm lint        # tsc --noEmit
pnpm build       # dist/
```