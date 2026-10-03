# Plan: cloud Studio, first-party telemetry, and metered cloud agents

> Builds on [`hosted-runtime-on-boat.md`](./hosted-runtime-on-boat.md)
> (the compute half: Boat sandbox + the `nah` daemon + the wire protocol). That work is a
> prerequisite here — cloud agents need somewhere to run. This document is the control
> plane, the data policy, and the money.
>
> **One correction to that document:** its §3.4 defers the keyless model relay to v2.
> Under a metered product it is v1 — see §4.1 below.

---

## 0. What exists today (grounded)

| Thing | Where | Note |
| --- | --- | --- |
| Store schema | `packages/nah-studio/src/store.ts:22-146` | SQLite: `traces`, `agents`, `agent_logs`, **`spans`**, **`messages`**, `datasets`, `dataset_items`, `scorers`, `experiments`, `experiment_results`. |
| Ingest | `server.ts:176` `POST /api/traces` | Takes `{ agent, trace, spans }`. This is the only write path an agent uses. |
| Aggregates | `server.ts:140` `/api/overview`, `server.ts:145` `/api/tools` | `store.overview()`, `store.timeseries()`, `store.toolStats()` — already rollup queries. |
| Discovery | `endpoint.ts:38` `~/.nah/studio.json` | Written `0600`; the comment says the token "stands between a colleague on the LAN and the contents of your prompts." |
| Evals | `store.ts:206-146`, `evals.ts` | Scorers, judge model, experiment runs. Already a first-class concept. |
| Live stream | `stream.ts` | A hub for the in-process UI. |

**The finding that makes this whole plan cheap:** the `traces` table is *already a
metrics table wearing a trace's name*.

```sql
CREATE TABLE traces (
  id, name, start_time, end_time, root_span_id, status, tags, metadata, error,
  cost_usd REAL, input_tokens INTEGER, output_tokens INTEGER, agent_id
);
```

No prompt text. No file contents. Ten small columns — roughly 200 bytes per run. That
is the "telemetry" you want. Meanwhile `spans` (`:66`) and `messages` (`:83`) hold the
actual content: that is the "tracing" you want off.

**So "disable tracing but keep telemetry" is not a new pipeline. It is a rule about
which of these two existing tables gets written.** The schema already drew the line;
we just have to decide which side of it we ship by default.

---

## 1. The tension you have to resolve first

The README sells this property:

> Telemetry is opt-in by construction: the Studio publishes itself at `~/.nah/studio.json`,
> and a session that finds that file reports to it. **No Studio, no network traffic.**

**Hosting Studio in the cloud inverts that.** The moment a hosted Studio exists, the
default is opt-*out*, and every `nah` user on earth starts shipping prompt content to
your servers whether or not they read a changelog. That is a different product and a
different legal surface.

Three ways out, and the choice is the first decision in this plan:

1. **Local stays local.** Cloud Studio is a separate, explicitly-entered thing
   (`nah cloud login`). `nah serve` keeps today's behaviour exactly. Nobody's prompts
   move unless they ask. *Cheapest to ship, but the hosted product starts at zero
   users.*
2. **Metrics by default, content never by default.** Installing the CLI registers it
   and sends Tier-1 only. Prompt text never leaves the machine without an explicit,
   per-project opt-in. *More product, more surface, and the honest version of
   "cloud Studio".*
3. **Full opt-out cloud Studio.** Simple, and you should not do this.

**Recommendation: (2), with local Studio kept as the escape hatch.** (1) is what you'd
ship if this were a feature; (2) is what makes a hosted product defensible. The rest of
this document assumes (2).

---

## 2. The data split

Define the boundary once, in one type, and make every code path go through it.

### Tier 1 — Metrics. Default. Cheap. No content.

| Field | Source |
| --- | --- |
| run start/end, duration, status, stop reason | `traces` |
| model id, provider | `agents.model` |
| `input_tokens`, `output_tokens`, `cost_usd` | `traces` (already columns) |
| step count, tool **names** + counts | `store.toolStats()` already aggregates these |
| error class (not error text) | `traces.error` → classified |
| `nah` version, host platform, tenant | `agents` |

~200 bytes/run. A 30-step run is 30 rows of tool counts and one trace row. This is
enough for: cost dashboards, adoption, which tools get used, failure-rate, and it is
what billing meters (§4).

### Tier 2 — Trace. Opt-in per project. Short TTL. Never sold.

Prompts, assistant text, tool inputs/outputs, file diffs, full error text. Lives in
`spans` + `messages`. Behind a flag, retained for days not months, and **not** an input
to model training — say that in the terms or don't collect it.

**The enforcement that matters:** the ingest endpoint accepts two payload shapes and
Tier 1 is the *only* one the default client builds. Make `TelemetryEvent` (Tier 1) and
`TraceUpload` (Tier 2) separate types, separate routes, separate retention policies.
Do not make it one endpoint with a boolean — the day someone adds `includeContent: true`
to a default call site, you have a privacy incident and no type error to catch it.

