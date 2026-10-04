# Not Another Harness

`not-another-harness` is a small, explicit coding-agent runtime built on the Vercel AI SDK. It owns the agent loop, streamed events, spend and context budgets, prompt caching, and transcript compaction; you provide the model and decide how tools are approved and displayed.

## Install

```sh
npm install not-another-harness ai zod
npm install @ai-sdk/anthropic
```

The runtime targets Node.js 20.6 or newer and supports AI SDK v5 language models.

## Run an agent

```ts
import { createAnthropic } from "@ai-sdk/anthropic";
import {
  buildSystemPrompt,
  createCodingTools,
  runAgent,
} from "not-another-harness";
import { createNodeEnvironment } from "not-another-harness/node";

const cwd = process.cwd();
const model = createAnthropic({
  apiKey: process.env.ANTHROPIC_API_KEY!,
})("claude-sonnet-4-5");

declare function askUserToApprove(toolName: string, input: unknown): Promise<boolean>;

const tools = createCodingTools(createNodeEnvironment(cwd), {
  approveToolCall: async (toolName, input) =>
    askUserToApprove(toolName, input),
});

const run = runAgent({
  model,
  prompt: "Explain how session refresh works in this repository.",
  system: buildSystemPrompt({ cwdLabel: cwd }),
  tools,
  maxSteps: 24,
  rates: { input: 3, output: 15 },
  maxSpendUsd: 2,
});

for await (const event of run.events) {
  if (event.type === "text-delta") process.stdout.write(event.text);
  if (event.type === "tool-call") {
    console.error(`\n${event.toolName}`, event.input);
  }
}

const result = await run.result;
console.error(`\n${result.reason}; ${result.usage.totalTokens} tokens`);
```

`askUserToApprove` is supplied by your application. The built-in `edit`, `write`, `bash`, and `web_fetch` tools call it before they run. If you omit `approveToolCall`, those tools are allowed; connect the callback to your app’s approval policy when running against untrusted tasks.

`web_fetch` is in that list for a different reason than the other three. They change something, so the question is "may I change this". It changes nothing, and asks anyway, because the question it raises is another one: a fetched page is untrusted text that lands in the context, and a URL assembled out of something just read out of the repository is a way to send that repository to somebody. Key your approval on the URL and "allow this exact call" becomes a scope that means something on a tool called with a new URL each time.

## What the runtime provides

- `runAgent` performs one model round trip per step and emits typed run, step, text, tool-call, tool-result, compaction, finish, and error events.
- `createCodingTools` provides capped `read`, `list`, `grep`, `glob`, `edit`, `write`, `web_fetch`, and optional `bash` tools. Existing files are read before `edit` or `write` by default.
- `buildSystemPrompt` creates a concise coding-agent prompt and can include project context files and extra constraints.
- `compactMessages` and the run options support model-based summarization, lossy truncation, or disabled compaction.
- `createJsonlSessionStore` persists messages and branches as JSONL. The CLI uses this store for resumable sessions.
- `Orchestrator` runs bounded subtasks as isolated child agents and returns their work as a reviewable diff.
- `createNodeEnvironment(root)` provides local filesystem and shell access rooted at a workspace directory, plus optional snapshots and restore operations.

The Node environment is a workspace adapter, not an operating-system sandbox. In particular, shell commands can have effects beyond files the adapter can snapshot. Apply your own process, network, and approval restrictions where required.

## Orienting before reading

`outline` maps a source tree to top-level signatures — `file:line  signature` — with no file bodies. It exists because agents tend to read whole files when nothing tells them what is inside, and one read of 250 lines is replayed on every later step.

```
outline {}
outline { path: "src/auth", query: "validate token" }
```

Matches are ranked to `query`, the result is capped, and `withOutline: false` removes the tool. It is deliberately a *production-time* saving rather than a history edit: rewriting an earlier `tool_result` invalidates the thinking-block signatures Anthropic binds to that prefix, and the SDK sends reasoning back by default, so trimming history after the fact is not available.

Measured on a "find the module exporting runEverything" task over ten modules: one targeted read either way, and the run with `outline` available cost slightly more (6.8k vs 5.8k) because the agent never needed it. It earns its place on tasks that require orientation across a wider tree, not on ones a single grep answers.

## Finding files

`glob` is the discovery primitive — it answers "where does this kind of file live" without walking the tree level by level. It is registered automatically whenever the environment implements `ToolEnvironment.glob` (the Node environment does).

```
glob { pattern: "**/page.tsx" }                     # every page component
glob { pattern: "apps/*/src/**/*.tsx" }             # one level of fan-out
glob { pattern: "**/*.{test,spec}.ts" }             # brace alternation
glob { pattern: "*.ts", path: "src", includeHidden: true }
```

`grep` accepts a glob in `path` as well (`grep { pattern: "DocsShell", path: "apps/nah/**/*.tsx" }`), which is usually the fastest way to find the code that references something. Both tools skip `node_modules`, `.git`, and build output; pass `includeHidden` to opt back into dotfiles.

## Fetching a URL

`web_fetch` retrieves a URL and converts it before returning: HTML becomes markdown by default, or plain text, or the raw markup.

