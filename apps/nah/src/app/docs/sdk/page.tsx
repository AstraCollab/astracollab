import Link from "next/link";
import { Code, DocHeader, DocSection, DocsShell, Note } from "@/components/docs/DocsShell";

const runSample = [
  "import {",
  "  buildSystemPrompt,",
  "  createCodingTools,",
  "  runAgent,",
  "} from 'not-another-harness';",
  "import { createNodeEnvironment } from 'not-another-harness/node';",
  "import type { LanguageModel } from 'ai';",
  "",
  "declare const model: LanguageModel; // create with an AI SDK v5 provider",
  "",
  "const cwd = process.cwd();",
  "const tools = createCodingTools(createNodeEnvironment(cwd), {",
  "  withBash: false,",
  "  approveToolCall: async (toolName, input) =>",
  "    requestApproval(toolName, input),",
  "});",
  "",
  "const run = runAgent({",
  "  model,",
  "  prompt: 'explain the session refresh path',",
  "  system: buildSystemPrompt({ cwdLabel: cwd }),",
  "  tools,",
  "  maxSteps: 20,",
  "});",
].join("\n");

const consumeSample = [
  "for await (const event of run.events) {",
  "  if (event.type === 'text-delta') {",
  "    renderText(event.text);",
  "  } else if (event.type === 'tool-call') {",
  "    showToolCall(event.toolName, event.input);",
  "  } else if (event.type === 'tool-result') {",
  "    showToolResult(event.output, event.isError);",
  "  }",
  "}",
  "",
  "const result = await run.result;",
  "showCompletion(result.reason, result.usage);",
].join("\n");

const steerSample = [
  "run.steer('actually use TypeScript');         // next step boundary",
  "run.followUp('then update the changelog');  // only if it would otherwise finish",
  "run.interrupt();                            // abort now",
  "run.pending();                              // { steer: [], followUp: [] }",
].join("\n");

const persistSample = [
  "import { createJsonlSessionStore, sessionUpdate } from 'not-another-harness';",
  "",
  "const session = createJsonlSessionStore('.nah/session.jsonl');",
  "const previousMessages = await session.load();",
  "",
  "const run = runAgent({ ...options, messages: previousMessages });",
  "const result = await run.result;",
  "const update = sessionUpdate(previousMessages, result);",
  "if (update.mode === 'replace') await session.replace(update.messages);",
  "else await session.append(update.messages);",
].join("\n");

