# Plan: hosting the `nah` runtime off-box on Boat, with the TUI as a thin client

> **Renamed.** This file used to be `hosted-runtime-on-durable-objects.md`, which
> misdescribed it: Durable Objects are §4's *optional* second transport, not the
> recommendation. The recommendation is Tier C on Boat (§1.1).

> **Superseded in part.** See
> [`cloud-studio-telemetry-and-billing.md`](./cloud-studio-telemetry-and-billing.md) for
> the hosted Studio, the telemetry data policy, and metered cloud agents. That document
> changes two things here: the keyless relay deferred in §3.4 is **v1, not v2**, and the
> Durable Object demoted in §4 is **back in** — because a metered session needs durable,
> authoritative state for billing (§5 there).

> **Status:** researched, and the two load-bearing questions are now settled. Provider is
> **Boat**, not Durable Objects (§1.1): it already provides a full Linux sandbox, a
> filesystem API with path jailing, and a documented pattern for running your own agent
> daemon inside the VM. The harness is **ours** (§7): a hosted session runs the `nah`
> harness and never Boat's preinstalled agents, so the DO's event stream is a Phase 5
> control-plane path rather than the agent transport. Durable Objects are demoted to an
> optional second transport for the same protocol (§4, Phase 8). The parts that are
> ours either way — the wire protocol and the TUI client — come first, and are Phase 1.

## 0. What exists today (grounded)

| Thing | Where | Note |
| --- | --- | --- |
| `nah serve` | `packages/nah/src/args.ts:155` → `packages/nah/src/cli.ts:55` | **Already taken.** It is an alias for `/studio` — it starts the dashboard. It is not a runtime host. |
| `--sandbox` | `packages/nah/src/args.ts:142` | Runs the agent loop *locally* against a **Blaxel** sandbox. A remote `ToolEnvironment`, but a local loop. |
| Agent loop | `packages/not-another-harness/src/agent.ts`, `packages/agents/src/coding-agent.ts` | `createCodingAgentRun` returns a `HarnessRun`. |
| Event stream | `not-another-harness/src/types.ts:179` | `HarnessEvent` union. This is the whole UI contract. |
| Tool port | `not-another-harness/src/types.ts:284` | `ToolEnvironment` — `readFile`/`writeFile`/`deleteFile`/`exists`/`readdir`/`grep`/`glob`/`exec` + optional `snapshot`/`restoreSnapshot`. |
| Run handle | `not-another-harness/src/types.ts:753` | `HarnessRun` = `events: AsyncIterable<HarnessEvent>`, `result`, `steer()`, `followUp()`, `interrupt()`, `pending()`. |
| Provider-neutral sandbox SDK | `packages/agent-sandbox/packages/agent-sandbox/` | `SandboxRuntime` (`types.ts:2`), `RepoSandboxFs` (`sandbox-fs/repo-fs-port.ts:12`), and a **NAH adapter** already written: `createNahToolEnvironment` (`adapters/nah/index.ts:65`). |
| `cloudflare` | `agent-sandbox/src/types.ts:19` | Already a member of the `ProviderName` union. **Nothing implements it.** No Workers/wrangler code anywhere in the repo. |

**The load-bearing observation:** the TUI does not talk to a process. It consumes an
`AsyncIterable<HarnessEvent>` and calls `steer`/`interrupt`. A remote runtime that can
produce that exact stream and accept those exact three calls is already a drop-in
replacement for the in-process loop. Almost all of the "host it in the cloud" work is
transport, not redesign.

---

## 1. The constraint that shapes the whole plan

**A Cloudflare Durable Object cannot execute shell commands, and cannot hold a repo.**

- Workers have no `child_process` and no real filesystem. `nodejs_compat` gives you
  streams, crypto, fetch — not `exec`, not `git`, not `pnpm`.
- DO key-value storage is a KV store with per-value and per-object size caps. A git
  working tree does not fit, and DO storage is not a POSIX mount anyway.
- The Free plan's per-request wall-clock limit makes a multi-step agent run
  infeasible. This needs the **Paid** plan and a **WebSocket held open** for the run
  duration. (Confirm the current Paid duration/CPU numbers at build time — they change.)

So the honest architecture is **not** "agents run inside a Durable Object". It is:

> **Durable Objects are the durable, addressable *session*: identity, transcript,
> run state, event replay, and the WebSocket the TUI talks to. The compute is a
> sandbox the DO points at.**

That split is good, not a compromise. It is the same split the repo already made with
`SandboxRuntime` + `RepoSandboxFs`, and the "provider-neutral" README was written for
exactly this.

### Three deployable tiers

