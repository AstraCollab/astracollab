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

## Package exports

| Import | Description |
|---|---|
| `@astracollab/ai` | Shared types; future provider umbrella |
| `@astracollab/ai/cursor` | Cursor inference client + AI SDK provider |

## License

MIT — see [LICENSE.md](./LICENSE.md).
