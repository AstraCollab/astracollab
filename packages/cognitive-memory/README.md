# Cognitive Memory — SDK

TypeScript client for [Cognitive Memory](../../apps/cognitive-memory): deterministic
four-tier memory for agents, served as a credentialed storage layer.

~3.2kB gzipped, ESM-first, one small peer dependency.

## Install

```sh
npm i cogmemory ofetch     # talking to the service
npm i cogmemory            # in-process engine only — no ofetch needed
```

`ofetch` is a peer dependency on purpose — it is ~5kB, works in Node, Deno,
Workers and the browser, and bundling a second copy inside every consumer that
already has one helps nobody.

### Entry points

| Import | Needs | What it is |
|---|---|---|
| `cogmemory` | `ofetch` | Everything, including the HTTP `Cogmem` client |
| `cogmemory/engine` | nothing | The deterministic engine and its helpers |
| `cogmemory/arbiter` | `ai`, `zod` | The model-backed arbiter |

**Prefer `cogmemory/engine` if you are not calling the service.** The root entry
carries a top-level `import { ofetch }`, and a top-level import of a module you
never call still throws: `ERR_MODULE_NOT_FOUND` in any pnpm workspace, where an
undeclared peer does not resolve and npm's automatic peer installation does not
apply. The engine makes zero network calls, so requiring an HTTP library to use
it is pure cost. It is now an **optional** peer, so nothing warns about it either.

```ts
import { CognitiveMemory, extractDeterministic } from "cogmemory/engine"
```

## Use

```ts
import { createClient, runTurn } from "cogmemory"

const memory = createClient({
  apiKey: process.env.COGNITIVE_MEMORY_KEY!,
  baseUrl: "http://localhost:3000",
  debug: process.env.DEBUG !== undefined
})
```

Get a key from the dashboard. It is shown once, because only a hash is stored.

## The two calls that matter

```ts
// Before the model runs.
const { text, totalTokens } = await memory.context.build({ userMessage })

// After the reply finishes streaming.
const learned = await memory.turns.learn({ userMessage, assistantResponse })
```

`runTurn` does both, in the right order, and will not let a memory failure take
down a turn that already produced an answer:

```ts
const { context, learning, learningSkipped } = await runTurn(
  memory,
  { userMessage, run: (ctx) => callYourModel(ctx, userMessage) },
  { domain: "database" } // enables guardrails for a domain you measure
)
```

`learningSkipped` is set when memory did not learn, and why. A silent skip is
indistinguishable from a working one until the thing you taught it never comes
back.

## Resources

Each maps one-to-one onto an endpoint, so the class is a namespace rather than a
second copy of the service:

```ts
memory.memories   // create, list, get, promote, remove
memory.context    // build
memory.recall     // search
memory.turns      // learn
memory.tensions   // list, create, resolve
memory.selfModel  // get, record
memory.stats      // get
memory.health()   // no key spent
```

## Errors

Every failure arrives as a `CognitiveMemoryError` carrying the service's own tag,
status, the scope that was missing, and any field issues — so callers ask
semantic questions rather than matching status codes.

```ts
import { CognitiveMemoryError } from "cogmemory"

try {
  await memory.memories.create({ items: [{ content: "the build id is ZQ7X4M2K" }] })
} catch (error) {
  if (!(error instanceof CognitiveMemoryError)) throw error

  if (error.isScopeError()) {
    // 403, and the service said which scope would have worked
    console.error(`key needs ${error.requiredScope}`)
  } else if (error.isValidationError()) {
    console.error(error.issues) // ["Expected string at [query]"]
  } else if (error.isNotFoundError()) {
    // 404 also covers another organisation's id, by design
  } else if (error.isServerError()) {
    // safe to retry
  }
}
```

Transport failures — no response at all — are re-thrown untouched, so a network
error is never confused with an API error.

## Helpers

```ts
import { runTurn, recallOrExplain, seedMemories } from "cogmemory"

// Formatted for injection, and honest when nothing matched.
const facts = await recallOrExplain(memory, "staging build id")
// → 'Remembered (1 match):\n- The staging build id is ZQ7X4M2K (deployment) [L1, relevance 0.75]'
// → 'Nothing in memory matches "…". If you were not told, say so rather than guessing.'

// Idempotent: restatements come back under `merged`, not as errors.
await seedMemories(memory, { facts: ["file naming is kebab-case", "the port is 2291"] })
```

## Types

Every response and request type is exported, with literal unions rather than
`string` so an editor offers exactly the valid values:

```ts
import type { Memory, MemoryTier, InclusionReason, SelfModel } from "cogmemory"

const tier: MemoryTier = "L1"          // "L0" | "L1" | "L2" | "L3"
const reason: InclusionReason = "trigger" // index | trigger | tension | guardrail
```

## Development

```sh
pnpm build   # vite library build: ESM + CJS + rolled-up .d.ts
pnpm test
```

The HTTP layer is tested by mocking `fetch` — the thing worth testing is that
every request is authenticated and that errors are translated, and mocking the
SDK instead would test the mock. The helpers are tested against a mocked client,
because there the behaviour under test is the composition.
