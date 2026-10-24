# nah-js

A template for building an agent into your own application. `nah-js` is the Web half of [`not-another-harness`](../not-another-harness): the part that turns an agent into something a person can actually use in a browser — a conversation that is still there after a refresh, an answer that arrives while it is being written, and a run that stops to ask a question and carries on where it left off.

The agent stays yours. The model, the tools, the system prompt, the budget — you choose them, per conversation, in the code you already have. What this package takes off your plate is everything around the agent: keeping the conversation between requests, streaming what happens to the page, and making a run that paused resumable.

There is no framework to adopt. Use the request handler in your own route, or mount agents, tools, and workflows on an existing server with the server adapter. It runs wherever your app runs: Next.js, Hono, Remix, SvelteKit, Astro, a Worker, Deno, Bun, Node.

## Install

```sh
npm install nah-js not-another-harness ai zod
```

`nah-js` is a second name for the runtime the SDK ships, so you install both: `nah-js` if you prefer the short import, `not-another-harness` because this package needs it as a peer. `ai` and `zod` are the SDK's own peers.

The runtime ships in `not-another-harness@0.0.1-beta.10` and `nah-js@0.0.1-beta.10`; until those are on npm, install it from a workspace checkout.

## Quickstart

**Server** — one route file:

```ts
// app/api/nah/route.ts — Next.js
import { createNahHandler } from "nah-js";
import { anthropic } from "@ai-sdk/anthropic";

export const runtime = "nodejs";
export const maxDuration = 300;

export const { GET, POST } = createNahHandler({
  agent: () => ({
    model: anthropic("claude-sonnet-4-5"),
    system: "You are a helpful assistant.",
    tools: {},
  }),
});
```

**Browser** — one hook:

```tsx
"use client";
import { useNahChat } from "nah-js/client";

export function Chat() {
  const chat = useNahChat();

  return (
    <div>
      {chat.messages.map((message) => (
        <p key={message.id}>
          <strong>{message.role}:</strong> {message.text}
        </p>
      ))}

      {chat.pendingApprovals.map((approval) => (
        <button
          key={approval.approvalId}
          onClick={() => chat.approve(approval.approvalId, true)}
        >
          Run {approval.toolName}
        </button>
      ))}

      <button onClick={() => chat.send("hello")}>Send</button>
    </div>
  );
}
```

`nah-js/client` is a separate entry point, so React never ends up in a server bundle.

The handler hands you two routes:

| Route | Method | What it does |
| --- | --- | --- |
| `/api/nah` | `POST` | Runs a turn, or steers or stops a run that is already going. Answers with a stream of events. |
| `/api/nah?sessionId=…&after=…` | `GET` | Sends back the events a client missed, then keeps going live. |

## What happens in a turn

1. The browser sends a message.
2. This package loads the conversation, asks your code for the agent, and starts the run.
3. Everything the agent does becomes an event and goes out to the page straight away — the user reads the answer as it is written, not after it is finished.
4. The conversation is saved before the response ends, so the next message always lands on top of a conversation that is already there.
5. The stream ends with `finish`. If the agent was waiting for something — a yes/no on a tool, a value it needs — that is in the last frame.

## Your agent

The `agent` function is where you decide what the agent is. It runs once per turn, after the conversation is loaded, so the model, the tools or the system prompt can be different for every conversation — and so the tools can be built for the project that conversation is about.

```ts
createNahHandler({
  agent: async ({ sessionId, messages, signal }) => ({
    model: anthropic("claude-sonnet-4-5"),
    system: await systemPromptFor(sessionId),
    tools: toolsFor(await workspaceFor(sessionId)),
    maxSteps: 32,
    maxSpendUsd: 2,
  }),
});
```

It gets three things:

| Field | What it is |
| --- | --- |
| `sessionId` | Which conversation this is. |
| `messages` | The conversation so far, including anything a previous turn was waiting for. |
| `signal` | Fires when the user closes the tab or stops the run. |

It returns the SDK's own options, minus three the runtime handles for you: `messages`, `prompt` and `abortSignal`. Those are the three you cannot get wrong by accident — a conversation that is not the saved one loses history, a prompt that is not the user's message asks the model a question nobody typed, and a signal that is not the request's keeps spending tokens on an answer nobody will read.

