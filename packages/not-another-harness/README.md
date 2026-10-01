# Not Another Harness

`@astracollab/not-another-harness` is a small, explicit coding-agent runtime built on the Vercel AI SDK. It owns the agent loop, streamed events, token and step budgets, and transcript compaction; you provide the model and decide how tools are approved and displayed.

## Install

```sh
npm install @astracollab/not-another-harness ai zod
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
} from "@astracollab/not-another-harness";
import { createNodeEnvironment } from "@astracollab/not-another-harness/node";

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
  maxTokens: 120_000,
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

Every step re-sends the transcript, so the system prompt, tool definitions and all earlier turns are re-billed on each call. Set `cacheProvider` and the runtime attaches Anthropic-style `cacheControl` breakpoints to the tool definitions and the system prompt, so the repeated prefix is read back at a fraction of the price.

```ts
const run = runAgent({ model, prompt, system, tools, cacheProvider: "anthropic", cacheTtl: "5m" });
```

`cacheProvider` is opt-in rather than detected from the model, because a marker sent to a provider that ignores it is wasted work at best. It applies to `anthropic` and `openrouter`.

This only *marks* the prefix. It never rewrites earlier content, which matters: editing a prior `tool_result` invalidates the thinking-block signatures Anthropic binds to that prefix, and hard-fails the request.

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

## Budgets and compaction

```ts
const run = runAgent({
  model,
  prompt,
  system,
  tools,
  maxSteps: 32,             // default: 32
  maxTokens: 400_000,       // default; 0 disables the cumulative cap
  maxOutputTokens: 8_192,   // per model response
  compactAtTokens: 120_000, // compact when one request reaches this
  compactKeepRecent: 6,
  compaction: "model",     // "model" | "truncate" | "off"
  messages: previousMessages,
  abortSignal: controller.signal,
});
```

`maxTokens` is a spend budget: it accumulates across the whole run, so it stops a run that is over-consuming even when the context is small.

`compactAtTokens` is a *context* budget, and the two are deliberately different. Because every step re-sends the whole transcript, cumulative usage roughly multiplies the real context size — triggering compaction off it would compact healthy runs. Compaction instead compares the size of the most recent request (the provider's own reported input count, or an estimate when usage is missing) against `compactAtTokens`. It runs only when a step requested tools, and only when there is a middle section to summarize.

Compaction keeps the original task message plus the most recent messages. The verbatim tail is extended backwards when necessary so a `tool` result is never separated from the `tool_call` that produced it — an orphaned result makes the transcript unsendable and ends the run.

The result includes the final transcript, stop reason, step count, usage totals, and number of compactions. Usage is marked estimated if the provider does not return token counts.

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
- **A delivered message grants a fresh step window**, so `maxSteps` cannot silently drop something a human deliberately sent.
- **Queued messages survive `interrupt()`**, so the host can replay them. `steer()`/`followUp()` return `false` once the run has settled rather than accepting input that would be lost.

Events: `user-message` fires twice per message — `phase: "queued"` when accepted and `phase: "delivered"` when it actually enters the transcript. Render a pending chip on the first and clear it on the second.

## Cognitive Memory Cache

`@astracollab/not-another-harness` includes an intelligent 4-tier cache layer (`CognitiveMemory`):
- **L0 (Registers)**: Always injected into the prompt. Stores the agent's proprioceptive self-model (domains, reliability scores, failure pattern guardrails) and active knowledge tensions (contradictions).
- **L1 (Hot Cache)**: Pre-staged prompt context prepared asynchronously at the end of the previous turn.
- **L2 (Warm Store)**: Indexed memories ready for promotion by the Arbiter.
- **L3 (Cold Archive)**: Persistent memory store.
- **Fast Heuristic Gate**: Sub-5ms regex scanner detecting immediate user corrections/contradictions without blocking streaming.
- **Zero Added TTFT**: Memory arbitration executes asynchronously post-turn; prompt context concatenation takes `<1ms`.

```ts
import { CognitiveMemory, createModelArbiter } from "@astracollab/not-another-harness";

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

- `@astracollab/not-another-harness`: agent loop, tools, prompt builder, caps, compaction, session store, CognitiveMemory, and types.
- `@astracollab/not-another-harness/node`: local Node.js workspace environment.

## Develop in this monorepo

```sh
pnpm install
pnpm --filter @astracollab/not-another-harness build
pnpm --filter @astracollab/not-another-harness lint
pnpm --filter @astracollab/not-another-harness test
```
