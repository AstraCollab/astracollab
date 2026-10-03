# @astracollab/ai

AstraCollab AI provider SDKs. Use `@astracollab/ai/cursor` for OpenAI-compatible **Cursor Composer 2.5** inference with the [Vercel AI SDK](https://sdk.vercel.ai/).

> **Not affiliated with Cursor.** This package is a typed HTTP + AI SDK client. It does not implement Cursor's internal protocol.

## Prerequisites

1. A [Cursor](https://cursor.com) subscription (plans from $20/month include API quota).
2. A Cursor API key from [Dashboard → Integrations → API Keys](https://cursor.com/dashboard/integrations) (`crsr_...`).
3. An **OpenAI-compatible inference base URL** you explicitly configure. Cursor does not publish a standard chat-completions API; community proxies (e.g. [Standard Agents](https://cursor-api.standardagents.ai/)) translate `/v1/chat/completions` requests. **You must opt in** by setting `baseURL` — this package never defaults to a third-party endpoint.

Install:

```bash
npm install @astracollab/ai @ai-sdk/openai-compatible ai
# peer deps for AI SDK provider helpers
```

## Quick start (Vercel AI SDK)

```ts
import { streamText } from "ai";
import {
  COMPOSER_25,
  CURSOR_STANDARD_AGENTS_V1_BASE_URL,
  createCursorProvider,
} from "@astracollab/ai/cursor";

const cursor = createCursorProvider({
  apiKey: process.env.CURSOR_API_KEY!,
  baseURL: process.env.CURSOR_API_BASE_URL ?? CURSOR_STANDARD_AGENTS_V1_BASE_URL,
});

const result = streamText({
  model: cursor.chatModel(COMPOSER_25),
  prompt: "Explain async iterators in TypeScript.",
});

for await (const delta of result.textStream) {
  process.stdout.write(delta);
}
```

Or use the convenience helper:

```ts
import { streamText } from "ai";
import { createComposerModel, resolveCursorConfigFromEnvOrThrow } from "@astracollab/ai/cursor";

const result = streamText({
  model: createComposerModel(resolveCursorConfigFromEnvOrThrow()),
  prompt: "Hello, Composer.",
});
```

## Environment variables

| Variable | Required | Description |
|---|---|---|
| `CURSOR_API_KEY` | Yes | Cursor API key (`crsr_...`) |
| `CURSOR_API_BASE_URL` | Yes | OpenAI-compatible base URL (no silent default) |

Example shell setup:

```bash
export CURSOR_API_KEY="crsr_..."
export CURSOR_API_BASE_URL="https://cursor-api.standardagents.ai/v1"
```

## Base URL configuration

This package exports documented constants for known community proxies — **examples only**:

```ts
import {
  CURSOR_STANDARD_AGENTS_V1_BASE_URL,       // generic chat completions
  CURSOR_STANDARD_AGENTS_OPENCODE_BASE_URL, // OpenCode tool-loop route
} from "@astracollab/ai/cursor";
```

| Route | Use when |
|---|---|
| `/v1` | Simple chat completions, OpenAI SDK, Vercel AI SDK |
| `/opencode/v1` | OpenCode-style local tool loops (proxy maps tool calls to OpenAI shape) |

Always set `baseURL` explicitly in code or via `CURSOR_API_BASE_URL`.

## Low-level HTTP client

```ts
import { createCursorClient, COMPOSER_25 } from "@astracollab/ai/cursor";

const client = createCursorClient({
  apiKey: process.env.CURSOR_API_KEY!,
  baseURL: process.env.CURSOR_API_BASE_URL!,
});

const completion = await client.chat.create({
  model: COMPOSER_25,
  messages: [{ role: "user", content: "hello world" }],
});

const models = await client.models.list();

const response = await client.responses.create({
  model: COMPOSER_25,
  input: "Explain async iterators.",
});
```

Errors throw `CursorApiError` with helpers: `isAuthError()`, `isRateLimitError()`, `isRetryable()`.

## Model reference (informational)

| Model | Input $/M | Output $/M | Context | Max output |
|---|---|---|---|---|
| `composer-2.5` | $0.50 | $2.50 | 200k | 65,536 |

Billing and quota apply to your Cursor account. See [Cursor model pricing](https://cursor.com/docs/models).

## OpenCode compatibility

Equivalent to the community OpenCode provider config, using this package's constants:

```json
{
  "model": "cursor/composer-2.5",
  "provider": {
    "cursor": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "Cursor API via Standard Agents",
      "options": {
        "baseURL": "https://cursor-api.standardagents.ai/opencode/v1",
        "apiKey": "{env:CURSOR_API_KEY}"
      },
      "models": {
        "composer-2.5": {
          "name": "Composer 2.5",
          "cost": { "input": 0.5, "output": 2.5 },
          "limit": { "context": 200000, "output": 65536 }
        }
      }
    }
  }
}
```

In TypeScript apps, prefer `createCursorProvider()` from `@astracollab/ai/cursor` instead of duplicating config.

## Legal and Terms of Service

Read [Cursor Terms of Service](https://cursor.com/terms-of-service) before using inference outside the Cursor IDE.

**Important considerations:**

- **§1.5 Use restrictions** — Cursor prohibits reverse engineering and unauthorized extraction from the Service. Third-party inference proxies operate in a **gray area**; this package does **not** ship proxy or reverse-engineering logic, only a client for **user-supplied** OpenAI-compatible endpoints.
- **§6 Third-Party Services** — Proxies like Standard Agents are third-party. You are responsible for their terms in addition to Cursor's.
- **§4.5 Usage billing** — Requests consume your Cursor subscription quota and any usage-based fees.
- **§1.5(v)** — Do not use outputs to train competitive models.

Monitor [Cursor API documentation](https://cursor.com/docs/api) for an official inference API. When Cursor publishes one, point `baseURL` at the official endpoint.

**Production use:** Community proxies may not be production-ready. [Standard Agents](https://cursor-api.standardagents.ai/) recommends contacting them for production deployments.

## Security

- Never commit `CURSOR_API_KEY` to source control.
- Use shell profiles, `.env` (gitignored), or your deployment provider's secret manager.
- Enable `debug: true` only in local development — it logs request URLs, not keys.

## Reasoning-content compatibility

Some AI/ML-compatible gateways — AIML among them — reject an assistant message
that carries a tool call unless that same message also carries a non-empty
`reasoning_content`:

```
reasoning_content is missing in assistant tool call message
```

That is a field-presence requirement, not a request for reasoning: the gateway
insists the field exists so its own bookkeeping round-trips, and will not tell you
what the model was thinking.

`@astracollab/ai/reasoning-compat` satisfies it with a blank placeholder, as AI SDK
language-model middleware — so it fixes the behaviour for every consumer at once
rather than forking the shim per framework.

```ts
import { wrapLanguageModel } from "ai";
import { createReasoningContentCompat } from "@astracollab/ai/reasoning-compat";

// Any model, any harness: Mastra, NAH, or a bare streamText call.
const model = wrapLanguageModel({
  model: baseModel,
  middleware: createReasoningContentCompat(),
});
```

Nothing else about the request changes, and **no reasoning is invented** — the
placeholder is blank on purpose. A fabricated chain of thought would be worse than
the error, because the next turn would condition on something that never happened.

**When it applies.** Only to models that need it (DeepSeek, Kimi K2.5/K2.6 by
default; `extraModels` adds more). The `THINKING` environment variable overrides
the default:

| `THINKING` | Effect |
|---|---|
| unset (default) | Injects only where the history already shows a thinking round-trip. A first turn is left alone. |
| `1`, `on`, `enabled`, … | Always injects on assistant tool-call messages. |
| `0`, `off`, `disabled`, … | Strips reasoning from assistant messages. |

Set `stripPlaceholdersOnly: true` to have the off-state drop only the injected
placeholders and keep reasoning the model actually produced — useful when thinking
is turned off mid-conversation, since that reasoning is still context.

### It heals itself too

The AI SDK types `doGenerate()` as taking no arguments, which reads as "middleware
cannot reissue this call with different parameters". It can. The call is bound to
a closure over the params object, and the object the middleware receives *is* that
object:

```js
const transformedParams = await doTransform({ params, type: "generate" });
const doGenerate = async () => await model.doGenerate(transformedParams);
return wrapGenerate({ doGenerate, params: transformedParams, model });
```

So when the gateway rejects the request anyway, the middleware injects the field
into `params` and re-sends. One retry, and a second failure propagates rather than
looping.

This matters less than it looks, because the preventive transform already rewrites
the **whole prompt, history included**. A conversation stored before the middleware
existed is fixed as it is sent, not as it is read — there is usually no stored data
to migrate. The retry covers the one case the transform cannot: a gateway whose
rule is stricter than the one modelled here. Set `healOnError: false` to turn it
off.

Verified against the v5 and v7 builds of `ai`, and exercised end to end in
`reasoning-compat.test.ts`, so an SDK release that copies the params instead of
aliasing them fails here rather than quietly starting a second request with the same
broken body.

The one path this does not cover is a request made **directly** against an
OpenAI-compatible `/chat/completions` endpoint, which bypasses the AI SDK
entirely — patch `reasoning_content` on the body yourself for those.

## Migrating messages off Mastra

`@astracollab/ai/mastra-messages` translates between Mastra's stored message shape
and the AI SDK's `ModelMessage[]`, so an agent loop can move without rewriting the
store or the loop.

> **Not the UI converter.** `@mastra/ai-sdk` already ships `toAISdkMessages`, and
> most codebases migrating off Mastra end up with both. They are not
> interchangeable: `UIMessage[]` is a **display** format and lossy by design — no
> thinking signature, no `source-document`, no data parts — while
> `ModelMessage[]` is what a model call takes, round-trips, and refuses to
> silently drop. Hydrate a chat pane with `toAISdkMessages`; feed an agent or a
> store with this package. Feeding an agent from `UIMessage[]` is the mistake
> worth naming: the turn runs with degraded reasoning and nothing reports it.

```ts
import { fromMastra, toMastra } from "@astracollab/ai/mastra-messages";

const messages = fromMastra(rows);          // MastraDBMessage[] -> ModelMessage[]
await store.save(toMastra(messages));       // and back
```

### Why a translation is not optional

**A tool call is one part in Mastra and two messages in the AI SDK.** Mastra stores
`{type:'tool-invocation', toolInvocation:{args, result}}` on the assistant message;
the AI SDK puts `tool-call` on the assistant message and the result on a following
`{role:'tool'}` message. **The message count changes**, so anything doing
`messages.slice(before)` needs to know that — in `not-another-harness`
that is `sessionUpdate`, which decides append-versus-replace for you.

**Mastra has seven part types; the AI SDK has equivalents for about three.**
`step-start`, `error`, `source-url`, `source-document` and data parts have no home
in a `ModelMessage`. Dropping them silently produces a transcript that reads
correctly and behaves worse every turn, so:

```ts
fromMastra(rows)                          // throws UnmappablePartError on one
fromMastra(rows, { onUnknownPart: "preserve" })  // keeps them, restores on the way back
```

Preserved parts are held under `providerOptions.astracollab.unmappedParts` with
their original index, so the round trip returns them in place.

**Provider data maps one-to-one.** Mastra's `providerMetadata` becomes the AI SDK's
`providerOptions`, which is how an Anthropic thinking signature survives. Verified
against `@mastra/pg`, which serialises the whole content object into one column
with no field projection — so nothing in `content.parts` is dropped in either
direction.

### Synthetic reasoning

A reasoning part that exists only to satisfy a provider's field requirement is
indistinguishable from real reasoning once persisted — both are `{type:'reasoning'}`
with a near-empty text. `fromMastra` recognises an injected part by a `synthetic`
marker on the Mastra side and carries it through under
`providerOptions.astracollab.synthetic`, so a reader can tell "the model thought
this" from "we put a blank here to get past a gateway error":

```ts
const isSynthetic = (part) => part.providerOptions?.astracollab?.synthetic === true;
```

Mark it when you write it — `synthetic: true` on the part — because once it is in
the database nothing else can add the provenance back.

### Legacy rows

`MastraMessageContentV2` still carries the pre-`format: 2` fields (`content`,
`reasoning`, `toolInvocations`) beside `parts`. Rows written before `format: 2`
have no `parts` at all, and a mapper that only reads `parts` returns an empty
transcript for them — which looks like data loss rather than a missing format
branch.

Three things about legacy rows fail silently, so all three are handled:

- **`content` is not always a string** — it can be an array of parts. Treating it
  as text alone returns nothing for those rows.
- **`toolInvocations` carry `result`.** Dropping it loses the entire tool half of
  the turn and writes `result: ""` back.
- **`providerMetadata` sits at the content level**, which is where an Anthropic
  thinking signature lives. It is carried onto the reasoning part.

Legacy rows are **upgraded, not preserved**: they come back as `format: 2` with
their content as parts. Keeping the old shape alive through a migration means
every future reader has to keep two code paths correct forever.

### Persisting through it — and the count that bites

`createMastraSessionStore` implements the four session methods over any Mastra
row source, and exists mainly to get one number right:

```
rows on disk: 3   mapped: 4   a turn adds 2   →  6 messages

before = 3 (rows)   → append(slice(3))  → re-appends 2 stored messages
before = 4 (mapped) → append(slice(4))  → appends only the 2 new ones
```

The mapper changes how many messages a set of rows becomes — one assistant row
carrying a tool call is two messages — so `before.length` taken from **rows**
duplicates history on every turn, silently. The store keeps the mapped array and
exposes it as `loadedCount`, which is the value to hand `sessionUpdate`:

```ts
const store = createMastraSessionStore({
  threadId,
  rows: { load, append, replace, reset },
  toMessage: (row) => row,
  idFor: (index) => `${sessionId}-${index}`,   // stable, or rows duplicate
});

await store.load();
const update = sessionUpdateFor(store.loadedCount, result);
await store[update.mode](update.messages);
```

Prefer `sessionUpdate` from `@astracollab/not-another-harness` when you have it;
`sessionUpdateFor` here is the same rule for callers that do not.

### Migrating the rows, so the mapper leaves the hot path

After the store holds AI SDK rows, `fromMastra` is no longer on any request path —
which is the point, because keeping both formats alive means a new part type only
gets fixed in one of them.

```ts
const { batches, report } = planRowMigration(rows);
console.log(report);  // read this before writing: droppedMessages > 0 means a row was unread
for (const [index, batch] of batches.entries()) await upsert(batch);
```

- **Ids are stable** (`{sourceId}`, `{sourceId}-1` by default), so re-running
  upserts rather than duplicating.
- **Already-migrated rows are detected by shape**, not by a flag — no column to
  add and no backfill to half-do. Re-running is a no-op.
- **Preserved parts ride along** under `providerOptions.astracollab.unmappedParts`.
- **Unreadable rows are counted, not dropped.** `report.droppedMessages` is the
  number to look at before you rewrite a table.

### The round-trip gate

`round-trip.test.ts` asserts `Mastra → ModelMessage → Mastra` returns what it was
given — reasoning text, `providerMetadata`, tool arguments and part order — across
fixtures for **all seven** Mastra part types, a signature-bearing reasoning part,
a synthetic placeholder, a legacy row, and a multi-turn conversation including
idempotency. A gate that cannot fail is decoration, so each assertion was
verified to fail when the behaviour it guards is broken.

## Package exports

| Import | Description |
|---|---|
| `@astracollab/ai` | Shared types; future provider umbrella |
| `@astracollab/ai/cursor` | Cursor inference client + AI SDK provider |
| `@astracollab/ai/reasoning-compat` | Gateway reasoning-content middleware |
| `@astracollab/ai/mastra-messages` | Mastra ↔ AI SDK message translation |

## License

MIT — see [LICENSE.md](./LICENSE.md).