So the basics are `model`, `system` and `tools`, plus whatever the SDK offers: `maxSteps`, `maxSpendUsd`, `rates`, `maxContextTokens`, `maxOutputTokens`, `compaction`, `compactAtTokens`, `wrapUpOnLimit` and the rest. The [SDK guide](../not-another-harness/README.md) has the full list.

## Options

| Option | What it does |
| --- | --- |
| `agent` | **Required.** Builds your agent. Called once per turn. |
| `session` | Where conversations are kept between requests. Defaults to memory. |
| `events` | Where events are recorded, so a dropped connection can pick up where it left off. Defaults to memory. |
| `after` | A place to hand off work that should keep going after the response ends — Next.js's `after` fits here. |
| `onTurnFinish` | Called when a turn ends. Handy for logging. |
| `headers` | Extra headers on every response. |
| `heartbeatMs` | How often to send a keep-alive on the stream, in ms. `0` turns it off. |
| `maxBodyBytes` | The largest request body accepted. Default 1 MiB. |

### `after`

```ts
// Next.js: work that should outlive the response.
import { after } from "next/server";

export const { GET, POST } = createNahHandler({
  agent: () => ({ model, system, tools }),
  after,
});
```

`after` is optional. This package uses it for the tidying-up it does once a turn is over, and does that work inline when it is not there — a Next.js `after` throws when it is called outside the request scope, and a turn can finish after the response has already been sent.

### `memory`

**Opt-in.** When you pass `memory`, the runtime injects the memory block into the system prompt before the run and learns from the exchange after it finishes. When you do not, memory is off and the turn runs as it always would.

```ts
import { createNahHandler } from "nah-js";
import { CognitiveMemory } from "not-another-harness";

export const { GET, POST } = createNahHandler({
  agent: () => ({ model, system, tools }),
  memory: {
    memory: new CognitiveMemory(),
    key: "session-123",
    stateStore: {
      load: (key) => db.load(key),
      save: (key, snapshot) => db.save(key, snapshot),
    },
  },
});
```

The framework does not pick a memory back-end. `memory.memory` is a `NahMemory` — an interface with four methods:

| Method | What it does |
| --- | --- |
| `getPromptContext(userMessage?)` | Builds the prompt block for a turn. Sync or async — both are first-class. |
| `postTurnAsync({ userMessage, assistantResponse })` | Learns from a finished exchange. Optional: recall-only deployments omit it. |
| `getSnapshot()` | Serialises the engine's full state. Optional. |
| `loadSnapshot(snapshot)` | Restores a serialised snapshot. Optional. |

The shipped default wires in CognitiveMemory from `cogmemory`. To use a vector database, Mastra, or any other back-end, implement `NahMemory` and pass it — the runtime calls the same hooks either way, and nothing else in the framework changes.

`stateStore` is where the engine's state lives between turns. `key` identifies the state — per chat, or per caller depending on what should be shared. `onError` reports failures on read, write or learn rather than failing the turn.

## The browser side

```tsx
const chat = useNahChat({ api: "/api/nah", sessionId });
```

| Option | What it does |
| --- | --- |
| `api` | Where messages are sent. Default `/api/nah`. |
| `sessionId` | Which conversation to use. One is generated per mount, so two components on a page are two conversations; pass an id to share one. |
| `onFrame` | Called for every event, if you want your own view of the run. |

| Field | What it is |
| --- | --- |
| `messages` | The conversation so far, as `{ id, role, text }`. |
| `status` | `"idle"`, `"submitted"`, `"streaming"` or `"error"`. |
| `error` | What went wrong, if something did. |
| `pendingApprovals` | Tool calls waiting for a yes/no from the user. |
| `pendingSuspensions` | Tool calls waiting for a value. |
| `send(text)` | Sends a message. Starts a turn. |
| `approve(approvalId, approved, reason?)` | Answers a held call. Picks the run back up. |
| `answer(toolCallId, value)` | Answers a parked call. Picks the run back up. |
| `stop()` | Stops the run that is going. |
| `reset()` | Clears the conversation and anything it was waiting for. |

The hook keeps the conversation, the pending questions and the status. What the page looks like is up to you.