```
Tier A — control plane only        DO runs nothing but state + WebSocket.
                                   Tools proxy to any external SandboxRuntime
                                   (Blaxel today, Fly/Modal/E2B tomorrow).
                                   ✅ Works with zero new infrastructure.
                                   ✅ Best first milestone.

Tier B — loop in the Worker       The DO (or a plain Worker) runs `runAgent`
   + external sandbox             itself. Model streaming over SSE works fine
                                   in Workers. Tool calls RPC out to a sandbox.
                                   ✅ Durable sessions, resumable, key custody server-side.

Tier C — loop next to the code    DO holds a Cloudflare **Container** (or a node
                                   process you already run). The agent loop, git,
                                   build and exec all run inside the sandbox; the DO
                                   is a thin durable session + event broker.
                                   ✅ Full local-dev fidelity. Needs Paid + Containers.
```

Tier C is contingent on Cloudflare Containers being available/acceptable for this
account. Treat that as a spike, not a plan dependency.

**How to read the tiers after reading §1.1 below:** the tiers above describe where the
*runtime* lives. They are orthogonal to *who provides the sandbox*. §1.1 adds a
provider that already implements every tier's compute half, including Tier C, today.

---

## 1.1 boat.dev — a sandbox provider that already does most of this

Researched 2026-10-03 (see "Sources"). `boat.dev` is a YC-backed product from ASCII
(`ascii.dev`): **persistent Linux VMs** for agents. SSH/SCP, Docker inside, a dedicated
IPv4/IPv6 per machine, a 60fps browser desktop, and disk-level fork from a snapshot.

### What it gives us, mapped to contracts we already have

| Boat | Our contract | Fit |
| --- | --- | --- |
| `POST /sandboxes/{id}/commands` — sync (600s cap), `detached` → poll, or `stream: true` → NDJSON `stdout`/`stderr`/`exit` | `SandboxRuntime.executeCommand` (`agent-sandbox/src/types.ts:2`) | **Direct.** Streaming NDJSON is what `ToolEnvironment.exec` wants. |
| `GET`/`PUT /files`, path already canonicalized and **rejected outside `/home/user` or `/tmp`** with `400 invalid_path` | `RepoSandboxFs` (`sandbox-fs/repo-fs-port.ts:12`) | **Better than ours.** The path-jail I flagged as a top risk in §6 is already enforced server-side, for every file op, for free. |
| `GET /events` — long-poll, cursor + `sort=asc`, `conversation` filter, streaming partials via `data.is_streaming`, tool calls in `data.tools` | lifecycle for the Studio; **not** the agent stream (§7) | **Control plane only.** Its payloads are *their* agents' output, and we run ours, so this feeds the dashboard in Phase 5 — not `HarnessEvent`. |
| `POST /steer`, `POST /interrupt` (scoped to one `conversation`) | `HarnessRun.steer()` / `.interrupt()` | **1:1** for their agents. For ours, steer/interrupt ride our own protocol over the daemon socket. |
| `stop` = snapshot + pause billing; `resume`; `fork` off a template in seconds at constant cost | `snapshotToS3` / `restoreFromS3` (`helpers/snapshot.ts`) | **Replaces it.** Stop/resume is cheaper and more correct than tar-to-R2. |
| `host <port> --private` → stable HTTPS URL gated by a `_token` | the runtime daemon in Tier C | **Direct.** |
| Webhooks (signed) for ready / restored / error / archived | lifecycle in §4.1 | Direct. |
| `@boatdev/sdk` (TypeScript) + `boat --json` for JSONL | — | Use the SDK. |

### The important find: the daemon pattern

Boat's platform guide documents "Bring your own harness: **the daemon pattern**" —
scp a binary in, run it as an **always-on systemd service** so it survives
stop/resume/fork, `host <port> --private` to expose it, then drive it over HTTPS.

That is **Tier C, already designed, documented, and supported by someone else.** It
turns the most expensive and riskiest phase of this plan (Phase 7) into a
`systemd` unit. It also means the agent loop runs *next to the filesystem*, so `git`,
`pnpm`, `tsc` and `bash` are all local and fast — no RPC per tool call.

### What it changes

1. **The DO becomes optional, not foundational.** It was solving "durable session +
   event log + reconnect". Boat's `/events` cursor log, webhooks and snapshots already
   do that. Keep the DO plan for when you need your own control plane, your own key
   custody, or your own per-tenant billing — not for v1.
2. **The `nah-runtime` protocol must be transport-agnostic.** This is the one real
   correction to §2. Boat's event stream is **cursor long-poll over HTTP**, not a
   WebSocket. `createRemoteRun` therefore takes a `Transport`, not a socket, and needs
   two implementations: `WsTransport` (own DO / daemon) and `PollTransport` (Boat's
   `/events`). Design that in from the start; retrofitting it is a rewrite of the
   client.