```
web_fetch { url: "https://example.com/docs/install" }
web_fetch { url: "https://example.com/changelog", format: "text" }
web_fetch { url: "https://api.example.com/v1/items", timeoutSeconds: 60 }
```

The conversion is the reason it exists rather than `curl` in `bash`. A documentation page is mostly `<nav>`, `<script>`, and inline CSS, and a shell fetch spends a step and a round trip to decode that into structure. The `Accept` header is negotiated per format too, so a host that serves markdown directly is never round-tripped through HTML at all.

Three bounds, all deliberate: a 5MB download ceiling counted *while streaming* (a chunked response sends no `content-length`, so a header check alone is advisory rather than real), a 30s default timeout rising to 120s, and a cap on the converted page. The cap notice tells the agent to ask for a more specific URL and **not** to fetch again — a web page cannot be paged the way a file can, and a notice that suggests a retry sends the agent round the same loop paying twice, which is the regression `bash` already had here.

A repeat of the same URL and format is served from memory rather than requested again, with a note saying so: step-scoped de-duplication only collapses identical calls in the *same* step, so the repeat that costs money is the same page fetched four steps later, on a transcript that re-sends itself from there on. Keyed by format as well as URL, because `format: "text"` over an already-fetched page is a different question.

`withWebFetch: false` removes the tool. Pass `fetchImpl` to route or audit egress. Binary responses are named rather than decoded, since the tool returns text and base64 of a PDF costs a step to diagnose. There is no web *search* — a model without a URL cannot use this.

Borrowed from opencode's `webfetch`: the per-format `Accept`, and a browser `User-Agent` with an honest retry. Docs hosts sit behind bot protection that challenges anything without one, and the retry matters more than it looks — the first request claims to be a browser while presenting a Node TLS fingerprint, which is the mismatch the challenge detects, so a 403 carrying `cf-mitigated: challenge` is answered by asking again as `nah`.

### Dependencies

`turndown` is a `dependencies` entry but stays **external** to the bundle, which is unusual for a non-peer dependency and deliberate. It pulls `@mixmark-io/domino`, a full DOM implementation, and inlining it took `dist/index.js` from 276KB to 789KB — charged to every consumer who bundles this package, for one optional tool. Node resolves it at runtime instead, and a bundling consumer can dedupe it against their own copy. `htmlparser2` is the opposite case and is inlined: it is ESM-only, so the CommonJS build could not `require()` it, and it brings no DOM of its own.

## Prompt caching

Every step re-sends the transcript, so the system prompt, tool definitions and all earlier turns are re-billed on each call. Set `cacheProvider` and the runtime marks the cacheable prefix, so the repeated part is read back at a fraction of the price.

```ts
const run = runAgent({ model, prompt, system, tools, cacheProvider: "anthropic", cacheTtl: "1h" });
```

`cacheProvider` is opt-in rather than detected from the model, because a marker sent to a provider that ignores it is wasted work at best. It applies to `anthropic` and `openrouter`.

This only *marks* the prefix. It never rewrites earlier content, which matters: editing a prior `tool_result` invalidates the thinking-block signatures Anthropic binds to that prefix, and hard-fails the request.

### Breakpoints are scarce — spend them on the growing part

Anthropic allows a small fixed number of cache breakpoints per request, and the AI SDK enforces the cap by **silently discarding** the excess. A discarded marker is not an error; it is a full-price re-bill on every step of every run.

So the runtime spends them deliberately:

- **One breakpoint on the last tool definition.** A breakpoint marks a *prefix*, not a block, so marking the final tool caches the entire tool block. Marking all eleven tools of a real session says the same thing eleven times, fits in four slots, and silently re-bills the other seven forever.
- **One request-level breakpoint**, which Anthropic auto-places on the last cacheable block and moves forward as the conversation grows. This is the one that matters: the transcript is the only part that keeps growing, and it is where the compounding cost of a long run lives.

The tail marker has to *move*. A cache read resolves by walking backward from a breakpoint looking for a prefix a previous request wrote, and it only looks back a fixed number of blocks — so a marker pinned to a fixed index in a growing conversation eventually falls out of range and stops matching, with no error to explain why.

### Use `cacheTtl: "1h"` for agent loops

The cache lifetime is measured from the **start** of the request that writes or reads it, not the end of its response. Time spent generating counts against it: a step that streams for four minutes burns four minutes of a five-minute window, so the next request starts cold. 1h writes cost 2x base instead of 1.25x and break even after two reads.

### Bounding the transcript on any provider

```ts
const run = runAgent({ model, prompt, system, tools, pruneToolResults: { keepRecentToolCalls: 6 } });
```

Tool results older than the last few rounds are replaced in place with a note saying how much was removed, so a long run stops paying for output it no longer needs. Only the `value` inside the result changes: the block, its `toolCallId`, its position and the owning `tool-call` all stay put, so the tool_use/tool_result pairing the provider validates is untouched.

Two safety properties:

- **It refuses to run on a transcript containing reasoning.** Rewriting an earlier `tool_result` invalidates the thinking-block signatures Anthropic binds to that prefix, and the SDK sends reasoning back by default. With none present there are no signatures to disturb.
- **It is monotone.** A result is elided once and stays elided, so the prompt prefix does not churn on every request.

