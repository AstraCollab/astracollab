# Handoff — migrating `@astracollab/client` from Mastra to NAH

**Date:** 2026-10-03 · **Repos:** `astracollab-packages` (monorepo) and `astracollab/client` (separate npm project)

Goal: `client` runs its agents on `not-another-harness` + `nah-studio` and drops
Mastra entirely. This file is the state of that work, what is proven, what is not,
and what to do next.

> **Both working trees are shared.** Another agent has been working in
> `astracollab-packages` (notably `not-another-harness`, `nah-studio`,
> `apps/cognitive-memory`) and in `client` at the same time. Changes to
> `packages/not-another-harness/src/**` interleave ours and theirs. Do not assume a
> modified file in that package is ours.

---

## 1. Placement decision

| Concern | Home | Why |
|---|---|---|
| Traces, spans, `traceRun` | `not-another-harness` | The loop emits them; consuming its event stream means tracing cannot change agent behaviour |
| `prepareStep`, `shouldStop`, `sessionUpdate`, `createSessionManager`, `caps` | `not-another-harness` | Replacing SDK primitives (`Harness`, stop conditions, tool caps) |
| Gateway / Mastra message interop | `@astracollab/ai` | Provider and format concerns, not agent concerns |
| Client-specific agents, tools, rules | `@astracollab/agents` | Facts about *this* traffic and *this* agent, not about agents |

