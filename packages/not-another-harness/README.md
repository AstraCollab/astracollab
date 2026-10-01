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

## Finding files

`glob` is the discovery primitive — it answers "where does this kind of file live" without walking the tree level by level. It is registered automatically whenever the environment implements `ToolEnvironment.glob` (the Node environment does).

```
glob { pattern: "**/page.tsx" }                     # every page component
glob { pattern: "apps/*/src/**/*.tsx" }             # one level of fan-out
glob { pattern: "**/*.{test,spec}.ts" }             # brace alternation
glob { pattern: "*.ts", path: "src", includeHidden: true }
```

`grep` accepts a glob in `path` as well (`grep { pattern: "DocsShell", path: "apps/nah/**/*.tsx" }`), which is usually the fastest way to find the code that references something. Both tools skip `node_modules`, `.git`, and build output; pass `includeHidden` to opt back into dotfiles.

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