Measured over 13 steps reading a 1,200-line file: **347 KB of prompt down to 162 KB, 53% reclaimed (~47k tokens).**

### Server-side context editing

For providers that support it, you can also ask the API to clear old tool results and replace them with placeholders, so a long run does not keep replaying output the agent no longer needs.

```ts
const run = runAgent({
  model, prompt, system, tools,
  cacheProvider: "anthropic",
  contextEditing: {
    triggerTokens: 40_000,
    keepToolUses: 6,
    excludeTools: ["read", "edit", "write"],
  },
});
```

Two things to know:

- **Trigger well below the API's own 100k default.** The cost of a long run is the repeated replay of a growing transcript, so a run can total hundreds of thousands of input tokens while no single request ever approaches the default trigger. Default here is 40k.
- **`excludeTools` pins what the agent needs to remember** — what it read and what it changed. Bulky, re-fetchable output (listings, greps, command output) is what gets cleared.

This runs server-side, so it is not treated as a client edit and thinking-block signatures stay valid. Doing the same trimming locally is what Anthropic documents as invalid for every later thinking block.

## Budgets, compaction, and not stopping half-way

Two questions deserve two answers, and conflating them is what made the old
budget stop healthy runs:

- **"Will the next request fit?"** — `maxContextTokens`, checked against the
  model's window. The answer is *compact*, because a full window is fixable.
- **"Has this run cost too much?"** — `maxSpendUsd`, checked against money.

`maxTokens` used to serve both roles, which is why it behaved as a step counter:
it accumulated across every step, and since each step re-sends the transcript,
400k arrived after roughly thirty steps no matter how little the run had actually
cost. It is now **deprecated and off by default**. See
[docs/long-running-agents.md](docs/long-running-agents.md) for the full reasoning.

```ts
const run = runAgent({
  model, prompt, system, tools,
  rates: { input: 3, output: 15 }, // per-million USD for the model in use
  maxSpendUsd: 5,                // money ceiling — the real safety rail
  maxContextTokens: 180_000,     // the model's window
  compactAtTokens: 120_000,      // context size trigger
});
```

Spend is computed from the **cache-aware** usage breakdown, so a run that reads
its prefix back from cache costs roughly a tenth of the same run without a cache
and is not charged as though it had not. A token budget cannot express that.

When a ceiling is about to end a run, the harness spends one last request on a
handoff — commit what works, update the ledger, state what remains — instead of
cutting the agent off mid-task. It emits a `wrap-up` event first so a UI can show
it as a handoff rather than a failure, and sets `wrappedUp` on the result. The
step is skipped when it would not be affordable, so the harness never overspends
to say goodbye.

## No step ceiling, and what bounds a run instead

**There is no step limit by default.** A turn ends when the model says it is done,
when the context window is full, or when a human interrupts it.

There used to be a default of 32, and it was the wrong kind of limit. It bound
long tasks and ignored short ones — across fifteen recorded turns the median
finished in 15 steps, the longest natural completion was 30, and 20% of turns were
truncated at the cap. A real git merge was cut at 32 having done none of its
verification, and handed off saying it had "run out of budget", which it had not.

Every mature harness agrees. Claude's Agent SDK documents `maxTurns` with a
default of "No limit". opencode is `agent.steps ?? Infinity`. Claude Code's
interactive mode has no turns setting at all.

`maxSteps` still exists, opt-in, for unattended and batch callers who want a bound
and will read the stop reason.

What replaced the ceiling is not a bigger number — it is the thing the ceiling was
guessing at. Two guards, both measuring progress rather than length:

- **`no-progress`** — fifteen consecutive steps without changing anything, having
  just declined to finish. This is the same condition Claude Code uses for its
  goal loop ("no tool use for several turns in a row"). A stuck run stops mutating
  and a working one does not; a step counter cannot tell those apart, which is
  exactly why it kept cutting working runs.
- **A repeated-call warning** — the same tool with the same input three steps
  running, opencode's `DOOM_LOOP_THRESHOLD`. Needed separately, because a loop can
  rewrite the same file on every pass and so never trips a progress signal.

Both share one measurement with the exploration nudge, which fires at seven
non-mutating steps: nudge early, stop late, and no mechanism that only fires on
the failure it was written for.

## Steering a step: `prepareStep` and `toolChoice`

`onStepStart` is a notification. It receives a copy of the transcript and its
return value is discarded, so it can watch a step but not change one — which
matters when the thing you need to change is the tool choice.

```ts
const run = runAgent({
  model, system, prompt, tools,
  // Force an action until the agent has taken one. A model that answers in prose
  // when the task needs the filesystem cannot be corrected any other way.
  prepareStep: ({ stepNumber, steps }) =>
    steps.length === 0 ? { toolChoice: "required" } : {},
});
```

| Option | Overrides |
|---|---|
| `toolChoice` | `"auto"` \| `"none"` \| `"required"` \| `{ type: "tool", toolName }` |
| `temperature` | The run's temperature, for this step |
| `maxOutputTokens` | The step's computed allowance |
| `model` | A different model for this step only |

