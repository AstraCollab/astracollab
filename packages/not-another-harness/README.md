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

`askUserToApprove` is supplied by your application. The built-in `edit`, `write`, and `bash` tools call it before performing a mutation. If you omit `approveToolCall`, those tools are allowed; connect the callback to your app’s approval policy when running against untrusted tasks.

## What the runtime provides

- `runAgent` performs one model round trip per step and emits typed run, step, text, tool-call, tool-result, compaction, finish, and error events.
- `createCodingTools` provides capped `read`, `list`, `grep`, `glob`, `edit`, `write`, and optional `bash` tools. Existing files are read before `edit` or `write` by default.
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

- `not-another-harness`: agent loop, orchestrator, tools, prompt builder, caps, compaction, session store, CognitiveMemory, and types.
- `not-another-harness/node`: local Node.js workspace environment.

## Develop in this monorepo

```sh
pnpm install
pnpm --filter not-another-harness build
pnpm --filter not-another-harness lint
pnpm --filter not-another-harness test
```