export default function SdkPage() {
  return <DocsShell current="/docs/sdk"><DocHeader eyebrow="BUILD AN AGENT / SDK GUIDE" title="Compose an agent for your product." description="This guide wires a model, system prompt, tools, and run policy into an agent you can embed in a TypeScript service. NAH owns the loop; your app owns the capabilities and user experience." />
    <DocSection id="install" title="Install the runtime"><p>Install the runtime, not the CLI. They are separate packages: <code className="font-mono text-[11px] text-zinc-300">nah-ai</code> is the terminal application and re-exports nothing, so importing the loop from it fails. The Node environment adapter is a subpath of the runtime.</p><Code>{"npm install not-another-harness ai @ai-sdk/anthropic zod"}</Code><p>The runtime declares AI SDK and Zod as peer dependencies. Use versions compatible with the installed runtime.</p></DocSection>

    <DocSection id="web" title="Embedding in a web app"><p>This guide shows the direct <code>runAgent</code> API for composing a run. If you are building a browser chat and want HTTP routes, SSE streaming, reconnects, session adapters, and a React hook, use <code>nah-js</code>—the Web runtime built on the same harness.</p><Code>{"npm install nah-js not-another-harness ai zod"}</Code><p>Follow the <Link href="/docs/web" className="text-violet-200 hover:text-white">nah-js web integration guide</Link> for Next.js App Router and examples for Hono, Remix, SvelteKit, Astro, and Web API servers.</p></DocSection>

    <DocSection id="run" title="Create a run"><p>Build a model with your chosen AI SDK provider, create tools rooted at your workspace, then call <code className="font-mono text-[11px] text-zinc-300">runAgent</code>. The core loop accepts a complete system prompt and a tool map.</p><Code language="ts">{runSample}</Code><Note title="Approval callback">The SDK allows mutating tool calls when <code>approveToolCall</code> is omitted. Connect this callback to your host application&apos;s approval policy; do not use an unconditional allow callback unless that is the intended trust model.</Note></DocSection>

    <DocSection id="system" title="Write the system instructions"><p>Pass a complete system string. <code>buildSystemPrompt</code> is an optional helper for coding agents; product agents can provide their own instructions and include the rules that matter for their domain.</p><Code language="ts">{"const system = [\n  \"You are the support assistant for Acme.\",\n  \"Use account tools only for the authenticated account.\",\n  \"Ask before changing a subscription or closing a case.\",\n  \"When a tool returns no result, say so instead of guessing.\",\n].join(\"\\n\");"}</Code><p>System instructions guide behavior, while the tool map and server-side checks enforce what the agent can actually do. See <Link href="/docs/tools" className="text-violet-200 hover:text-white">tool configuration</Link> for schemas, closures, context, and approvals.</p></DocSection>

    <DocSection id="policy" title="Choose the run policy"><p>Run options control runtime behavior. Select limits for your latency and spend envelope, pass cancellation from the request lifecycle, and provide domain rules as callbacks.</p><Code language="ts">{"const controller = new AbortController();\nrequest.signal.addEventListener(\"abort\", () => controller.abort(), { once: true });\n\nconst run = runAgent({\n  model, prompt, system, tools,\n  abortSignal: controller.signal,\n  maxSteps: 24,\n  maxSpendUsd: 0.50,\n  rates: { input: 3, output: 15 },\n  shouldStop: ({ stepNumber, steps }) =>\n    stepNumber > 18 && steps.some((step) => step.toolNames.includes(\"submit\")),\n});"}</Code><p>Use <code>prepareStep</code> to alter tools or tool choice for a specific request. Use <code>shouldStop</code> when application state can identify an end condition that the generic loop cannot know.</p><Link href="/docs/agent-loop" className="text-violet-200 hover:text-white">All run options and context controls →</Link></DocSection>

    <DocSection id="steering" title="Steer a running turn"><p>A run is steerable. Messages are appended at the next step boundary — never injected into a request that is already streaming — so the in-flight model call is never cut off.</p><Code language="ts">{steerSample}</Code><p>A pending message prevents the run from ending, and a delivered message grants a fresh step window so <code className="font-mono text-[11px] text-zinc-300">maxSteps</code> cannot discard something a human deliberately sent. <code className="font-mono text-[11px] text-zinc-300">steer()</code> and <code className="font-mono text-[11px] text-zinc-300">followUp()</code> return <code className="font-mono text-[11px] text-zinc-300">false</code> once the run has settled rather than accepting input that would be lost.</p></DocSection>

    <DocSection id="consume" title="Consume events and result"><p>Listen to the async stream for live progress. Then await the result for the final text, stop reason, usage totals, transcript, and number of compactions.</p><Code language="ts">{consumeSample}</Code><p>For all event variants and cancellation behavior, see <Link href="/docs/events" className="text-violet-200 hover:text-white">streaming events</Link>. For the defaults behind <code className="font-mono text-[11px] text-zinc-300">maxSteps</code> and compaction, see <Link href="/docs/agent-loop" className="text-violet-200 hover:text-white">the agent loop</Link>.</p></DocSection>

    <DocSection id="persistence" title="Persist sessions"><p>The core runtime returns the full transcript in the result and accepts prior AI SDK messages through the <code className="font-mono text-[11px] text-zinc-300">messages</code> option. For JSONL persistence the package exports <code className="font-mono text-[11px] text-zinc-300">createJsonlSessionStore</code>, with append and load methods. The CLI uses that store for its session behavior.</p><Code language="ts">{persistSample}</Code><p>The transcript itself is your session’s normal conversational state; persist it independently with the session store as described in <Link href="/docs/memory" className="text-violet-200 hover:text-white">conversation state</Link>. For durable context across sessions, the HTTP runtime accepts an optional <code className="font-mono text-[11px] text-zinc-300">NahMemory</code> implementation plus a state store and key. It calls <code className="font-mono text-[11px] text-zinc-300">getPromptContext()</code> before each turn and <code className="font-mono text-[11px] text-zinc-300">postTurnAsync()</code> after it. See <Link href="/docs/cognitive-memory" className="text-violet-200 hover:text-white">cognitive memory</Link> for the configurable backend.</p></DocSection>
  </DocsShell>;
}