`toolChoice` on the run applies to every step, and `prepareStep` wins where they
disagree. Left unset, the SDK's own default applies — the harness forwards
nothing rather than pinning `"auto"`.

The context carries `stepNumber`, the transcript as it stands, and `steps`: the
tool calls made in each completed step, as a snapshot. That last one is there
because "require a tool until one has happened" needs to know what already ran
rather than re-reading messages.

Returning nothing leaves the step alone. **Throwing ends the run**, deliberately: a
hook that fails while deciding whether to require a tool would otherwise be
indistinguishable from one that decided not to.

## Ending a run early: `shouldStop`

`maxSteps` and `maxSpendUsd` bound a run generically. Neither can see what a
*particular* agent does when it is lost — verifying git over and over after it has
already edited, calling tools that do not exist, restating "I'm done". That
knowledge belongs to the caller, and without a hook the only way to express it is
to reimplement the loop.

```ts
runAgent({
  ...,
  shouldStop: ({ messages, steps }) => {
    const verdict = evaluateAntiLoop(messages);
    if (verdict.stopped) log.warn(`anti-loop: ${verdict.reason}`);
    return verdict.stopped;
  },
});
```

The context is the same shape `prepareStep` receives — one vocabulary for "change
this step" and "end this run". Callbacks are copies, so a rule cannot rewrite the
run, and a rule that throws ends it as an error rather than quietly not firing.

It reports its own reason: `stopped-by-caller`, because `max-steps` and
`no-progress` each mean something specific and neither is true when a domain rule
fires. Checked at the step boundary, *before* the loop decides the model has
finished — a rule about an agent going in circles has to be able to see a step the
model finished on, and placed after that check it would only ever see steps that
made tool calls, which is where such a rule has nothing to say. Never fires on the
first step, where there is no history to inspect.

`@astracollab/agents` ships `createAntiLoopStop`, which is five such rules for a
coding agent, wired to this.

## Tool execution

A tool's `execute` runs, its result reaches the transcript, and both are visible on
the event stream. `test/tool-execution.test.ts` asserts all three against the mock
provider, so this is covered by the suite rather than by production observation.

The shape that makes it work, and the one worth writing down because it looks like a
type error rather than a runtime one: a tool call's `input` is a **string** in a
*stream* part and an **object** in a *prompt* part. A stream fixture built from the
prompt shape compiles only through a cast, and at runtime the SDK calls `.trim()` on
it:

```
TypeError: toolCall.input.trim is not a function
```

A provider streams a tool call's arguments as JSON text, which is why the SDK calls
`.trim()`. `test/helpers/ai.ts` builds the real sequence — `tool-input-start`,
`tool-input-delta`, `tool-input-end`, then `tool-call` — so a fixture cannot get it
wrong silently.

**A tool that throws is reported, not swallowed.** The SDK puts the failure on a
`tool-error` part rather than on the result, and the loop maps it to a `tool-result`
event with `isError: true` and the same message the model reads:

```ts
{ type: "tool-result", step: 1, toolCallId: "t1", toolName: "grep",
  output: "Error: ENOENT: no such file", isError: true }
```

Every `tool-call` therefore pairs with exactly one `tool-result`, matched by
`toolCallId`, and `traceRun` marks the tool span `status: "error"`. It is
deliberately *not* mapped onto the `error` event: the SDK hands the failure to the
model as error-text and lets it recover, and a harness that threw would turn one bad
`grep` into a dead run.

## Per-step tool context: `toolsContext`

```ts
runAgent({
  ...,
  tools: { read, write },
  // Keyed by tool name. One slice per tool.
  toolsContext: { read: { actor }, write: { actor } },
});
```

Tools are built **once**, so a value that changes per step cannot be captured in a
closure: a step counter, a deadline, the text of the step so far. This is the
option for those, and a tool reads it from its execution options:

```ts
tool({
  execute: async (input, { context }) => { /* context is this tool's slice */ },
});
```

**The map is keyed by tool name**, which is the SDK's contract rather than a
convenience: `executeToolCall` reads `toolsContext[toolName]` for the call it is
about to run and nothing else. One shared object (`{ actor }` rather than
`{ read: { actor } }`) is not rejected and not warned about — it reads as the context
of a tool named `actor`, so every real tool receives `undefined`. That mistake is
invisible from the outside, which is why the unkeyed shape is pinned in
`test/tool-context.test.ts`.

A tool that declares a `contextSchema` has its slice validated on every call; tools
that declare nothing get the value as-is. The harness rebuilds its tool set three
times (dedupe, read coverage, cache markers) and every wrapper spreads the original,
so the slice survives.

`prepareStep` overrides it **for that step only** — like every other override here,
it does not carry forward, so a counter has to be recomputed from `stepNumber` each
step rather than read off the previous override. A step that overrides nothing falls
back to the run's value.

**For a value fixed for the turn, use a closure.** It is simpler, it cannot be
read by a turn belonging to a different user, and it needs none of this. Reach for
`toolsContext` only for what a closure genuinely cannot hold.

## Asking before a tool runs: `toolApproval`