3. **It invalidates the Phase 0 pricing spike.** §1 already guessed the DO control
   plane would be the cheap part. It isn't — the compute is, and Boat undercuts
   everyone: **$20/mo = ~555 hours of 4vCPU/8GB** (`$0.00001`/s), ~$26/mo for a
   sandbox that never sleeps. Boat's own comparison puts it at ~$131/mo against
   Cloudflare $422, Modal $440, E2B $907, Daytona $912 on a 1,000-run benchmark.

### Caveats worth knowing before committing

- **EU-only regions today** (Germany, Finland, France). Data stays there. For a
  dev tool used from Nairobi or the US that is a real latency and residency question.
- **Boat ships its own agents** — Claude Code, Codex, OpenCode, Prime, Kimi, and `pi`.
  `pi` is **not** this project (confirmed 2026-10-03); the repo only borrows its
  system-prompt style, which makes it a useful reference implementation to read, not a
  dependency. A hosted session runs **our** harness (§7), so we never wrap or call
  theirs — the consequence is that we skip six integrations we would otherwise have
  had for free, and must be good enough on our own to justify the VM.
- The 600s command cap bounds a single `exec`; the agent loop is not bounded that way
  (it is a systemd service), so this is a non-issue for Tier C and a real one for Tier A.
- Concurrency is plan-gated: 100 → 2,000 sandboxes.

### The honest recommendation

**Drop the DO from v1.** Ship Tier C on Boat: `boat new` → install the `nah` daemon →
`host --private` → TUI connects. Add `"boat"` to `ProviderName` and ship
`createBoatEnvironment` next to the existing `createBlaxelEnvironment`
(`packages/nah/src/sandbox.ts:56`) as the first provider that is a *real Linux machine*
rather than a container API. Keep §2's protocol and §3's TUI work — that is the part
that is ours regardless of provider, and the part that makes swapping Blaxel → Boat →
a future DO trivial.

---

### 1.2 The wire contract, verified against the spec

Re-verified 2026-10-03 against the **full OpenAPI document**
(`https://docs.boat.dev/openapi/boat-v1.yaml` — 210 KB; fetched whole rather than page
by page, so this is the schemas and not a doc summary). Base URL
`https://boat.dev/api/v1`, bearer auth. Five operations carry the whole design.

| Call | Shape that matters |
| --- | --- |
| `POST /sandboxes` | `202` immediately, `state: provisioning`. Body: `type` (`small` = ½ rate, `large` = 2×; fork/resume can move a sandbox between sizes), `ttlSeconds` (default `3600`, `null` = never auto-stop), `noEnv`, `snapshots` (default `true`), `failFast`, `setupScript`, `env`, `environment`. |
| `POST /sandboxes/{id}/commands` | `command`, `cwd`, `timeoutSeconds` (1–600, default 30), `detached`, `stream`. |
| `GET /sandboxes/{id}/commands/{processId}` | `status: running \| exited \| **lost**`, `running`, `exitCode`, `oomKilled`, log tails, `tailBytes` cap (default 8 MiB). |
| `GET`/`PUT /sandboxes/{id}/files` | Canonicalizes and rejects anything outside the jail with `400 invalid_path`. |
| `GET /sandboxes/{id}/events` | Long-poll with `cursor` + `sort=asc`, plus `limit`, `type` and `conversation` filters. |

**Four facts that change the client, and which §1.1 got wrong or missed entirely:**

1. **`failFast: true` answers in ~1.5 s** — either the usual `202`, or `503
   no_ready_machine` with *nothing created, billed, or counted against start limits*.
   This is the whole "point the TUI at compute" UX: when there is no capacity, say so in
   a millisecond instead of hanging on an unbounded create. Phase 2 should send
   `failFast`, surface `no_ready_machine` as a first-class state, and preflight with
   `GET /limits` (machine starts left, compute seconds, credits, concurrent capacity).
2. **`Idempotency-Key` on `create` and `fork`** — retry a lost response without creating a
   second billable sandbox. Any create path we wrap must propagate the key; otherwise a
   flaky network charges the user twice for one sandbox.
3. **Exec is never auto-retried, and the errors are typed with `retryable`.** The exact
   states the TUI has to render:
   - `409 boat_starting` — right after a `resume`; the call already waits up to 60 s, so
     this is the *rare* case. `retryable: true`.
   - `409 sandbox_not_ready` — `retryable: false`, and it carries the `state` at once.
     Stop or resume first; do not retry.
   - `502 boat_direct_failed` — **the command may already be running.** Not retryable.
     Re-running it is the one thing that can double-apply a side effect, so no generic
     retry wrapper may ever blind-retry this.
   - `400 invalid_timeout` — only when `timeoutSeconds` is not an integer in 1–600.
   - `oomKilled` — a real memory ceiling kills commands. A failure state to render, not
     an empty result.