### Why "metrics, not traces" is also the cheap engineering answer

Traces are O(prompt bytes × steps) and get read rarely. Metrics are O(1) per run and
get read constantly, because they power both the dashboard *and* the bill. You are
building one thing and using it twice.

---

## 3. The pipeline (first-party, no APM vendor)

Interpreting "like t3" as the Theophile/Next-ecosystem position: **no observability
vendor, no tracing SaaS, no session replay — own the events, own the schema, own the
database, and make the UI a view over your own data.** That is not a compromise here;
Studio is *already* that. The only change is where the server runs. If you meant
something else by "t3", nothing in §2–§5 depends on it.

```
nah process
  └─ batches Tier-1 events, flushes every N seconds or M events
      POST /api/telemetry  { tenant, runId, events: TelemetryEvent[] }
        └─ must never block, never throw into the run, never retry more than once
```

**Non-negotiable: a failed telemetry POST must not affect the agent.** The current
design gets this right for free — no Studio means no network. Cloud Studio removes that
guarantee, so it has to be enforced:

- Telemetry posts are fire-and-forget from `run.events`; a rejection is logged locally
  at most once, and the run proceeds.
- The TUI's event loop must not await the flush. Wrap in a detached promise; swallow
  errors past the first.
- Nothing telemetry-shaped goes in the critical path of `run.result`.
- A local, size-capped ring buffer of the last N batches so a transient outage does not
  silently lose a session.

Get this wrong and the first time your ingest endpoint has a bad afternoon, every
user's agent hangs — and you will have shipped an outage into a tool people run
interactively. Write the test first: kill the collector mid-run and assert the run
completes.

**Auth:** `nah cloud login` → a long-lived per-device token in the existing credentials
file (`packages/nah/src/credentials.ts`), scoped to one tenant, revocable. Not the
LAN-token model — this one is bearer, so it lives in the OS keychain if there is one,
and rotates.

---

## 4. Cloud agents and billing

This is where the goal stops being a dashboard and starts being a business.

### 4.1 The relay becomes mandatory, not v2

In the runtime plan I deferred the keyless model relay to v2. **Move it to v1.** Two
reasons, and the second is decisive:

1. We are the ones paying for tokens, so per-tenant attribution must exist or there is
   no bill to send.
2. A provider key must never sit in a user-reachable VM. The template is secret-free
   and secrets are per-fork (§3.4 of the runtime plan) — but with BYOK we would have no
   meter at all, and a hosted agent that costs us money with no way to attribute it is
   not a product, it is a donation.

So: the daemon in the sandbox holds a **short-lived session token**, never a model
key. The relay terminates the model call, attaches the key server-side, meters exact
input/output tokens per tenant, and streams SSE back. Cancellation must propagate — a
stopped run must stop billing.

### 4.2 Meter tokens, not sandbox time

This inverts the usual assumption and it is worth being explicit, because Boat's
marketing leads with cheap VMs and that leads people to meter the wrong thing.

At Boat's published default rate (`$0.00001`/s, 4 vCPU / 8 GB):

- A 10-minute agent run costs **~$0.006** in compute.
- That same run, at roughly 200k cumulative input and 20k output tokens on a mid-tier
  model, costs **~$0.90** in tokens — with a normal prompt cache, less.