```ts
runAgent({
  ...,
  tools: { deleteFile, readFile },
  toolApproval: { deleteFile: "user-approval" },
});
```

A destructive tool should not run because a model asked it to. `toolApproval` is the
SDK's own gate, passed through: name a tool `"user-approval"` to hold it for a person,
or give it a function that decides from the call.

```ts
toolApproval: {
  deleteFile: (input) =>
    input.path.startsWith("tmp/") ? "approved" : "user-approval",
},
```

Anything **not named runs unattended**, which is why this defaults to nothing: a
harness cannot know which of its tools are destructive, and a gate that quietly
approved everything would be worse than no gate because it would look deliberate.

### The run stops; it does not wait

A held call **ends the run**, with `reason: "awaiting-approval"` and the calls listed
on `result.pendingApprovals`. This is not a policy choice. The SDK emits no tool
result for a blocked call, so the next request would carry a `tool-call` with no
matching result and be rejected outright with `MissingToolResultsError`. Suspension is
the only valid move.

It is also a distinct reason rather than a reuse of `max-steps`, because the two need
opposite handling: the run is paused, not finished, and a caller that reported a
normal approval prompt to the user as a failure would be wrong about the most
expected event in the system.

No wrap-up step is spent either. Every other hard stop winds down with one final
request; this one must not, because the transcript ends in an unanswered call and that
request would fail rather than tidy up.

### Answering it

Approval is a **round-trip through the transcript**, not an in-flight callback. The
answer is a message part matched by `approvalId`, so the run is resumed by handing the
transcript back with the decision in it:

```ts
const first = await runAgent({ ..., toolApproval }).result;

if (first.reason === "awaiting-approval") {
  await save(first.messages);
  // …the user clicks approve or deny, which may be minutes and a restart later…
  const decisions = Object.fromEntries(
    first.pendingApprovals.map((p) => [p.approvalId, { approved: userSaidYes(p) }]),
  );
  const resumed = runAgent({
    ...,
    toolApproval,                                  // still gated
    messages: appendApprovalResponses(first.messages, decisions),
    prompt: "",                                    // the transcript already has the task
  });
}
```

Three details that are not guessable, each of which fails silently:

- **The answer must be in the last message.** The SDK reads approval responses from
  `messages.at(-1)` and only if it is a `tool` message. So a resumed run passes
  `prompt: ""` — the harness detects a transcript that ends in a decision and does not
  append the prompt, which would push the answer out of that position. Append it
  anyway and the approved tool never runs, and the run reports success having done
  nothing, because a model asked to continue will happily produce text.
- **The gate can stay configured.** A call that already has a decision in the
  transcript is executed directly, not asked about twice. The `prompt: ""` in the
  snippet is not a way to switch the gate off.
- **Use `appendApprovalResponses`** rather than assembling the part by hand. It matches
  against the requests actually open in the transcript and ignores decisions for calls
  that are already answered, so a resumed run cannot re-ask a question the user has
  already answered, or flip one the SDK has already acted on.

### Events

| Event | Means |
|---|---|
| `tool-approval-request` | A tool is waiting. `isAutomatic: false` means a person must answer; `true` means the gate decided by itself and nothing is waiting. |
| `tool-approval-response` | A decision reached the SDK — `approved` true or false. |
| `tool-result` with `isError: true` | A denied call. Emitted so every `tool-call` still pairs with exactly one result; without it a refusal is the one call in the run with no outcome at all. |

`traceRun` closes a held call's span with `nah.tool.awaiting_approval` and leaves its
status unset, so a trace distinguishes *waiting on a person* from *crashed* and from
*still running*.

## Asking the user mid-run: `ask_user` and `submit_plan`

```ts
import { createAskUserTool, createSubmitPlanTool, suspensionResumeMessage } from "not-another-harness";

const { events, result } = runAgent({
  ...,
  tools: { ask_user: createAskUserTool(), submit_plan: createSubmitPlanTool() },
});

// A tool that needs something only a person has:
for await (const event of run.events) {
  if (event.type === "tool-suspended") {
    // { toolCallId, toolName, payload } — render the question, collect an answer
  }
}
```

A tool that cannot finish without a person calls `suspend(payload)` from its
execution context. The run stops with `reason: "suspended"` and the calls listed on
`result.pendingSuspensions`. Resume by handing the transcript back:

```ts
const { messages, pendingSuspensions } = result;
const answers = { [pendingSuspensions[0].toolCallId]: "staging" };

const resumed = runAgent({
  ...,
  messages: [...messages, suspensionResumeMessage(pendingSuspensions, answers)],
  toolResumeData: answers,   // keyed by toolCallId
  prompt: "",                // the transcript already has the task
});
```

### Why the run has to stop

A parked call has no result, so the next request would carry a `tool-call` with nothing
after it and be rejected. Same constraint as a held approval, and for the same reason.

Distinct from `awaiting-approval` because the two are answered differently: approval is
a boolean permission question and the tool has not run; a suspension carries an
**open-ended typed value** the tool defines, and the tool *has* run — far enough to
decide it needed something. Answering one with the other leaves a tool holding a
boolean where it expected text.

### Why `suspend` throws, and the tool re-runs