4. **`stream: true` is an NDJSON frame contract, and `error.retryable` is precise.**
   Frames are `started` → N × `stdout`/`stderr` → exactly one `exit` (the sync result
   minus the output) or `error`. `error.retryable: true` means *provably never ran* — the
   sandbox was still restoring its disk — so resending is safe. That is a materially
   different guarantee from the `502` above; `SandboxRuntime.executeCommand` must honour
   the distinction rather than collapsing both into "retry".

**And one that simplifies Phase 4:** `setupScript` (≤64 KiB) runs on the sandbox after
it is ready, and "ready" means ready to accept the user — the script runs *before* that.
So the template no longer needs an scp-then-systemd dance from outside: create with a
`setupScript` that fetches the binary, writes the unit and starts it. Keep scp as the
fallback for an image you cannot rebuild.

**Also confirmed for §3.4:** `noEnv: true` confines the sandbox so it cannot act on the
account or on other sandboxes, and *a fork of a no-env sandbox is always no-env* — so the
per-fork `env` invariant holds transitively, which is what makes the template safe to
fork. SSH, SCP, desktop, snapshots and public URLs all still work under `noEnv`.
`snapshots: false` is the cheaper ephemeral mode, at the cost of resume, fork and named
snapshots. Credentials for Phase 6 are first-class: `POST /api-keys/scoped`, plus
`rotateApiKey` and `apiKeyUsage` — use a scoped, rotatable key, not the account key.

## 2. Freeze two contracts before writing any transport

Everything else is an implementation of these. Get them right and the rest is plumbing.

### 2.1 `nah-runtime` protocol package (new)

`packages/nah-runtime/` — **zero dependencies on `nah` and on the harness** beyond
`types`. Shared by the client (in `nah`) and the server (in the Worker). This is the
same "structural types, no compile-time dep" rule the Blaxel sandbox follows
(`packages/nah/src/sandbox.ts:3-6`).

```ts
// Client → Server
type ClientFrame =
  | { t: "hello"; protocol: 1; sessionId: string; token: string; resumeFrom?: number }
  | { t: "prompt"; text: string; model?: string; permissions?: string }
  | { t: "steer"; text: string }
  | { t: "follow-up"; text: string }
  | { t: "interrupt" }
  | { t: "approval"; toolCallId: string; approved: boolean; remember?: "session" | "always" }
  | { t: "tool-result"; toolCallId: string; output: string; isError: boolean } // Tier A only
  | { t: "ping" };

// Server → Client
type ServerFrame =
  | { t: "ready"; session: SessionMeta; replayed: number }
  | { t: "event"; seq: number; event: HarnessEvent }   // seq is monotonic & durable
  | { t: "request-approval"; toolCallId: string; toolName: string; input: unknown }
  | { t: "result"; reason: string; text: string; usage: unknown }
  | { t: "error"; code: string; message: string; retryable: boolean }
  | { t: "pong" };
```

Rules that make this survive a terminal reconnect:

1. **Every event carries a monotonic `seq`.** The server appends to DO storage inside
   the same window that emits it. A reconnecting TUI sends `resumeFrom: lastSeq` and the
   server replays the tail. The TUI must treat replay as the normal case, not an error.
2. **`HarnessEvent` is already JSON-safe** (every field is a string/number/boolean/array
   — `error: unknown` needs a sanitizer at the boundary). No new event vocabulary.
3. **Approvals round-trip to the client.** `approveToolCall` is a client-side decision
   in the current design; over the wire it becomes a server→client request that suspends
   the run. This keeps the existing permission UX (`--permissions ask|yolo|readonly`)
   working identically, which is a real product win — the safety model is "the human at
   the TUI approves", and that survives moving compute to a datacenter.

### 2.2 `RemoteRun implements HarnessRun` (in `nah`)

```ts
// packages/nah/src/remote-run.ts
export const createRemoteRun = (transport: RuntimeTransport): HarnessRun => ({ ... })
```

**`createRemoteRun` takes a `Transport`, not a socket.** Boat's event stream is cursor
long-poll over HTTP, not a WebSocket, and we will have more than one provider. Two
implementations ship in phase 1:

```ts
export interface RuntimeTransport {
  send(frame: ClientFrame): void | Promise<void>;
  /** Frames from the runtime, in order, with at-least-once redelivery. */
  subscribe(): AsyncIterable<ServerFrame>;
  close(): void;
}
// WsTransport   — our own daemon, or a Durable Object
// PollTransport — Boat: GET /events?cursor=&sort=asc&conversation=, long-poll
```