## When the agent needs you

**This is the one thing that shapes everything else.**

An agent that has to ask a person something — should I run this command? what should this file be called? — cannot finish on its own. The SDK ends the run in one of two ways: `awaiting-approval`, when a tool needs a yes/no, and `suspended`, when a tool ran and decided it needed a value. Neither is a failure. The run is paused, mid-thought, with the question waiting for an answer.

So the answer comes back on the next request. The conversation was saved, the pending question travels with it, and the run continues where it stopped. The browser shows the question, the user answers, and the agent carries on.

One rule worth knowing: **a question and a new message cannot travel together.** The SDK reads an answer from the last thing in the conversation, so a request carrying both would push the answer out of the place it is read from — the approval would be ignored, the tool would never run, and the run would report success having done nothing. That is why `send` and `approve` are separate calls, and why a request that tries to do both is refused.

## What the browser sees

Every event goes out as a small JSON object with a `type`, a `seq`, a `sessionId` and a `runId`:

```
id: 12
event: text-delta
data: {"type":"text-delta","seq":12,"sessionId":"…","runId":"…","at":1730000000000,"step":1,"text":"Hello"}
```

`id` is the running number, so a browser that loses its connection can ask for everything after the last one it saw and get it. `event` is the type, so the page can react to each kind of event by name. An event this package does not know about is skipped rather than breaking the stream.

| Event | What it means |
| --- | --- |
| `turn-start` | The request arrived and the run is about to start. |
| `run-start` | The agent started. |
| `step-start` / `step-finish` | A step began; a step ended, with what it cost. |
| `text-delta` | A piece of the answer. |
| `tool-call` | The agent called a tool. |
| `tool-result` | The tool ran. |
| `tool-approval-request` | The agent is waiting for a yes/no. The tool has **not** run. |
| `tool-approval-response` | The question was answered. |
| `tool-suspended` | A tool ran and is waiting for a value. |
| `tool-resumed` | The value arrived and the tool ran again. |
| `compacted` | The conversation was shortened to keep it inside the model's window. |
| `wrap-up` | The run is wrapping up on purpose, not because it broke. |
| `user-message` | A message was steered into a run that was already going. |
| `finish` | The run ended. Includes anything it is still waiting for. |
| `error` | The run failed. Carries a name and a short message. |
| `ping` | A keep-alive, so an idle connection is not dropped. |

The events are typed in the SDK and exported from the package root, so `switch (event.type)` narrows for you.

## Keeping the conversation

Two things you plug in, and both of them are about what has to outlive a request:

- **`session`** — where the conversation is kept. Three methods: `load`, `append` and `replace`. `replace` is there because shortening a conversation *is* replacing it, and a store that cannot do that has to keep everything or lose it.
- **`events`** — where events are recorded, so a dropped connection can be caught up. It is separate from the conversation because the two have different lifetimes: the conversation is the thing, the event log is a record of what was said about it.

```ts
import type { NahSessionStore } from "nah-js";

const session: NahSessionStore = {
  async load(sessionId) {
    return (await db.transcript.find(sessionId)) ?? [];
  },
  async append(sessionId, messages) {
    await db.transcript.append(sessionId, messages);
  },
  async replace(sessionId, messages) {
    await db.transcript.write(sessionId, messages);
  },
};
```

Both default to keeping things in memory, which is right for one long-lived Node server and wrong for everything else. On a serverless platform each request can land on a different instance, and the second instance finds an empty conversation.

## Where it runs

The core speaks the Web platform's request and response objects, so the same runtime mounts in:

- **Next.js** — a route handler, as above.
- **Hono, Remix, SvelteKit, Astro** — an endpoint that receives a `Request` and returns a `Response`.
- **Cloudflare Workers, Deno, Bun, Node** — the same, with the store you have.

## Server adapter

`createNahServer` mounts a registry of agents, explicitly exposed tools, and workflows at an API prefix. It does not start a server: the app owns its listener and deployment. The adapter uses the Web `Request` → `Response` contract, so it mounts directly in Next.js and Hono and can be wrapped by adapters for Node-style frameworks.