`suspend()` throws rather than returning a sentinel, because a tool that carries on
past it has already answered a question nobody was asked. On resume the tool is
**re-run from the top**, statelessly: it checks `resumeData` first, returns it, and
suspends again otherwise. There is no coroutine and no parked stack frame.

**So a suspended tool must do no work before suspending — that work runs twice.**

### The transport, since the SDK has no such primitive

The AI SDK has no suspension at all. Two SDK rules decide the shape, and both were
found by trying the obvious thing:

- **A `tool-result` marks the call finished**, so a synthetic result means the tool is
  never re-executed and the resume silently does nothing. It looks successful.
- **A `tool-approval-response` releases the call.** So the harness records a parked
  call as a `tool-approval-request` with a derived id (`suspension-<toolCallId>`), and
  `suspensionResumeMessage` answers it with the matching response.

Two consequences worth knowing:

- The id is **derived**, not generated, so a caller resuming from a persisted
  transcript does not have to have saved it — and a resume assembled twice still
  matches.
- `toolResumeData` and the resume message **must agree**: the message makes the SDK
  re-execute, the option puts the value in the tool's hands. `suspensionResumeMessage`
  exists so a caller cannot build one without the other.

Resumed results are written into the transcript by the harness. The SDK sends them to
the model but omits them from `response.messages`, so without that the persisted history
would show a question with no answer — and the next turn's model, seeing no reply,
would ask again.

### Only two of Mastra's six built-ins

Mastra injects six (`ask_user`, `submit_plan`, `task_write`, `task_update`,
`task_complete`, `task_check`). Only the two that are the agent's own conversation with
a person are reproduced; the other four are a todo-list mechanism belonging to a
different product. Enabling them is a caller's decision — `createInteractiveTools()`
returns both as a plain tool set, the same shape Mastra's `disableBuiltinTools` takes.

`submit_plan` takes the plan's **path**, never its body, and the host reads the file.
That is deliberate rather than a simplification: several plans can exist over a
session, and a body inside a tool call is what makes them ambiguous.

## Warm sessions: `createSessionManager`

The runtime half of what Mastra's `Harness` gave `@astracollab/client`: a keyed
registry that keeps a session's expensive resources alive across turns, hands the
same one back, and eventually reclaims it.

```ts
const sessions = createSessionManager({
  create: (key) => buildSession(key),   // a run handle, a resolved model, a sandbox
  idleTtlMs: 5 * 60_000,
  maxSessions: 100,
});

await sessions.ensure(chatId);   // same resource back, every time
```

Generic over the resource on purpose: the same manager keeps a `HarnessRun` warm,
or a resolved model plus sandbox, or whatever a caller pays to build once per
conversation. It stores **no conversation state** — a caller passes `messages` per
turn from its own store, so this cannot become a second source of truth for a
transcript.

Two failures it exists to prevent, both expensive: building twice means two
sandboxes and two Postgres pools, and building fresh every time means the warm
reuse never existed. Concurrent cold callers therefore share one construction,
and `ensure()` returns the same object by identity.

Idle sessions are reclaimed on a background timer, `unref`ed so a manager cannot
keep a process alive. The interval defaults to a quarter of `idleTtlMs` capped at
30s, so the TTL you set is the number that actually holds. `stopSweeping()` turns
it off; `sweepIntervalMs: 0` opts out.

## Persisting a run: `sessionUpdate`

`result.messages` is the transcript **after** the run, which after a compaction is
a summary plus a recent tail — not an append-only delta. It shares no reliable
prefix with the input, so `result.messages.slice(before)` is not "the new
messages". It silently returns the wrong ones, and a store that appends them loses
the middle of a conversation without erroring.

```ts
const update = sessionUpdate(before, result);
if (update.mode === "replace") await store.replace(update.messages);
else await store.append(update.messages);
```

`replace` is not an error condition — it is what compaction means. The decision
lives in one place so no caller re-derives it and gets it wrong.

## Budgets and compaction

```ts
const run = runAgent({
  model,
  prompt,
  system,
  tools,
  maxSteps: Infinity,        // default: no ceiling — opt in for unattended runs
  maxSpendUsd: 5,            // cumulative $ ceiling; needs `rates`
  rates: { input: 3, output: 15 },
  maxContextTokens: 180_000, // per-request ceiling vs the model's window
  maxOutputTokens: 8_192,    // per model response
  compactAtTokens: 120_000,  // compact when one request reaches this
  compactKeepRecent: 6,
  compaction: "model",      // "model" | "truncate" | "off"
  wrapUpOnLimit: true,      // default: hand off cleanly before a hard stop
  messages: previousMessages,
  abortSignal: controller.signal,
});
```

`compactAtTokens` is a *context* budget, deliberately separate from spend. Because every step re-sends the whole transcript, cumulative usage roughly multiplies the real context size — triggering compaction off it would compact healthy runs. Compaction instead compares the size of the most recent request against `compactAtTokens`.

That size is the **whole** request: cached reads are added to fresh input. Providers report cache reads separately from `input_tokens`, so reading `inputTokens` alone made the figure collapse toward the newest few blocks once caching worked, and `compactAtTokens` silently stopped firing exactly when compaction mattered most.