It yields `HarnessEvent`s off the transport, and `steer`/`followUp`/`interrupt` are
frame writes that resolve from a `toolCallId → frame` correlation map. `pending()` is
server-authoritative — the server knows the delivery queue, the client only guesses.
Deduplicate on `seq` in the client; a long-polling transport redelivers.

Then the TUI needs to change **almost nothing**: wherever it does
`createCodingAgentRun(...)` it does `createRemoteRun(...)` when a remote runtime is
configured. That is the entire client-side integration. Everything else is below.

---

## 3. Client side (`packages/nah`)

### 3.1 New subcommand — do not reuse `serve`

`nah serve` is the studio alias (`args.ts:27`, `cli.ts:55`). Overloading it breaks a
shipped command and its documented `status|stop|url|open` actions. Add:

```
nah host [action]     up | status | stop | url | open
                       (the runtime daemon: install it into a sandbox, print its URL)
nah run  [prompt]     drive a configured remote runtime
```

With Boat as the v1 provider, `nah host up` is the `boat new` + scp + systemd + `host
--private` sequence from §1.1, wrapped so the user does not memorise four commands. It
emits the URL and stores it; `--runtime` consumes it.

and flags on the main path:

```
--runtime <url>       connect to a hosted runtime instead of running locally
--session-id <id>     attach to an existing remote session
```

Resolution order for which runtime a bare `nah` uses: `--runtime` flag → `NAH_RUNTIME`
env → `runtime.default` in `~/.nah/config.json` → in-process loop. Absent any of those,
**today's behaviour is unchanged.** Remote must be strictly opt-in for the whole
release; a developer whose TUI suddenly loses local filesystem access is a bad day.

### 3.2 `createHostedEnvironment` — the compute pointer

`packages/nah/src/sandbox.ts` already has `createBlaxelEnvironment`. Add
`createHostedEnvironment({ url, token, sessionId })` in the same file, returning the
existing `BlaxelEnvironment` shape (`{ env, sandboxName, destroy }`) so the caller
doesn't branch on provider.

Inside, `env` is a thin RPC client for the `ToolEnvironment` port. Reuse
`resolveInRepo` path-jailing logic verbatim from `sandbox.ts:111-125` — **do not let
path validation live in only one provider.** Extract it to a shared
`resolveUnderRoot(root, path)` and have both call it. An agent that can write outside
the repo root is a container-escape-shaped bug, and one shared function is the only way
to actually prevent it.

This is Tier A. In Tier B the *server* builds the `ToolEnvironment` from
`createNahToolEnvironment({ repoFs, sandbox })` and the client's `env` is never used —
which is exactly why the port exists.

### 3.3 Config and credentials

Extend `packages/nah/src/nah-config.ts` with:

```jsonc
{
  "runtimes": {
    "fly-coding": { "url": "wss://nah.example.workers.dev", "auth": "token" }
  },
  "runtime": { "default": "fly-coding" }
}
```

Model API keys move **server-side** in Tier B — the client stops needing
`ANTHROPIC_API_KEY` and the runtime's tenant becomes the billing/quota boundary. This is
a real security upgrade (`packages/nah/src/credentials.ts` keeps its local path for
`--runtime`-less use). Auth token: one long-lived per-device token, stored in the
existing credentials file, never in config.

### 3.4 Keys and templates — one invariant that solves both

These look like two problems. They are one, and Boat's model makes the answer short.

**The invariant: the template carries no secrets, and every secret is passed explicitly
in the one call that needs it.**

```ts
// 1. Build (CI, or `nah template build`). No secrets go in.
await boat.create({ noEnv: true });        // scp the bun binary, install the systemd unit
// …smoke test…
await boat.stop({ sandboxId });           // its snapshot IS the template

// 2. Per user. Secret appears here and nowhere else.
const fork = await boat.fork({
  sandboxId: TEMPLATE_ID,
  noEnv: true,                            // never inherit account keys
  env: { ANTHROPIC_API_KEY: userKey },    // per-fork env REPLACES inherited vars
});
```

Consequences worth stating out loud, because they are the whole point:

- **The template is secret-free, so it is safe to fork per user.** Building it with
  `--no-env` is not tidiness — it is what makes step 2 legal. A template built with
  account keys would bake our Anthropic key into every fork forever.
- **`noEnv: true` is not optional on any user-visible sandbox.** Boat's default is to
  inject account-level keys into every sandbox, including the six bundled harnesses'
  keys/subscriptions. Enforce this in one place — a `createUserSandbox()` wrapper that
  hardcodes `noEnv: true` and takes `env` explicitly — so no call site can forget it.
  This is the difference between "our key on a stranger's VM" and a non-event, and it
  should be a lint-able invariant, not a code-review habit.