Tokens are **two orders of magnitude** the compute cost. Meter tokens. Charge compute
as a rounding error, and use `stop`/`resume` (Boat's Pattern 3) so an idle session is
~$0 rather than the $26/mo an always-on sandbox costs.

*Model rates move; re-derive this table before you set prices. The ratio, not the
absolute numbers, is the durable finding.*

### 4.3 The price shape

Cost-plus on tokens with a published, static rate card per model — no seat pricing, no
"contact us":

```
customer pays  = inputTokens(model)  + outputTokens(model) + compute(sandbox_seconds)
our cost       = same, at provider rates
```

- **Rate card** is a versioned table in the DB, not code, so you can reprice without a
  deploy and can always answer "what did this run cost on date X".
- **Compute** at cost, or a rounding charge. Do not mark it up — it is ~1% of the bill
  and it will only ever generate support tickets.
- **A floor.** An always-on sandbox is $26/mo whether or not it does anything. Stop and
  resume aggressively, and price the always-on tier to cover it.
- **Evals are a cost centre.** `judgeScorer` (`evals.ts:133`) calls a model. Rate-limit
  experiments per tenant or a user's 3× repeat loop quietly eats your margin.

### 4.4 The abuse problem is the real problem

Once you hold the key, someone can burn it. Budget for this before you launch it, not
after:

- **Hard per-tenant monthly spend ceiling**, enforced at the relay. Not a soft alert.
- **Step and token caps per run**, enforced in the harness, not by the model
  (`HarnessRunOptions.stepBudget` already exists — `not-another-harness/src/types.ts:218`).
- **Sandbox TTL.** Boat defaults to 1 hour; do not raise it globally.
- **Concurrency caps per tenant**, so one user cannot occupy the whole pool.
- **Alerts on spend velocity**, because a leak and a legitimate power user look
  identical on a dashboard.
- Reserve a margin for the free tier or cap it hard. A free tier on a metered-token
  product is an unbounded liability.

### 4.5 Auth and tenancy

Multi-tenant from day one or retrofitting it is a quarter. Tenant id on every table,
every query filtered by it, enforced in the store layer (not per route — that is how it
leaks). Row-level security in Postgres is worth the setup cost; at minimum, one
`tenant_id` column and a test that asserts a cross-tenant read returns nothing.

---

## 5. Where the Durable Object comes back

The runtime plan demoted it. For *this* goal it earns its place, for a specific reason:
**a metered agent session has to survive the client disconnecting, and its state has
to be authoritative for billing.** That is a durable, addressable, single-writer
object — a DO is the right primitive.

Per-session DO holding: the run's state, the replayable event log, the remaining token
budget, the relay session token, and the `interrupt` channel. Roughly the runtime
plan's §4 as written, minus the parts Boat already gives us. The relay can live behind
it, so a session's spend is attached to a durable record rather than to whatever
happened to be in memory when the TUI closed.

Studio itself is Next.js + Postgres, not a DO. Only the per-session runtime is.

---

## 6. Execution plan

| # | Scope | Done when |
| --- | --- | --- |
| **1** | Split the types: `TelemetryEvent` (Tier 1) / `TraceUpload` (Tier 2), separate routes, separate retention. No behaviour change yet. | An agent can post Tier 1 without a single content field existing in the payload type. |
| **2** | Batched, non-blocking client emitter + the outage test. | Kill the collector mid-run; the run completes. This is a test, not a claim. |
| **3** | Cloud ingest: tenant id, token auth, Postgres for Tier 1, rate limits. | A device token from one tenant cannot write to another's rows. |
| **4** | Hosted Studio reading the cloud store: overview, tools, cost, timeseries. | The dashboard you have, backed by Postgres instead of local SQLite. |
| **5** | Relay: keyless session token, per-tenant token metering, cancellation, spend cap. | An interrupted run stops accruing cost. A tenant cannot exceed its ceiling. |
| **6** | Billing: versioned rate card, per-tenant usage ledger, invoice view. | "What did tenant X spend on run Y, on date Z" is answerable exactly. |
| **7** | Cloud agents end-to-end: fork from template, run the daemon, stream to hosted Studio. | A user watches a paid, metered agent work in a browser. |
| **8** | Per-session DO for durable run state + replay. | Close the browser mid-run; reconnect resumes the same session and the bill stays right. |
| **9** | Tier 2 opt-in, per project, with TTL. | Off by default; on for a project, it deletes itself on schedule. |

1–4 are the hosted Studio and are useful with zero revenue. 5–6 are the business. 7 is
the demo. 8 is durability. 9 is the feature you should be most careful about.

---

## 7. Risks

1. **You are turning opt-in telemetry into opt-out.** If you get §1 wrong, nothing
   else matters — this is a trust failure, not a technical one, and it is not
   recoverable by a later settings page. *Decide before building, not before
   launching.*
2. **Telemetry in the critical path.** Covered in §3; write the test first.
3. **Key custody.** One leaked relay token or one missing spend cap is a direct,
   uncapped financial loss. §4.4 is not optional scope.
4. **Cost model drift.** Model prices change and a stale rate card silently turns your
   margin negative. *Version the card and alert on realised-vs-expected margin.*
5. **Judge evals are a second, unbudgeted model bill.** Easy to forget.
6. **EU-only compute** (from the runtime plan) compounds with §1: prompt content
   residency is a question you will be asked by anyone who reads the privacy policy.
   Say plainly where Tier 2 data lands or do not collect Tier 2.
7. **Multi-tenant retrofit is a quarter.** Do it in phase 3, not phase 7.

---

## 8. Open questions

- Is (2) in §1 the right default, or is explicit `nah cloud login` the honest v1?
  This is the decision everything else waits on.
- Do you ever want Tier 2 at all? "No, ever" is a legitimate product position and it
  removes a whole class of work, risk and legal surface. It also removes the
  live-trace view, which is a lot of Studio's appeal.
- Billing entity: is this sold to individuals (card, prepaid) or to teams (invoice,
  committed spend)? It changes metering from day one, not later.
- Is the hosted Studio for *our* cloud agents only, or also a place users push their
  own local runs? The second is more valuable and much harder — it is a sync problem,
  not a compute problem.