Compaction keeps the original task message plus the most recent messages. The verbatim tail is extended backwards when necessary so a `tool` result is never separated from the `tool_call` that produced it — an orphaned result makes the transcript unsendable and ends the run.

Set `compactAtTokens` **high** relative to the window. Compaction is lossy, and measured work on constraint decay found violations rising from 0% to 30% after a single compaction; compact late, and keep cheap tool-output elision underneath it.

The result includes the final transcript, stop reason, step count, usage totals, spend in USD, and number of compactions. Usage is marked estimated if the provider does not return token counts.

## Steering a running agent

A run is steerable. You can send a new message while the agent is still working instead of waiting for it to finish:

```ts
const run = runAgent({ model, prompt, system, tools });

// Fires on the next step boundary; the in-flight model call is never cut off.
run.steer("actually use TypeScript, not JavaScript");

// Delivered only if the run would otherwise finish — for "also, once you're done…".
run.followUp("then update the changelog");

run.interrupt();            // abort now: cuts off the model call AND running tools
run.pending();              // { steer: [...], followUp: [...] } for a UI indicator
```

Semantics, matching Pi and opencode:

- **Delivery is at step boundaries.** A steer lands after the current step's tool calls settle and before the next model request is assembled, so it is never injected into a request that is already streaming. This is deliberate — interrupting mid-token loses the partial answer.
- **Steers do not abort.** `steer()` never cuts off the model call in flight. Use `interrupt()` for that.
- **Steers reach the model as plain user messages**, indistinguishable from any other user turn. Nothing marks them, so the model simply sees them in history.
- **Steers jump ahead of follow-ups**, and each keeps its order.
- **A pending message prevents the run from ending.** If the model produces its final answer while a follow-up is queued, the run continues instead of discarding it.
- **A delivered message grants a fresh step window**, so an explicit `maxSteps` cannot silently drop something a human deliberately sent.
- **Queued messages survive `interrupt()`**, so the host can replay them. `steer()`/`followUp()` return `false` once the run has settled rather than accepting input that would be lost.

Events: `user-message` fires twice per message — `phase: "queued"` when accepted and `phase: "delivered"` when it actually enters the transcript. Render a pending chip on the first and clear it on the second.

## Delegating to sub-agents: `Orchestrator`

`runAgent` is one agent in one workspace. `Orchestrator` is the parent-and-children
workflow: the parent hands a bounded subtask to a child, the child works in a
**fresh transcript against an isolated workspace**, and its work comes back as a
reviewable artifact.

```ts
import {
  createCodingTools,
  createGitWorktreeIsolation,
  Orchestrator,
  formatSubtaskReport,
  orchestratorPrompt,
} from "not-another-harness";
import { createNodeEnvironment } from "not-another-harness/node";

const orchestrator = new Orchestrator({
  model,
  system: `${buildSystemPrompt({ cwdLabel: cwd })}\n\n${orchestratorPrompt({ concurrency: 3 })}`,
  isolation: createGitWorktreeIsolation({ cwd }),
  createTools: (root) => createCodingTools(createNodeEnvironment(root), { approveToolCall }),
  maxConcurrency: 3,
  maxSteps: 20,
  onUsage: (usage) => session.rollSpend(usage), // child spend is real spend
});

// Fan out, or await one with `orchestrator.run(spec)`.
const results = await orchestrator.runAll([
  { title: "extract the parser", task: "Move parse() out of index.ts into parser.ts. Keep the export." },
  { title: "cover the parser", task: "Add unit tests for parse() edge cases in parser.test.ts." },
]);

for (const result of results) {
  tool_result(formatSubtaskReport(result)); // identity, base, metrics, paths, diff
}
```

Isolation is the point, so it is an interface rather than a default. Three pieces:
`prepare` hands back a root for the child's tools plus the boundary facts it needs;
`collect` returns the artifact a reviewer can act on; `cleanup` releases it.
`createGitWorktreeIsolation` branches a detached worktree from `HEAD`, so a child
cannot see uncommitted parent work and cannot collide with a sibling — and it tells
the child which parent paths are invisible rather than letting it re-implement them.
`sharedWorkspaceIsolation()` is the no-repo fallback.

Three behaviours worth knowing:

- **Saturation throws (`OrchestratorBusyError`) instead of queueing.** A queued child
  starts later than the parent expected and can outlive the run that asked for it.
- **A diff too large to inline retains its workspace** and says so in the report,
  because a truncated diff nobody can open is not a result.
- **A failed child still cleans up and still reports.** `runAll` settles every
  task; one child erroring is not a reason to lose the other children's diffs.

`orchestratorPrompt()` exists because two constraints cannot be discovered from
inside a child: it cannot see uncommitted parent work, and its diff is never applied
for you. Append it to the parent's system prompt.

## Workflows: sub-agent sequences you write once

`Orchestrator` is a *call*: you decide, at the moment you need it, that a piece of
work is independent and hand it off. A **workflow** is the other thing — the part
you already know every time. Which steps, in what order, where they fan out, and
what to do when one of them needs a judgement call.