- **Forks are seconds and near-constant-cost regardless of template contents**, and
  *"forks always take the latest snapshot"* — so there is no template versioning to
  manage. The cost of that is no rollback: keep the previous template id and fork from
  it explicitly if a release goes bad.
- **The systemd unit and the binary live in the template**, which is what makes the
  daemon survive `stop`/`resume`/`fork` for free.

**Whose key is it?** Decide this before Phase 4, because it decides the billing model:

| | Who supplies | Where it lands | Take |
| --- | --- | --- | --- |
| **BYOK** (v1) | The user, from their own `~/.nah/credentials` | That one sandbox, at `new`/`fork` | Default. Preserves the current product promise: `nah` supplies *your* credentials. Also no secret of ours ever exists off our machines. |
| **Our key, metered** | Us | We'd have to put it in a user-reachable VM | Not before we have the relay below, and not before we have per-tenant spend attribution. |
| **Boat account-level** | Boat's Agents dashboard | Every sandbox, by default | Tempting for zero-setup UX, but it means our model credentials sit in a third party's VM in the EU, and it is exactly what `noEnv: true` exists to prevent. |

**The relay, when we want a zero-setup tier (v2).** Notice that the *only* thing the
harness needs a key for is the model call — and that call does not have to happen in
the VM. Put a small keyless proxy in front: the daemon holds a short-lived session
token, the relay attaches the key server-side. Then no long-lived secret is ever in a
sandbox, revocation is per-session, and spend attribution falls out of the relay for
free. The costs are an extra hop per model request and having to proxy streaming SSE
across providers (Anthropic / OpenAI / OpenAI-compatible). *Not a v1 item — record it
now so Phase 4 does not paint itself into a corner.*

**Also per-fork, not in the template:** a git deploy key or SSH key, if the hosted
agent is expected to push. Same rule, same call.

---

## 4. Server side — the DO control plane (deferred; Phase 8)

**This whole section is now the optional second transport.** The runtime daemon in
Phase 4 is the same code minus the Workers constraints, so build that first. Keep this
section for when you need your own control plane: your own key custody, your own
per-tenant billing, or sessions that outlive any one provider.

`packages/nah-runtime-worker/` — a `wrangler` project, not part of the pnpm build graph
until it needs to be.

```
src/
  worker.ts          fetch(): route /runtime/:sessionId -> DO stub
  session-do.ts      extends DurableObject   <- all state, the WebSocket, the run
  tools.ts           ToolEnvironment backed by a SandboxRuntime
  snapshot.ts        R2 <-> tar.gz via the existing agent-sandbox snapshot helpers
  auth.ts            token -> tenant
```

### 4.1 `SessionDO`

One DO id = one session. `blockConcurrencyWhile` does the boot: load transcript,
rehydrate `HarnessRun` handle, mark any `in-flight` run as `interrupted` (the process
died; be honest about it rather than pretending it is still going).

- **WebSocket + Hibernation.** Attach with `ctx.acceptWebSocket`, and use the WebSocket
  Hibernation API so an idle TUI costs storage, not duration. This is the single
  highest-leverage billing decision in the whole plan.
- **Durability for the event log.** Append `{ seq, event }` to DO storage in the same
  turn you emit it. Cap the log (keep last N, plus a compaction checkpoint) or storage
  cost grows with every token.
- **One run at a time per session.** The input gate gives you this for free; do not
  fight it. A second `prompt` while a run is live is a protocol error, not a queue.

### 4.2 The loop

`runAgent` from the harness, with `createCodingTools(env)` where `env` is
`createNahToolEnvironment(...)` over whatever `SandboxRuntime` the tenant is configured
for. Model streaming is plain `fetch` + SSE and works in Workers unchanged — the only
harness thing to audit is that nothing in the loop imports `node:fs` or
`node:child_process`. **Do that audit first** (`grep -rn "node:fs\|node:child_process"`
over `not-another-harness/src`) — if the loop is clean, Tier B is nearly free; if it
isn't, the fix list is the real work and you want to know its size before committing.

### 4.3 Filesystem

Not DO storage. Two options, pick per tenant:

- **Container volume** (Tier C) — a real POSIX tree, `git` works, `pnpm install` works.
- **External sandbox** (Tier A/B) — nothing new; Blaxel already works today.

Snapshots: `packages/agent-sandbox/src/helpers/snapshot.ts` already does tar + S3 upload
and speaks R2 (`S3SnapshotConfig.endpoint`). Wire R2 as the bucket, call
`snapshotToS3` on step boundaries. **Do not** reimplement tar.

---

## 5. Execution plan

Each phase is independently shippable and leaves the CLI working.