```ts
import { createNahServer } from "nah-js";

const server = createNahServer({
  agents: {
    support: {
      agent: ({ requestContext }) => ({
        model,
        system: `Support user ${(requestContext as { userId: string }).userId}`,
        tools: supportTools,
      }),
      session: databaseSessionStore,
      events: databaseEventLog,
    },
  },
  tools: {
    lookupOrder: {
      description: "Look up an order for the signed-in user",
      inputSchema: lookupOrderSchema,
      execute: (input, { context, signal }) => lookupOrder(input, context, signal),
    },
  },
  workflows: { refundReview },
  authenticate: async (request) => {
    const user = await verifySession(request);
    if (!user) return new Response("Unauthorized", { status: 401 });
    return { userId: user.id, tenantId: user.tenantId };
  },
});
```

When configured, the authentication callback runs for every mounted API request. Its returned value is trusted context: agent factories receive `requestContext`, direct tool handlers receive `context`, and workflow steps can read it at `context.requestContext`. Do not derive identity from untrusted JSON supplied by the caller.

| Route | Behavior |
| --- | --- |
| `POST /api/agents/:agentId` | Start a turn, answer an approval or suspended tool, steer, or abort; streams NAH events. |
| `GET /api/agents/:agentId?sessionId=…&after=…` | Replay missed frames, then follow the session stream. |
| `POST /api/tools/:toolId/execute` | Validate input and execute a tool explicitly registered for direct access. |
| `POST /api/workflows/:workflowId/runs` | Run a workflow with `{ input, context }`; returns its result as JSON. |
| `GET /api/openapi.json` | Return an OpenAPI 3.1 description of the registry. |

```ts
// Hono
app.all("/api/*", (context) => server.handle(context.req.raw));

// Next.js App Router catch-all route
export const runtime = "nodejs";
export const GET = (request: Request) => server.handle(request);
export const POST = (request: Request) => server.handle(request);
```

The adapter does not add a listener, authentication provider, database, or deployment platform. Agent sessions and event logs have the same in-memory defaults as `createNahHandler`; configure shared persistent stores for serverless or multi-instance apps. Workflow runs execute in-process and are not durable across restarts.

## Before you ship

- Save the conversation **before** the response ends. A user who sends their next message the moment they see `finish` must find the conversation already saved. This package does that; a store of your own should too.
- Closing the tab stops the run. The browser's own signal is the run's signal, so nobody pays for an answer nobody will read.
- The follow stream ends when the turn it is following ends. A client that wants the next turn reconnects, which a browser's `EventSource` does on its own.
- Errors reach the browser as a name and a short message. A stack trace, or a provider message with a key in it, stays on the server where the logs are.
- A body over `maxBodyBytes` is refused with `413` before it is read into memory.

## API

| Export | What it is |
| --- | --- |
| `createNahServer(options)` | Mount registered agents, direct tools, and workflows on a Web API server. |
| `createNahHandler(options)` | The two route handlers. |
| `createNahRuntime(options)` | The runtime on its own, if you are not using a route file. |
| `createMemorySessionStore()` | The default place conversations are kept. |
| `createMemoryEventLog(options?)` | The default event log. |
| `createSessionId()` / `createRunId()` | Fresh identifiers. |
| `createEventStreamResponse(frames, options?)` | Turns a stream of events into a response. |
| `encodeFrame` / `decodeFrames` / `encodeComment` | The event-stream format, for a client of your own. |
| `parseEventStream` | Reads that format in the browser. |
| `SSE_HEADERS` | The headers a streamed response needs. |

Types: `NahHandlerOptions`, `NahRouteHandlers`, `NahRuntime`, `NahRuntimeOptions`, `NahAgentContext`, `NahAgentFactory`, `NahAgentSpec`, `NahTurnSummary`, `NahSessionStore`, `NahEventLog`, `NahFrame`, `NahEvent`, `NahTurnRequest`, `NahActionRequest`, `NahActionResponse`, `NahPostRequest`, `NahError`.

## Development

```sh
pnpm --filter nah-js test
pnpm --filter nah-js lint
pnpm --filter nah-js build
pnpm --filter nah-js verify:install
```

`verify:install` packs this package and the SDK, installs both tarballs into a clean project, and imports every entry point in both module systems — the check that the published artifact actually installs.

## License

MIT