```ts
import { createStep, createWorkflow, createWorkflowRegistry } from "not-another-harness";
import { z } from "zod";

const collect = createStep({
  id: "collect",
  inputSchema: z.object({ base: z.string() }),
  outputSchema: z.object({ files: z.array(z.string()) }),
  execute: async ({ inputData }) => ({ files: await changedFiles(inputData.base) }),
});

// Needs judgement, so it is a sub-agent rather than a prompt. `delegate` is
// injected by the orchestrator that runs the workflow; a bare `createRun()` on
// a bare workflow has none, and the step has to cope with that.
const review = createStep({
  id: "review",
  execute: async ({ inputData, context }) => {
    const { delegate } = context as WorkflowStepDelegate;
    const child = await delegate({
      title: "review",
      task: `Review these files for bugs:\n${(inputData as any).files.join("\n")}`,
    });
    return child.report;
  },
});

const check = createStep({
  id: "check",
  execute: async ({ inputData }) => runTypecheck(inputData),
});

const reviewChanges = createWorkflow({
  id: "review-changes",
  description: "Review the diff against a base, then typecheck what the fixes changed.",
})
  .then(collect)
  .parallel([review, check])
  .commit();

const registry = createWorkflowRegistry({ "review-changes": reviewChanges });
```

`commit()` is what makes it a workflow rather than a builder — it is where step ids
are checked for uniqueness, because they key the run's results.

**Composition.** `.then` / `.parallel` / `.branch` / `.map` / `.commit`, where
`.parallel` runs its branches concurrently and produces the array of their outputs,
`.branch` takes the first matching condition (`{ otherwise }` for the fallthrough),
and `.map` fans out over an array in the input. A committed workflow nests as a
single `.then(...)` argument, so a three-step review is a reusable unit rather than
three copy-pasted steps.

**Input threading.** When the next step declares an object schema, it is fed the
matching keys of the previous step's output; when none of those keys exist it gets
the previous output whole. The first step always receives the workflow's own input.

**Steps that need a person.** Throw `StepSuspend` and the run stops with
`status: "suspended"` instead of failing. The snapshot is returned, and
`run.resume(resumeData)` continues from that step with earlier steps' outputs
reused rather than recomputed — which is the point, since a step that suspended
usually sat in front of something expensive.

```ts
const run = reviewChanges.createRun();
const first = await run.start({ inputData: { base: "main" } });
if (first.status === "suspended") {
  const done = await run.resume({ resumeData: await askHuman(run.snapshot()) });
}
```

**Watching one run.** `run.start()` resolves at the end; `run.stream()` yields
`step-start` / `step-delta` / `step-finish` events as they happen, which is what a
UI wants. Nesting is depth-capped at 64 and fan-out at 64, so a cycle or an
accidental `.parallel` of a thousand is an error rather than a hang or a thousand
model calls.

`Orchestrator.runWorkflow(workflow, { inputData, onEvent })` is the seam: it puts
`delegate`, `delegateAll` and the resume hooks into every step's context, so the
step above calls a real sub-agent — one that *waits* for a concurrency slot instead
of throwing, because a sequence's own queue is already the orchestrator's.
`orchestrator.pendingWorkflows()` is how a caller finds runs stopped on a question
only it can answer. Workflow steps share the caller's workspace; a sub-agent gets
its own, which is the real difference between nesting a workflow and delegating one.

## Cognitive Memory Cache

`not-another-harness` includes an intelligent 4-tier cache layer (`CognitiveMemory`):
- **L0 (Registers)**: Always injected into the prompt. Stores the agent's per-domain reliability record (scores, failure patterns) and any unresolved contradiction.
- **L1 (Hot Cache)**: Pre-staged prompt context prepared asynchronously at the end of the previous turn.
- **L2 (Warm Store)**: Indexed memories ready for promotion by the Arbiter.
- **L3 (Cold Archive)**: Persistent memory store.
- **Fast Heuristic Gate**: Sub-5ms regex scanner detecting immediate user corrections/contradictions without blocking streaming.
- **Zero Added TTFT**: Memory arbitration executes asynchronously post-turn; prompt context concatenation takes `<1ms`.

```ts
import { CognitiveMemory, createModelArbiter } from "not-another-harness";

const memory = new CognitiveMemory({
  maxL0Tokens: 2000,
  maxL1Tokens: 8000,
  // Optional: supply a fast arbiter model (Gemini Flash, Haiku, GPT-4o-mini)
  arbiter: createModelArbiter({ model: arbiterModel }),
});

// Pre-turn: get context in <1ms (0 added TTFT)
const memoryPrompt = memory.getPromptContext(userPrompt);

// Post-turn: run async arbitration in the background
await memory.postTurnAsync({
  userMessage: userPrompt,
  assistantResponse: replyText,
});
```

## Package exports

- `not-another-harness`: agent loop, orchestrator, workflows, tools, prompt builder, caps, compaction, session store, CognitiveMemory, and types.
- `not-another-harness/node`: local Node.js workspace environment.

## Develop in this monorepo

```sh
pnpm install
pnpm --filter not-another-harness build
pnpm --filter not-another-harness lint
pnpm --filter not-another-harness test
```