| # | Scope | Key files | Done when |
| --- | --- | --- | --- |
| **0** | **Spike.** Create a Boat sandbox, scp a hello-world daemon in, systemd it, `host --private`, hit it from curl. Confirm latency from your region; time a `/commands` round-trip and a `/files` read. | throwaway | You have a public HTTPS URL from a sandbox you can `bash` into. |
| **1** | `nah-runtime` package: protocol types, `RuntimeTransport` + `WsTransport`, seq/replay, `createRemoteRun`. Unit tests over a fake transport. | new pkg, `packages/nah/src/remote-run.ts` | `createRemoteRun` satisfies `HarnessRun`; a test replays a scripted event list and asserts identical output to the local loop. |
| **2** | `createBoatEnvironment` — `SandboxRuntime` + `RepoSandboxFs` over `/commands` and `/files`. Add `"boat"` to `ProviderName`. | `packages/agent-sandbox/.../boat-*.ts`, `packages/nah/src/sandbox.ts` | A `nah --sandbox boat` run edits a real file in a real Linux VM and `git diff` shows it. |
| **3** | Wire `--runtime` into `nah`. TUI renders remote events unchanged. | `args.ts`, `cli.ts`, `tui/host.ts` | `nah --runtime <url> "add a test"` drives a real agent. Reconnect replays without duplication or gaps. |
| **4** | **The daemon.** `nah-runtime-daemon`: systemd unit, `host --private`, serves our own protocol. This is Tier C. **Ship the bun single-file binary** — `packages/nah/scripts/compile-binaries.sh` already emits `bun-linux-x64` / `bun-linux-arm64`, so the sandbox gets one scp'd executable and the `engines: node >=22.19` constraint disappears. | new pkg, `scripts/compile-binaries.sh` | `boat fork` a template, attach a TUI to the fork, it resumes the conversation. |
| **5** | `PollTransport` over Boat's `/events`, now a **control-plane** path: lifecycle and readiness for the hosted Studio (sandbox `ready`/`stopped`/`errored`, resume, fork), not the agent event stream. The agent stream is served by our daemon in Phase 4. | `packages/nah/src/remote-run.ts`, `nah-studio` | Studio shows a hosted sandbox's real state, and a run survives a daemon restart without losing events. |
| **6** | Server-side keys + auth + per-tenant quota. **Elevated by the harness decision**: with our harness running remotely, the model key lives on the daemon, so this is what makes a hosted run possible at all rather than a hardening step. | `credentials.ts`, `auth.ts`, `apps/cloud` | Client holds no model key in remote mode. One token cannot read another tenant's session. |
| **7** | Studio reads remote sessions. | `packages/nah-studio/src/` | Dashboard shows hosted agents alongside local ones. |
| **8** | *Only if wanted:* the Cloudflare DO control plane from §1/§4. | `worker.ts`, `session-do.ts` | Same CLI, same protocol; only the transport binding changes. |

Phases 1–4 are the product. **Phases 0–4 are shippable and useful on their own.**
Phases 5–7 are depth. Phase 8 is a genuinely optional second provider for the same
protocol, which is the whole point of freezing §2 first.

---

## 6. Risks

**v1 (Boat + daemon), in priority order:**

1. **We are picking a provider.** Boat is one company with EU-only regions, a 600s
   command cap, and a plan-gated concurrency ceiling. The entire defence is that
   `RuntimeTransport` (§2.2) and `SandboxRuntime` are both already provider-neutral in
   this repo — so switching costs one adapter, not a rewrite. *Do not let a Boat type
   leak past `packages/agent-sandbox/` or into `nah`. That is the whole risk control.*
2. **We are the seventh harness on someone else's VM.** Boat preinstalls six working
   ones for free. **Mitigated by decision, not by hope:** §7 now settles that a hosted
   session runs *our* harness and only ours, so we are not competing with them on
   their VM — we are the product, and their agents are competitors we simply decline
   to wrap. The residual risk is that a user asks "why not just use the Codex already
   on this box?"; the answer has to be a real product difference, not "ours is nicer".
   *Name that difference before Phase 4 ships.*
3. **Our harness must be clean enough to run remotely.** This is the new cost of the
   decision. The loop now runs in a sandbox we do not fully control, so audit
   `not-another-harness/src` for `node:fs` / `node:child_process` assumptions and for
   anything that assumes a local git identity or a TTY. *Do this audit in Phase 1,
   while the daemon is still throwaway — the fix list is the real work, and finding it
   in Phase 4 means rewriting the daemon.*
4. **Approval suspension over a reconnect.** A run blocked on `request-approval` has
   to survive the client disconnecting and the transport dropping. The approval must
   live on the runtime side, keyed by `toolCallId`, not in the client.
   *Test this in Phase 1 — a lost approval hangs the agent forever.*