Rejected, with reasons: harness-shaped tool caps in the client (they'd be forked);
a Mastra-shaped `Agent` adapter (a compatibility layer for something being deleted);
session reuse in `nah-studio` (it is runtime lifecycle, not transport).

---

## 2. What exists

### `not-another-harness` (runtime)

| Addition | File | Notes |
|---|---|---|
| `traceRun`, `Span`/`Trace`, sampling, redaction | `src/telemetry.ts` | Consumes the public event stream; no control-flow change |
| `prepareStep` / `PrepareStep`, `StepOverrides`, `StepToolChoice` | `src/types.ts` | Per-step `toolChoice`, temperature, model |
| `shouldStop` + `stopped-by-caller` | `src/types.ts`, `src/agent.ts` | Caller domain rules; checked at the step boundary, never on step 1 |
| `sessionUpdate` | `src/types.ts` | The append-vs-replace decision, in one place |
| `createSessionManager` | `src/session-manager.ts` | Warm sessions, idle eviction, LRU capacity, `unref`'d self-sweep |
| `caps` overrides (`CapsOverrides`, `resolveCaps`) | `src/caps.ts`, `src/tools.ts` | `sliceFileLines` now takes the cap instead of reading the default |
| `toolsContext` (`ToolContextMap`) | `src/types.ts`, `src/agent.ts` | **Works — the SDK reads it keyed by tool name. See §4** |
| `tool-error` → `tool-result` mapping | `src/agent.ts` | A tool that throws is now visible on the event stream |
| `toolApproval` pass-through + `tool-approval-request`/`-response` events + `awaiting-approval` stop + `appendApprovalResponses` | `src/types.ts`, `src/agent.ts`, `src/telemetry.ts` | The 18 destructive client tools would otherwise have run unattended. See §4 and §5 |

### `@astracollab/agents` (client agent surface, `packages/agents`)

Sanitisers (`tool-input.ts` — two of the four Mastra patches), the coding agent +
`prepareStep` port (`coding-agent.ts`), run-result readers that replace four
Mastra result-diggers (`run-shape.ts`), step ceilings and turn logging
(`turn-log.ts`), five anti-loop rules (`anti-loop.ts`), and the tool-map seam
(`tools.ts`).

### `@astracollab/ai`

`reasoning-compat` (gateway `reasoning_content` middleware, with a verified
in-place self-heal) and `mastra-messages` (Mastra ↔ `ModelMessage`, both content
formats, strict-by-default with `preserve`, a fixture-driven round-trip gate, a
`SessionStore` adapter, and a one-pass row migration).

### In `client`

`lib/ai/gateway-thinking-compat.ts` — `synthetic: true` on injected reasoning, plus
`markLegacyInjectedReasoning`. Two clarifying comments distinguishing Mastra's UI
converter from `@astracollab/ai/mastra-messages`. Nothing else in `client` changed
except two added dependencies.

---

## 3. Publish state (verified against npm, not `package.json`)

| Package | Published | Contains | Missing |
|---|---|---|---|
| `not-another-harness` | **`0.0.1-beta.7`** (verified in the tarball) | `createSessionManager`, `shouldStop`, `CapsOverrides`, `ToolContextMap`, `toolsContext`, `PendingApproval`, `ToolApprovalAnswers`, `appendApprovalResponses`, `awaiting-approval`, `tool-approval-request`/`-response` events, `tool-error` mapping | — |
| `@astracollab/agents` | **`0.0.1-beta.1`** | all 36 exports | — |
| `@astracollab/ai` | `0.0.1-beta.2` | `skippedDuplicates`, `planRowMigration` | — |

`client` has `not-another-harness@0.0.1-beta.7`, `@astracollab/agents@0.0.1-beta.1`
and `cogmemory@0.0.1-beta.3` installed — **one** copy of the harness, shared with
`@astracollab/agents` (the nested beta.5 copy npm used to install is gone).

> **`beta.7` was briefly uninstallable, and the cause is a publish-ordering trap
> rather than a defect.** Its `package.json` resolved the workspace dep
> `cogmemory: workspace:^` to the concrete range `^0.0.1-beta.3`. At the moment it was
> published, only `cogmemory@0.0.1-beta.2` existed, so
> `npm install not-another-harness@0.0.1-beta.7` failed outright with `ETARGET` — not
> a warning, a hard failure, for anyone installing fresh. `cogmemory@0.0.1-beta.3`
> landed ~83 seconds later (registry `time`: 21:49:30Z) and beta.7 has been
> installable ever since; verified by a clean install into an empty directory.
>
> So both "it is broken" and "it works" were true, minutes apart, and neither was
> wrong. Worth internalising as a sequence rather than a bug:
>
> 1. A workspace dependency is **rewritten to a concrete semver range at publish
>    time**, so the dependent package's installability depends on a *registry*
>    version that must already exist.
> 2. Publishing the dependent first therefore produces a package that is briefly
>    uninstallable by anyone outside the monorepo — including CI.
> 3. npm's registry is eventually consistent after a publish: a `PUT 202` means
>    *accepted*, not *queryable*, and `npm view` lags it by a minute or two. Polling
>    before concluding a version is missing avoids a wild goose chase.
>
> The safe order is leaf-first: publish `cogmemory` beta.3, confirm it resolves, then
> publish the packages that depend on it.

> **Never trust `npm view … exports` for existence checks.** Its `exports` field was
> stale twice and produced three wrong conclusions in this work. Check
> `npm view <pkg> version`, then `npm pack` and read the tarball's own
> `package.json`. Relatedly, the harness's `dist/index.d.ts` is a 3.7 kB
> re-export barrel — grepping it for a type gives a false zero; the types are in
> `dist/types.d.ts`.
>
> And `npm view` is not an oracle on *timing* either: the registry is eventually
> consistent, so a version that exists can be invisible for a minute or two. To date a
> publish, read `npm view <pkg> time --json` — the per-version timestamps are
> authoritative even when the live query is still catching up.

---

## 4. Verification status — read this before trusting anything

### Proven

- **Tool execution works**, and the fast suite now proves it
  (`test/tool-execution.test.ts`): `execute` ran, a `tool-result` event fired, the
  tool message reached the transcript, and every call pairs with exactly one result.
  The blocker was never the mock. A tool call's `input` is a **string** in a *stream*
  part and an **object** in a *prompt* part; a fixture copied from the prompt shape
  compiles through a cast and fails at runtime with `toolCall.input.trim is not a
  function`. Stringify it and the mock executes tools like anything else —
  `test/helpers/ai.ts` now builds the real `tool-input-start`/`-delta`/`-end` +
  `tool-call` sequence so a fixture cannot get it wrong silently. The live test
  remains as provider insurance, not as the only coverage.
- **A failed tool execution is no longer invisible.** The SDK reports a thrown tool
  on a separate `tool-error` part; the loop now maps it to a `tool-result` event with
  `isError: true` and the same message the model reads, paired by `toolCallId`. That
  also makes `traceRun`'s `isError` branch — previously unreachable, so decoration —
  real, asserted over a run rather than over hand-written events.
- **`toolsContext` works**, and was never broken in the way it looked.
  `executeToolCall` reads `toolsContext[toolName]`: it is a map keyed by **tool
  name**, one slice per tool. Both earlier experiments passed a single shared
  object, which the SDK reads as *the context of a tool named `actor`* — no error,
  no warning, `undefined` in every real tool. So "does not work" was "keyed wrong,
  in a package whose tests could not execute a tool to notice". `StepOverrides`
  no longer claims to carry forward: it is per step, like every other override.
- **Mastra message round-trip** across all seven part types, a signature-bearing
  reasoning part, a synthetic placeholder, a legacy row and idempotency
  (`packages/ai`).
- **`prepareStep`, `shouldStop`, `sessionUpdate`, `createSessionManager`** — each
  has a focused suite; `caps` overrides verified reaching tool output.
- **A 0 → 1 step-numbering port** (`prepareStep` is 1-based; Mastra was 0-based)
  is asserted directly, because it typechecks, survives review, and quietly
  requires a tool one step too late.
- **`wroteFiles` no longer counts a call as a change** (`packages/agents`): it
  requires a successful tool result, so a run whose every `edit` failed cannot pass
  a completion gate. A call with no result counts as unsuccessful — that means the
  run was cut off. Only reachable now that failures are on the stream.
- **`toolApproval` works, and `runAgent` had no concept of approval at all.** The
  blocker the client had: **18 of its tools are destructive and gated**
  (`deleteFile`, `deleteProject`, `deleteTicket`, `removeTeamMember`,
  `deleteChannel`, `deleteLeadSource`, `deleteFileShareLink`, …), and this harness
  forwarded no `toolApproval` and mapped no approval part — so all 18 would have run
  unattended under it, with **no test able to fail**, because a `deleteFile` that
  succeeds is indistinguishable from one that was approved. Same shape of bug as the
  unmapped `tool-error`, except it deletes data instead of hiding a log line.
  `test/tool-approval.test.ts` (23 tests).

  Four protocol facts, each verified against the mock because none is guessable from
  the types and each fails *silently* when wrong:

  1. **A held call ends the run.** `user-approval` emits no result part, so the next
     request carries a `tool-call` with no matching result and the SDK throws
     `MissingToolResultsError`. Suspension is mandatory, not a preference.
  2. **The answer must be the last message.** The SDK reads approval responses from
     `messages.at(-1)`, and only if it is a `tool` message. `runAgent` used to append
     `prompt` unconditionally, which pushed the answer out of that position — the
     approved tool never ran and the run reported *success having done nothing*. The
     harness now detects a transcript ending in a decision and does not append the
     prompt, so a resumed run passes `prompt: ""`.
  3. **A resumed run may leave `toolApproval` configured.** A call that already has a
     decision in the transcript executes directly and is not asked about twice.
  4. **A denied call is re-announced on every later step of the same run.** The SDK
     re-emits `tool-output-denied` from the transcript, unlike a plain `tool-result`,
     which is not replayed. Mapping it faithfully produced two `tool-result` events for
     one call; there is now one result per call per run.

  Two further bugs found while proving it, both from the same family: the wrap-up step
  **crashed** a run that was suspended for approval *or* stopped by a `shouldStop`
  rule while a call was held (`MissingToolResultsError` again), and a denial decided
  in an earlier run reported `toolName: ""`, because a resumed run has no approval
  request part to read the name from.

- **`ToolApprovalAnswers`, not `ApprovalDecision`** — `createCodingTools` already
  exports an `ApprovalDecision` for a different mechanism entirely (a synchronous
  in-process `approveToolCall` returning `"allow" | "deny"` before a mutating tool
  runs, in `src/tools.ts`, written by the other agent). Nothing round-trips through a
  transcript there. A caller reaching for the wrong one gets neither behaviour.

### Not proven — do not build on it

- Nothing outstanding in this package. The live provider test
  (`test/tool-execution.live.test.ts`) is the only thing skipped for want of
  `OPENROUTER_API_KEY`; its assertions are duplicated in the mock suite, so a
  skipped live test is not an open question.

---

## 5. Open issues, ranked

1. ~~**Memory is the open design question.**~~ **Researched — the plan is in §9. The
   short version: read history read-only from the Mastra store while writing to a
   new NAH-native one, then add `cogmemory`'s prompt context. Do *not* build PgVector
   parity; the research says it is the last thing you want, and §9 gives the reasons
   and the evidence.

4. **The client's memory turn is unwired.** `MemorySource`, the read-only fallback
   store and the `cogmemory` integration are built and tested (§9), and the new
   workspace assistant exists (`workspace-assistant-nah-turn.server.ts`, gated by
   `npm run verify:nah-agent`), but neither is called by a route. Phase 0 needs the
   client to pass a `legacy` Mastra store and a `current` NAH-native one; Phase 1
   needs a `cogmemory` engine, and the real choice is **embed it or talk to the
   service** — the service runs deterministic extraction first and the model on top,
   so it is the recommended default (§9).

Nothing blocks client step 2 any more. Both of its prerequisites — the tool-identity
seam and the approval bridge — are built, tested, and typechecked against the
published packages, and memory has been built ahead of it.

### Step 1.5, as built

`lib/ai/nah-approval-ui-chunks.ts` (client), 22 tests via
`npm run test:approval`.

The good news first: **the UI needed no changes.** `workspace-chat-dock.tsx` renders
the SDK's tool-part state machine and answers with `addToolApprovalResponse`, so it
knows nothing about Mastra or the harness. Only the server half was missing.

- `approvalChunks(event, runToken)` → the chunks that drive a held call to
  `approval-requested`. Emits nothing when `isAutomatic`, since a gate that decided
  itself must not render a card the user cannot answer.
- `approvalResumeInput(messages)` → `{ toolApprovalAnswers, runToken }` for
  `appendApprovalResponses`, keyed by the **harness** id.
- **The approval id is composite** (`"<runToken>::<harnessApprovalId>"`).
  `extractV6NativeApproval` splits on the last `::` and needs a non-empty prefix, and
  uses the prefix as the resumable `runId`; a bare harness id yields no resume data,
  so the turn 400s with the user's click apparently doing nothing. The two halves are
  keyed by *different* strings on purpose, and nothing forces them to agree — get it
  wrong and `appendApprovalResponses` drops the decision as "not pending", silently,
  and the run reports success having done nothing.
- `readApprovalDecision` requires the decision to be on the **final** message, matching
  `extractV6NativeApproval`. Scanning further back is more forgiving and wrong: a
  decision from two turns ago is history, and resuming on it re-runs a call the user
  answered a different question about.
- Deliberately narrow: it translates approval events **only**. Harness `tool-call` and
  `tool-result` carry `step` and a display-capped `output`, which is the wrong shape
  for the SDK's tool-part machine; translating those too would mean maintaining a
  second, lossy copy of the tool-call protocol. Those still go through the SDK's own
  stream. Step 2 wires the two together.
- One test imports the **real** `appendApprovalResponses` from the installed
  `not-another-harness` and feeds it the output of `approvalResumeInput`, because both
  halves are correct in isolation and still produce a resume that never runs the tool.
  It used to load a sibling checkout's `dist` by absolute path and skip when absent —
  which meant it did not run on CI, the one place it mattered. Importing the installed
  package removed the path, the skip, and the local type declaration that existed only
  because beta.6 predated approval events. All three were scaffolding for a publish
  that has now happened; none of it was a design.
- What that scaffolding was worth recording for: four plausible-looking spellings of
  the compile-time gate tying the local declaration to the package were each verified
  to compile in **both** states, i.e. to check nothing — `const x: true = value as
  Guard` (the `as` discards the thing being checked), a conditional resolving to a
  string literal, and an unreferenced type alias. Only one form bit, and its polarity
  is the opposite of the intuition that produced the other three. With the publish
  done the whole question is moot, which is the better outcome.

---

## 6. Client migration plan

Two things discovered late and not in the original plan:

- `workspace-assistant` is not just an agent definition. It is registered in
  `src/mastra/runtime.ts` for **Mastra Studio to introspect 96 tools**, and
  `workspace-ai-chat-mastra-backfill.server.ts` iterates it.
- The client already runs its own session layer on Mastra's `Harness`
  (`lib/ai/workspace-assistant-harness-session.server.ts`, 275 lines) — warm reuse
  per chat, idle eviction, mode switching, subagents, a respond bus. `Harness` is
  itself deprecated in favour of `AgentController`.

**Build new, do not port.** The agent files are small and disposable; "porting"
them implies preserving a Mastra artifact being deleted.

| Step | Where | Blocked by |
|---|---|---|
| 0. Memory: read-only from the Mastra store, write to a new NAH-native one, plus `cogmemory`'s prompt context | client | **built in `@astracollab/agents`** (`memory.ts`, `memory-stores.ts`, `memory-cognitive.ts` — 119 tests, all exports in dist). Nothing in production calls it yet; see §9 for what the client must supply |
| 1. Tool context: deliver actor/authz via closure instead of `requestContext` (~18 tools in `lib/services/ai-tools/chat-tools.ts`) | client | **done — the seam exists, verified, and nothing in production calls it yet** |
| 1.5. Approval bridge: harness events → the `UIMessageChunk`s the dock renders | client | **done — tested, and nothing in production calls it yet** |
| 2. New `workspace-assistant` on `runAgent` + `createSessionManager` + `wrapToolsWithSanitisers`, keeping Mastra memory | client | **nothing — unblocked.** Steps 1 and 1.5 are its two prerequisites and both are built; this is where they get wired to `runAgent` and to `writeUiChunk` |
| 3. Prove it in production | — | — |
| 4. `coding-agent`: its `prepareStep`, anti-loop rules, sanitisers and result readers are already in `@astracollab/agents`; mainly delete the Mastra `Agent` wrappers | client | step 3 |
| 5. Delete `Harness`, `AgentController`, the four `patch-mastra-*.mjs` scripts, and the Mastra deps | client | step 4 |

The four patches, for the record: `workspace-writer-custom` guards a Mastra bug and
**disappears** (NAH has no writer concept — nothing calls `writer.custom`); `list-files-booleans`
and `list-files-pattern` become sanitisers in `@astracollab/agents`;
`workflow-start-async` is irrelevant once workflows leave Mastra.

### Step 1, as built

`bindWorkspaceChatTools(tools, env)` in
`lib/services/ai-tools/bind-workspace-chat-tools.ts`. The tool map stays built once
at module load for Studio's introspection; the turn's identity is bound per turn by
closure, and `readWorkspaceChatActor` reads the bound value first. **No tool body
changed** — 116 call sites across 12 files were not touched, because the seam is
where the identity comes from, not where it is read.

- `WorkspaceChatToolEnv` is `{ actor, authz, runtimeUnlock }` and nothing else.
  Mode, preamble and memory options stay on `WorkspaceChatRequestContext`, which is
  read by *Mastra* in its own `instructions`/`model` callbacks — nothing in this repo
  can bind those.
- **`runtimeUnlock` is shared by reference.** The turn mutates that box mid-run when
  a capability upgrade is approved; a copy would freeze the flag exactly when it is
  meant to change.
- The key is `workspaceTurn`, **not** `workspace`: Mastra's `ToolExecuteContext`
  already has a `workspace` key for its workspace/sandbox handle, and both would land
  on the same object. `tsc` caught this as 40 identical errors across `chat-tools.ts`;
  a tool reading the wrong one would act on the wrong filesystem and the wrong
  identity simultaneously.
- A turn missing any of the three values throws **at bind time**, naming what is
  missing, instead of at tool-call time as a database error from a query scoped to
  `undefined`.
- **The Mastra path still works.** `readWorkspaceChatActor` falls back to
  `ctx.requestContext`, so nothing in production changes behaviour, and the bound
  env wins where both are present. That fallback is the one thing to delete in
  step 5.

The client has no test runner, so the gate is a script:
`npm run verify:tool-binding` (`scripts/verify-workspace-chat-tool-binding.ts`),
covered by `tsconfig.scripts.json`. It checks the six properties that would each be
silent if broken — bound-with-no-Mastra-context, cross-turn isolation, wrap-not-
mutate, unlock-box identity, Mastra fallback, bind-time guard — and each was
confirmed to fail with the behaviour broken.

**Nothing calls `bindWorkspaceChatTools` yet.** Step 2's agent is its first
consumer; the Mastra turn path was deliberately left alone, because it goes through
`sendSignal` on a mode agent and `workspace-assistant-turn-core.server.ts` is under
active edit by the other agent.

---

## 7. Next steps, in order

1. **Client step 2**, and it is unblocked. The new `workspace-assistant` on
   `runAgent` + `createSessionManager` + `wrapToolsWithSanitisers`, keeping Mastra
   memory. Both prerequisites are built and tested: `bindWorkspaceChatTools(
   workspaceChatTools, env)` for identity, and `approvalChunks` /
   `approvalResumeInput` for approval. Step 2 is where they meet `runAgent` and
   `writeUiChunk`, and where `toolApproval` is finally switched on for the 18
   destructive tools. After that the agent never touches a Mastra `RequestContext`.
2. Then the Mastra turn path can be pointed at bound tools, and the
   `ctx.requestContext` fallback in `readWorkspaceChatActor` deleted.

---

## 8. Landmines

- **`prepareStep` step numbers differ.** Mastra counted from 0; NAH counts from 1.
- **A tool call's `input` is a string in a stream part and an object in a prompt
  part.** Copying a fixture from the prompt shape produces
  `toolCall.input.trim is not a function`, which reads as a model that declined to
  answer. Built once in `test/helpers/ai.ts`; do not hand-roll it.
- **`toolsContext` is keyed by tool name.** `{ actor }` instead of
  `{ read: { actor } }` is silently ignored — no error, no warning, `undefined` in
  every tool. This is what made the option look broken for as long as it did.
- **Approval is a transcript round-trip, not a callback, and the answer must be the
  last message.** `runAgent` appends `prompt` unconditionally, which displaces it.
  A resumed run passes `prompt: ""`; a run whose transcript ends in an answer is
  detected and the prompt is not appended. Getting this wrong produces a run that
  reports success having done nothing.
- **A denied tool call is replayed on later steps.** `tool-output-denied` comes back
  from the transcript; a plain `tool-result` does not. Hence one result per call per
  run — without it a refused `deleteFile` looks like it was attempted twice.
- **Mastra gates on `requireApproval`; the AI SDK gates on `needsApproval`.** A tool
  carrying only Mastra's spelling runs **unattended** under the harness — no error, no
  warning, and a `deleteFile` that deletes. All 18 gated tools were in that state
  until `bindWorkspaceChatTools` translated it. Two things make this one non-obvious:

  - **`createTool` strips `needsApproval` on construction.** Spreading both spellings
    into the tool definition — the obvious fix — leaves the tool ungated while looking
    correct. Verified: `createTool({ requireApproval: true, needsApproval: true })`
    produces an object with **no** `needsApproval` key, while the same flags on a
    plain object survive. So the flag has to be attached *after* construction, which
    is what the binder does.
  - **`createTool` sets `requireApproval: false` by default on every tool.** A
    translation keyed on `"requireApproval" in tool` therefore annotated all ~96 tools
    with `needsApproval: false`. Harmless in effect, but it wrote a field nobody chose
    onto every tool, and the assertion meant to catch that was satisfied by a tool
    that had been silently annotated. **Key on the value, not on presence.**

  `requireApproval` is still read at runtime by Mastra
  (`if ("requireApproval" in tool && Boolean(...)) return false`), so it stays
  untouched — the binder *adds* the SDK's spelling rather than replacing Mastra's,
  exactly like the `requestContext` fallback. Removing it is a step-5 job.

- **Deriving the gate from each tool is equivalent to
  `WORKSPACE_TOOL_IDS_REQUIRING_APPROVAL`, and cannot drift from it.** Verified by
  building all 18 as real `createTool`s and diffing the two: same 18 gated, nothing
  extra, nothing missing. They are the same statement written twice, because four of
  the tool sites call `workspaceToolRequiresApproval()` to decide their own flag.

  Two things that look like exceptions and are not.
  **`workspaceAgentCapabilityUpgrade` is registered but carries no `requireApproval`
  and is not in the set.** It is deprecated, its `execute` returns a canned "Agent
  tools are already available", and `RETIRED_CHAT_TOOL_NAMES` keeps it out of the
  model's tool list; it exists so old persisted messages still validate. I initially
  assumed it was gated and raised it as an open question — it is not, so nothing needs
  an exception list. And **`createTool` sets `requireApproval: false` on every tool**,
  so a translation keyed on presence rather than value annotates all ~96, which is
  the trap above.

- **The gate is asserted by running the real harness loop, not by inspecting flags.**
  `npm run verify:tool-binding` builds every tool in
  `WORKSPACE_TOOL_IDS_REQUIRING_APPROVAL` as a real `createTool` with
  `requireApproval: true`, binds them, drives `runAgent` against the mock, and checks
  the tool did not run and the run reported `awaiting-approval` — plus that an ungated
  tool still runs. Inspecting the field would have passed against the
  `createTool`-strips-it bug, since the field genuinely is not there.
- **`addToolApprovalResponse` with an id that matches no pending part does not
  throw.** The part simply stays `approval-requested`, the resume finds no decision,
  and the turn 400s. Pinned in the client's test suite.
- **Any stop while a call is held must skip the wrap-up step.** The transcript ends in
  an unanswered `tool-call`, and the wrap-up request fails with
  `MissingToolResultsError` — so a suspended run, and a run a `shouldStop` rule ended
  while suspended, both crashed instead of stopping.
- **One Mastra row can become two `ModelMessage`s** (a tool call splits into
  `tool-call` + `tool` message). Anything doing `messages.slice(before)` loses
  history silently — that is what `sessionUpdate` is for, and
  `createMastraSessionStore` exposes `loadedCount` so the correct value is the
  default.
- **A legacy Mastra row has no `parts`.** `MastraMessageContentV2` still carries
  pre-`format: 2` `content` / `reasoning` / `toolInvocations`. Reading only `parts`
  returns an empty transcript.
- **Injected reasoning is indistinguishable from real reasoning** once persisted —
  both are `{type:'reasoning'}` with near-empty text. Hence `synthetic: true`, and
  `markLegacyInjectedReasoning` for rows written before it existed.
- **`stepCallSignatures` / `stepToolNames` were declared outside the step loop**,
  so every entry in `prepareStep`'s `steps` was a cumulative snapshot of the whole
  run. Reset at the step boundary now, with a regression test.
- **`module.register()` + tsx 4.22.0 silently empties every dynamic import.** A
  user-registered resolve hook runs in a *worker thread*, so module source crosses a
  `postMessage` and arrives as a `Uint8Array`; tsx's load hook called `.toString()` on
  it, which for a `Uint8Array` is comma-joined bytes (`"99,111,110"`), which esbuild
  parses as comma-operator expressions — valid syntax, no-op semantics. Every import
  then resolved to `{}` **with no error and exit code 0**. For a verification script
  that is the worst failure available: it reads as a pass. Use
  `module.registerHooks()` (synchronous, in-thread) instead; fixed upstream in tsx
  4.22.3 ([privatenumber/tsx#796](https://github.com/privatenumber/tsx/issues/796)).
  Corollary: **assert a module actually has exports** in any gate that imports app code.
- **`--conditions=react-server` cannot be combined with `@ai-sdk/react`.** It is the
  obvious way to load `server-only` (the package resolves to `empty.js` under it), but
  it also flips React to `react-server.js`, which exports no `createContext`, so
  `Chat` fails to load. `--conditions=browser` does not help: React's exports map lists
  `react-server` first, so it wins.
- **A test that cannot fail is decoration.** Every gate built here was verified by
  breaking the behaviour it guards and confirming the failure.

---

## 8b. Tool suspension: `ask_user` and `submit_plan`

Built in `not-another-harness` (`src/suspend.ts`, `src/interactive-tools.ts`, 21 tests).
The primitive only — **nothing in the client enables it yet.**

### What was built

`suspend(payload)` throws from a tool's execution context; the harness catches the
marker, records `tool-suspended`, and stops with a new reason `suspended` and
`result.pendingSuspensions`. On resume the tool is **re-run from the top**,
statelessly — it checks `resumeData` first and returns it. Mastra's semantics exactly,
because a client migrating off it already knows them. New events: `tool-suspended`,
`tool-resumed`. New option: `toolResumeData`, keyed by `toolCallId`.

`createAskUserTool()` and `createSubmitPlanTool()` reproduce Mastra's contracts
verbatim where it matters — the input schemas, the resume shapes, and all three
`submit_plan` return strings, because the *wording* is load-bearing (the third tells
the model to **wait** rather than invent revisions to a plan nobody commented on).

Only two of Mastra's six built-ins. The other four (`task_write`, `task_update`,
`task_complete`, `task_check`) are a todo-list mechanism belonging to a different
product, and putting one customer's task model in a published package is the thing
`@astracollab/agents` exists to prevent.

### The AI SDK has no suspension primitive — and three findings that shaped the design

Found by trying the obvious thing, all three of which fail **silently**:

1. **A synthetic `tool-result` does not resume anything.** Any result for a
   `toolCallId` removes it from the set of calls needing one, so the tool is never
   re-executed. The run completes, the model gets a result, nothing ever saw the
   answer.
2. **A `tool-approval-response` does.** So a parked call is recorded as a
   `tool-approval-request` with a **derived** id, `suspension-<toolCallId>` — derived
   rather than generated so a caller resuming from a *persisted* transcript does not
   have to have saved an id, and a resume assembled twice still matches.
3. **Resumed results are not in `response.messages`.** The SDK sends them to the model
   but omits them from the response, so a caller persisting `result.messages` lost
   every answer a suspended tool produced — the stored history showed a question with
   no reply, and the next turn's model asked again. The harness now writes them back
   from the stream, which is the only place they exist.

The boundary that distinguishes them is ordering: resumed results arrive **before**
the first `start-step`, in-step results after. Without it every in-step result is
double-recorded.

### What Mastra's built-ins get right, and one bug in the current coordinator

Verified against `@mastra/core@1.74.0`, not from docs:

- `ask_user` suspends as `tool_suspended`. The current coordinator handles that
  correctly (`workspace-assistant-harness-respond-coordinator.server.ts:142`).
- **`plan_approval_required` and `ask_question` do not exist in Mastra at all.** They
  are pre-`AgentController` legacy branches in the app's own bridge. They cannot fire.
- **`submit_plan` never fires `tool_approval_required`** — it is a `tool_suspended`
  too, so that branch (line 151) is dead code.
- **A live bug:** that dead branch reads the plan from the tool's `args`
  (`args.plan`, `args.title`). `submit_plan`'s input is `{ path }` and nothing else, so
  the branch can only ever produce an empty plan and a hardcoded `"Implementation Plan"`
  title. Mastra's own doc comment says hosts read the file at `suspendPayload.path`.
  Fixed in the new tool by taking the path only.

### Deliberately not built

**`autoResumeSuspendedTools`** — Mastra's option that lets the next natural user
message resume a parked tool instead of requiring a form. Highest leverage per line for
a chat product, and worth adding when the client wires this up.

**Storage-backed `listSuspendedRuns`.** Mastra persists a snapshot per parked run so
resume survives a cold start; the current coordinator's `Map` does not. NAH needs no
equivalent — the transcript *is* the persistence, which is most of why this was easier
here than it looks. Worth noting because that `Map` is the single biggest liability in
the current implementation.

---

## 9. Memory: the researched plan

Researched rather than guessed. The recommendation is **(e)**: keep Mastra's store as a
read-only source while writing to a new NAH-native one, and add `cogmemory`'s prompt
context — **not** PgVector parity, which the research ranks last.

### The reframe

The problem users notice ("the assistant forgot") is mostly **not** a retrieval
problem. It is a *durability* problem, and NAH's compaction is aimed at the wrong
schema for this app: `compaction.ts` keeps a **coding-agent** ledger — file paths,
command exit codes, acceptance checks. It has nothing for a B2B workspace assistant.
When a 40-turn ticket thread compacts at 120k tokens, what survives is a summary
written by a prompt asking for "decisions made, files read/edited, commands run" —
which says nothing about *this org's billing contact prefers monthly invoicing*. No
amount of vector search fixes that.

### What each system already does

**Mastra memory is not one thing** — it is four processors auto-injected into the
pipeline, and two details matter here:

- **`lastMessages` defaults to 10 *stored messages*** (tool calls and results
  included), not turns, and the window **slides every request**, which breaks the
  provider prompt cache. Mastra's own docs now steer long threads away from it toward
  `messageHistory.maxTokens`.
- **`MessageWindow` / `SummarizationMessageWindowProcessor` / `TokenWindow` are
  historical.** `TokenWindow` does not exist; token budgeting is
  `messageHistory.maxTokens`. Don't design against names from older docs.
- Memory is **reloaded per turn** — no live session. Every turn: one `listMessages`,
  one query embed, one vector query, one model call, then `saveMessages` with
  embeddings.

**NAH already covers the *bounded* context problem well** — mid-run compaction,
signature-safe tool-output elision, cache-aware retention with a sacred stable prefix,
JSONL session store, and `sessionUpdate` for append-vs-replace. Verified in
`compaction.ts`, `prune.ts`, `cache.ts`, `session.ts`, `types.ts`.

**NAH genuinely lacks**: cross-turn recall, a durable per-user/per-org profile, and a
store *interface* (`createJsonlSessionStore` is a filesystem store, not an
interface).

**`cogmemory` is already a NAH dependency** (`"cogmemory": "workspace:^"`) and is
**lexical, not vector** — verified directly: `relevance.ts` is token-overlap scoring,
and the one `embedding?: number[]` field in `types.ts:72` is documented "empty array if
embedding disabled" and is populated by nothing in `src/cognitive/`. It already has
`getPromptContext(currentUserMessage?)` (token-budgeted L0/L1 injection, deterministic,
no model call) and `search(query)` (the same overlap ranking).

### The phases

| Phase | What | Why this order |
|---|---|---|
| **0** | Read history read-only via the existing `createMastraSessionStore`; write to a **new** store | Zero perceived regression: every existing thread reads its full history on day one. Two stores, one frozen and read-only, so there is no dual-write ambiguity. |
| **1** | `memory.getPromptContext(userMessage)` into the system prompt; `runTurn` after | This is where "it remembered our convention" comes from. ~1ms, ~0 added TTFT, no embedding latency. |
| **2** | `MemorySource` seam — `load(ctx)` / `save(ctx, update)` | Only if evals show gaps. |
| **3** | Lexical/BM25 retrieval *inside the existing Zero DB* | `cogmemory` ships the primitives. No new infrastructure. |
| — | pgvector / Observational Memory | **Never, on current evidence.** |

### Why PgVector is last, not first

1. **The data is already in Postgres/Zero.** 96 tools query it. A vector index over
   conversation messages duplicates data you can *filter* with SQL — and for recalls
   like "ticket 4471" or "the Acme org thread", structured metadata filters beat
   cosine similarity outright.
2. **Context rot.** Focused prompts beat full prompts across every model family
   tested; topically-related distractors are exactly what degrades reasoning. PgVector
   *adds* context permanently, on the critical path of the first token. NAH's
   `prune.ts` and compaction both *remove* context — the opposite trade.
3. **Embedding cost is negligible; latency is not.** `text-embedding-3-small` is
   $0.02/1M tokens — about $0.00005 per turn. Mastra blocks the first token on a
   query embed every turn. If embeddings ever happen: on turn completion, async
   *after* `sessionUpdate`, failures swallowed and counted.

### Where the abstraction belongs — **not NAH core**

`session-manager.ts` already states the doctrine: *"This never stores messages — a
caller passes them per turn from whatever store it uses, so the manager cannot become
a second, competing source of truth."* `@astracollab/agents/README.md` repeats it.

Put `MemorySource` in `@astracollab/agents` (or the app). NAH is a published package;
a memory interface there is a semver commitment forever. Tenant scoping, retention
and isolation are product facts NAH cannot know — Mastra's own docs warn *"the memory
system doesn't enforce access control."* And `cogmemory` is already deliberately kept
outside NAH's source and re-exported only for back-compat.

**Callback, not a first-class NAH concept** — and specifically **not `prepareStep`**,
which runs per *step*, so retrieval would fire per step and burn a query each time.
The seam already exists and is named: `HarnessRunOptions.messages` in,
`sessionUpdate(...)` out. NAH is ignorant of *where memory lives*, which is exactly
right for a harness.

### Migration

Unusually well set up: `runRowMigration` already exists in `@astracollab/ai`, with
deterministic ids, shape-based row detection, and a report you must read before
writing. Requirements it already meets, worth preserving:

- **deterministic ids** — a thread is rewritten every turn, so a random id accumulates
  duplicate rows instead of replacing them;
- **shape-based detection**, not a flag column — a flag needs a migration and a
  backfill, and either can be half-done;
- **read `report.droppedMessages` before writing.**

Migrate **per thread, lazily, on first NAH touch** — no big-bang backfill, no
dual-write window, and an untouched thread still reads from Mastra.

### Making memory failures non-fatal

Never throw out of `save` (a failed write is a degraded next turn) and never out of
`load` (fall back to the last known-good transcript and answer anyway). Budget the
whole call — `cogmemory` measures 2.9ms build / 5.0ms recall, so a ~150ms ceiling with
degradation to last-N is generous. Circuit-break after N consecutive failures.
`cogmemory`'s `runTurn` already returns `learningSkipped` plus a reason — **surface
that in telemetry**, because a silent skip is indistinguishable from a working one
until the thing you taught it never comes back.

### `cogmemory` entry points — corrected, and fixed

**Correction first, because the earlier claim in this file was wrong.** It said
`cogmemory` "declares no dependencies at all". It does: `ofetch` is a **required peer**
(`^1.4.1`), and npm auto-installs it — verified by installing `cogmemory` into an empty
project and importing it successfully with no `ofetch` directory created. A published
`not-another-harness` also imports fine with no `ofetch` present, because vite inlines
`cogmemory` (and therefore `ofetch`) into NAH's bundle.

**The real defect, and it is still real.** The root entry's `import { ofetch }` is
top-level, and a top-level import of a module you never call still throws. So any
consumer using the **in-process engine** — which makes zero network calls — needed
`ofetch` resolvable, and did not get it:

- pnpm workspaces: `ERR_MODULE_NOT_FOUND`, because an undeclared or unhoisted package
  does not resolve and npm's automatic peer installation does not apply. Reproduced
  in this monorepo: `import("cogmemory")` from `packages/agents` fails this way.

Fixed by adding a third entry, following the `./arbiter` precedent that already
exists for exactly this reason:

```ts
import { CognitiveMemory } from "cogmemory/engine"   // no ofetch, no ai, no zod
import { createClient } from "cogmemory"             // needs ofetch
```

`cogmemory/engine`'s bundle contains **zero** `ofetch` references (the main entry keeps
its two), and `ofetch` is now an **optional** peer so nothing warns about it either.
Verified both ways in a directory with no `ofetch` at all: root entry fails,
`cogmemory/engine` works, ESM and CJS.

**Not republished yet** — `cogmemory@0.0.1-beta.4` is needed before the client can use
the engine entry point. Until then the client gets the engine transitively through
NAH's bundle, which is why nothing is broken today.

### Two runtime requirements the engine imposes

Both found by driving a real `CognitiveMemory`, not by reading it — and both would
have been invisible to a stub:

- **`postTurnAsync` must be called as a method.** The engine is a class, so
  `const learn = memory.postTurnAsync; learn(turn)` runs it with `this` undefined and
  dies inside on `this.stats`, which reports as a learn failure — true, and useless,
  because the wiring was correct.
- **`loadSnapshot(null)` throws.** It reads `snapshot.l0` immediately, so a brand-new
  thread, where the store legitimately has nothing, breaks memory on its *first*
  turn. Guarded, with a regression test whose stub throws on null exactly as the real
  engine does — a permissive stub is what let this through the first time.

### Plain project facts: covered by deterministic rules, but only via the service

Correction to an earlier claim in this file: `cogmemory` **does** have deterministic
extraction, and it covers the case I said it missed. `extractDeterministic`
(`src/cognitive/rules.ts`) captures URLs, stated requirements, and **"X is Y"
assignments** — "Billing contact is ops@acme.test" extracts without any model.

The nuance that matters is *where it runs*:

- **The bare `CognitiveMemory` engine does not call it.** `postTurnAsync` tries a
  model-backed `extract` and otherwise falls back to the much narrower regex at
  `memory.ts:857`, which matches requirements only. Embedded naively, plain
  assignments are silently lost — no error, no context, no recall.
- **`extractDeterministic` is exported and never called anywhere in the `cogmemory`
  package** (`grep` finds only the two re-export lines). Its only caller is the
  service, at
  `apps/cognitive-memory/src/server/engine/memory-engine.ts:681`.
- **The service runs rules first and the model on top**, so a plainly-stated fact
  survives a model that refuses or hedges. It also skips extraction on questions,
  which stops the assistant's own answers being stored back as memories.

So the client's decision is **embed vs. talk to the service**, not "with or without an
extractor". Recommend the service: multi-tenant, persists state, already deployed, and
gets rules-plus-model without the caller wiring anything. `CognitiveMemoryLike` in
`@astracollab/agents` fits either, since it is structural — an adapter over the
service's `Cogmem` client satisfies it unchanged.

### Two things to check before starting

- **Which `Memory` options production actually sets** — the client's Mastra code is
  not in this git history. If `semanticRecall` was on, phase 3 becomes "turn off a
  vector index"; if it was off, there is nothing to migrate and phase 0 is even easier.
- **Whether pgvector data exists** to migrate or leave behind.

### Corrections to earlier assumptions in this file

- "Cognitive memory is deterministic lexical, not vector" — **correct**, and now
  verified rather than assumed.
- Mastra memory as "PgVector + `lastMessages` + semantic recall" — **incomplete**.
  `Observational Memory` is Mastra's current answer for long threads and `TokenWindow`
  does not exist; see the processor notes above.
