# Cognitive Memory

A memory service for LLM agents. It keeps the durable facts an agent is told —
build ids, hosts, conventions, constraints — and hands back the relevant ones each
turn. An index by default, full bodies only where something earned them, and no
model in the retrieval path.

- **Web:** [apps/cognitive-memory](apps/cognitive-memory) — the service, its API, and the dashboard
- **SDK:** [packages/cognitive-memory](packages/cognitive-memory) — `@astracollab/cogmem`

## Why it exists

A flat list of strings plus a similarity search is enough to make a demo feel
like recall. It fails in production in three specific ways:

1. **It cannot hold a contradiction.** Two stored claims that cannot both be
   true are indistinguishable from two unrelated facts, so one quietly wins.
2. **It has no notion of cost.** A search returns *k* results, so the prompt
   grows with everything ever learned, and what it gains is topically-related
   distractors — which is what context rot actually measures.
3. **It cannot say why something matched.** A cosine score is not an explanation.

This service is built around those three gaps: tiered storage so per-turn cost is
a decision, contradictions as first-class rows, and every injection recorded with
the rule that produced it.

## The four tiers

| Tier | Name | Holds | Cost per turn |
| --- | --- | --- | --- |
| L0 | Pinned | Tensions, self-model guardrails, correction notices | Full body, always |
| L1 | Hot cache | Newly learned and pre-staged facts | Index line, body on trigger |
| L2 | Warm store | Candidates scored against each turn | Nothing until promoted |
| L3 | Cold archive | Everything else, still recallable | Nothing until recalled |

## Quickstart

```sh
pnpm install
pnpm --filter cognitive-memory dev
```

Open <http://localhost:3000>, sign up, and mint a key from the dashboard. Then:

```ts
import { createClient, runTurn } from "@astracollab/cogmem"

const memory = createClient({
  apiKey: process.env.COGNITIVE_MEMORY_KEY!,
  baseUrl: "http://localhost:3000"
})

// Before the model runs, and after it finishes.
const { context, learning } = await runTurn(
  memory,
  { userMessage, run: (ctx) => callYourModel(ctx, userMessage) },
  { domain: "database" }
)
```

`runTurn` builds the context block, runs your callback with it, learns from the
finished exchange, and records how the domain went — in that order, and without
letting a memory failure take down a turn that already succeeded.

## How a turn works

1. **Capture.** Deterministic patterns first: URLs, assignments, stated
   requirements. No model, no refusal, no silent loss.
2. **Reconcile.** Restatements are folded into what is held — but only when the
   merge keeps every distinctive token, or both entries are kept.
3. **File.** Into a tier. New facts land hot, so the next prompt already has them.
4. **Plan.** A gist line for everything; a full body only for identifiers the
   message named, unresolved contradictions, and weak domains.
5. **Inject.** Inside a token budget that reports when it truncated.

## Measured

`pnpm --filter cognitive-memory measure` on 200 stored memories:

| | |
| --- | --- |
| Recall p50 | 5.0 ms |
| Context build p50 | 2.9 ms |
| Index + triggers | 1,320 tokens |
| Every body | 3,643 tokens |

77% fewer tokens than injecting everything, with recall that does not depend on
a model being available.

## Credentials

Two kinds, deliberately separated.

- A **session** identifies a person. [Better Auth](https://better-auth.com) owns
  users, sessions and organisations, and is the only thing that can create an
  organisation or mint a key.
- An **API key** identifies an agent: `cmi_<env>_<id>_<secret>`, opaque, scoped,
  individually revocable, stored as a sha256 hash, shown once.

A leaked key therefore cannot mint a key, change its own scopes, or create an
organisation. Every read is filtered by organisation id in one auditable layer
(`src/server/services/memory-store.ts`).

## Stack

| | |
| --- | --- |
| Next.js 16 | App Router, route handlers, Turbopack |
| Effect 4 | Services, layers, typed error channel, `ManagedRuntime` at the HTTP boundary |
| Drizzle + better-sqlite3 | Schema, migrations, synchronous queries |
| Better Auth | Users, sessions, organisations |
| effect/ai | Optional model-backed extraction and reconciliation |

The server has no `await` in its domain logic: every service returns an `Effect`,
one `respond` helper maps a tagged error to a status, and route handlers are
ordinary `async` functions that await a `Response`.

## Scripts

```sh
pnpm --filter cognitive-memory dev            # dev server
pnpm --filter cognitive-memory test           # engine, auth, rules (37 tests)
pnpm --filter cognitive-memory typecheck
pnpm --filter cognitive-memory db:generate     # drizzle-kit generate
pnpm --filter cognitive-memory db:migrate      # apply migrations
pnpm --filter cognitive-memory auth:generate   # regenerate the Better Auth schema
pnpm --filter cognitive-memory measure         # the numbers above
pnpm --filter cognitive-memory smoke           # in-process smoke run
pnpm --filter cognitive-memory smoke:http      # 32 checks over real HTTP

pnpm --filter @astracollab/cogmem build   # SDK: ESM + CJS + .d.ts
pnpm --filter @astracollab/cogmem test
```

## Configuration

Every value is optional in development; see
[`.env.example`](apps/cognitive-memory/.env.example).

| Variable | Default | |
| --- | --- | --- |
| `COGNITIVE_MEMORY_DATABASE_PATH` | `.cognitive-memory/cognitive-memory.sqlite` | SQLite file |
| `COGNITIVE_MEMORY_MAX_TOTAL_TOKENS` | `2000` | Injection ceiling per prompt |
| `COGNITIVE_MEMORY_MAX_INDEX_ITEMS` | `60` | Index lines per prompt |
| `COGNITIVE_MEMORY_DEFAULT_RECALL_LIMIT` | `8` | Default results for a recall |
| `COGNITIVE_MEMORY_MODEL_API_KEY` | — | Enables model-backed extraction |
| `COGNITIVE_MEMORY_MODEL_BASE_URL` | OpenAI | Any OpenAI-compatible gateway |
| `COGNITIVE_MEMORY_MODEL_NAME` | `gpt-4o-mini` | |
| `BETTER_AUTH_SECRET` | dev fallback | **Required in production** |
| `BETTER_AUTH_URL` | `http://localhost:3000` | |

An unusable value is reported by `/api/v1/health` rather than thrown during
module load, which would take down `next build` instead of the one request that
needed the setting.

## Documentation

- Service reference: [/docs](apps/cognitive-memory/src/app/docs/page.tsx) — the
  model, tiers, capture rules, reconciliation, injection, recall, tensions,
  self-model, API surface and credentials.
- Engine commentary lives next to the code it explains; the reasoning behind each
  threshold is in the comment, because the numbers are only defensible with it.