5. **EU latency for whoever is not in Europe.** Time one `exec` round-trip from your
   actual location in Phase 0 rather than assuming.
6. **A retry bug that double-applies a side effect.** `502 boat_direct_failed` means the
   command *may already be running*, and a flaky network produces it often. Any generic
   retry wrapper — HTTP client, `SandboxRuntime` decorator, a DO's reconnect logic —
   will turn it into a second `rm` or a second deploy. The API hands us the correct
   signal (§1.2: `retryable`, and `retryable: true` on `error` meaning *provably never
   ran*); the danger is discarding it by collapsing every failure into "retry". Test
   this explicitly in Phase 2 rather than by inspection.
7. **A detached process outliving the agent.** `commandStatus` can return
   `status: "lost"` — the sandbox agent restarted and forgot the process, leaving
   `running`/`exitCode` a best-effort probe and the logs read from disk. A TUI that
   assumes a poll loop always terminates will hang on it, and anything that *re-runs* the
   command on `lost` will double-apply it. `lost` is a terminal state, not a retry
   signal.
8. **Stream latency, only if Phase 5 is ever used for agent events.** Our daemon
   (Phase 4) holds a real socket, so the agent stream is **not** polling latency. This
   now applies only to the control-plane use in Phase 5, where `data.is_streaming`
   partials help. Measure the perceived text speed before assuming the daemon path is
   fast enough for everyone.

**Deferred to Phase 8 (the DO control plane), if we build it:**

9. The Workers event loop is not a process. `setTimeout`-driven polling inside a
   request is fragile once the request returns. Everything long-lived must hang off a
   WebSocket, a `waitUntil`, or an Alarm. *The #1 source of "works locally,
   mysteriously dead in prod".*
10. The harness may not be Worker-clean — the same audit as risk 3, and strictly
    harder on Workers than in a Boat VM (no `node:fs` at all). **Risk 3 does not
    discharge this one**: being clean enough for a Linux sandbox is not being clean
    enough for a Worker.
11. Single-tenant DO = single point of failure, and a session is pinned to one region.
    *Document rather than solve in v1.*

## 7. Open questions for you

- **Which harness runs a hosted session — ours or theirs?** **Resolved 2026-10-03: ours.**
  A hosted session runs the `nah` harness. Boat's preinstalled agents are never the
  default and are not on the v1 path at all — see the consequences below, which are
  load-bearing for Phases 4–6, and §6.2. Boat's `pi` is **not** `not-another-harness`;
  the repo borrows pi's prompt style and nothing more, so there is no overlap to
  reconcile.
- **EU-only regions — is that acceptable?** Germany, Finland, France. Latency and data
  residency for whoever uses this. If not, the DO-vs-Boat question reopens.
- Is remote the *default* for `nah` eventually, or permanently opt-in? This is a
  packaging question that is expensive to reverse, and it decides how much the session
  identity has to be user-visible.
- Should hosted sessions be shareable (a URL another `nah` can attach to, à la tmux)?
  Cheap to add over this protocol, but it means auth is a real feature, not a token check.
- ~~Concretely: does `nah --runtime` default to our daemon, or does it take a
  `--harness claude|codex|opencode|pi` passthrough?~~ **Resolved by the decision above:
  ours, always, on the v1 path.** No `--harness` flag is built. It stays a
  non-goal rather than a deferral, so nobody adds it speculatively: it would mean
  translating six foreign agent output formats into `HarnessEvent`, and it would
  make "which model settings apply" differ per harness. Revisit only if users ask,
  and then as a separate adapter behind the same `RuntimeTransport`.

---

## Sources

All boat.dev claims above are from the vendor's own docs and site, retrieved
**2026-10-03**. Pricing, limits and regions are their marketing numbers and were not
independently verified. Their `/compare` figures are self-reported benchmarks.

- https://boat.dev — product, pricing, benchmark comparison
- https://docs.boat.dev/llms.txt — full docs index; every page fetchable as `.md`
- https://docs.boat.dev/platform-guide.md — platform patterns, daemon pattern, templating
- https://docs.boat.dev/integrated-agents.md — harnesses, `/events`, steer/interrupt, BYO harness
- https://docs.boat.dev/api/reference/agent/{list-sandbox-events,execute-sandbox-command,read-sandbox-file,write-sandbox-file}.md
- https://docs.boat.dev/sdks/typescript.md — `@boatdev/sdk`
- https://docs.boat.dev/openapi/boat-v1.yaml — the full OpenAPI 3.1 document, and the
  actual source of §1.2. Fetch this rather than the reference pages: one request, and it
  is the schemas instead of a summary of them.
