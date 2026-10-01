import Link from "next/link";
import { Code, DocHeader, DocSection, DocsShell, Note } from "@/components/docs/DocsShell";

const runSample = [
  "import {",
  "  buildSystemPrompt,",
  "  createCodingTools,",
  "  runAgent,",
  "} from '@astracollab/not-another-harness';",
  "import { createNodeEnvironment } from '@astracollab/not-another-harness/node';",
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
  "import { createJsonlSessionStore } from '@astracollab/not-another-harness';",
  "",
  "const session = createJsonlSessionStore('.nah/session.jsonl');",
  "const previousMessages = await session.load();",
  "",
  "const run = runAgent({ ...options, messages: previousMessages });",
  "const result = await run.result;",
  "await session.append(result.messages);",
].join("\n");

export default function SdkPage() {
  return <DocsShell current="/docs/sdk"><DocHeader eyebrow="RUNTIME / SDK QUICKSTART" title="Compose your own agent runner." description="The runtime package exports the loop, prompt builder, built-in tools, session store, and memory. You provide an AI SDK v5 LanguageModel and decide how to approve changes and present the run." />
    <DocSection id="install" title="Install the runtime"><p>Install the runtime, not the CLI. They are separate packages: <code className="font-mono text-[11px] text-zinc-300">@astracollab/nah</code> is the terminal application and re-exports nothing, so importing the loop from it fails. The Node environment adapter is a subpath of the runtime.</p><Code>{"npm install @astracollab/not-another-harness ai @ai-sdk/anthropic zod"}</Code><p>The runtime declares AI SDK and Zod as peer dependencies. Use versions compatible with the installed runtime.</p></DocSection>

    <DocSection id="run" title="Create a run"><p>Build a model with your chosen AI SDK provider, create tools rooted at your workspace, then call <code className="font-mono text-[11px] text-zinc-300">runAgent</code>. The core loop accepts a complete system prompt and a tool map.</p><Code language="ts">{runSample}</Code><Note title="Approval callback">The SDK allows mutating tool calls when <code>approveToolCall</code> is omitted. Connect this callback to your host application&apos;s approval policy; do not use an unconditional allow callback unless that is the intended trust model.</Note></DocSection>

    <DocSection id="steering" title="Steer a running turn"><p>A run is steerable. Messages are appended at the next step boundary — never injected into a request that is already streaming — so the in-flight model call is never cut off.</p><Code language="ts">{steerSample}</Code><p>A pending message prevents the run from ending, and a delivered message grants a fresh step window so <code className="font-mono text-[11px] text-zinc-300">maxSteps</code> cannot discard something a human deliberately sent. <code className="font-mono text-[11px] text-zinc-300">steer()</code> and <code className="font-mono text-[11px] text-zinc-300">followUp()</code> return <code className="font-mono text-[11px] text-zinc-300">false</code> once the run has settled rather than accepting input that would be lost.</p></DocSection>

    <DocSection id="consume" title="Consume events and result"><p>Listen to the async stream for live progress. Then await the result for the final text, stop reason, usage totals, transcript, and number of compactions.</p><Code language="ts">{consumeSample}</Code><p>For all event variants and cancellation behavior, see <Link href="/docs/events" className="text-violet-200 hover:text-white">streaming events</Link>. For the defaults behind <code className="font-mono text-[11px] text-zinc-300">maxSteps</code> and compaction, see <Link href="/docs/agent-loop" className="text-violet-200 hover:text-white">the agent loop</Link>.</p></DocSection>

    <DocSection id="persistence" title="Persist sessions"><p>The core runtime returns the full transcript in the result and accepts prior AI SDK messages through the <code className="font-mono text-[11px] text-zinc-300">messages</code> option. For JSONL persistence the package exports <code className="font-mono text-[11px] text-zinc-300">createJsonlSessionStore</code>, with append and load methods. The CLI uses that store for its session behavior.</p><Code language="ts">{persistSample}</Code><p>To give a session memory across runs, construct <code className="font-mono text-[11px] text-zinc-300">CognitiveMemory</code> with an <code className="font-mono text-[11px] text-zinc-300">onPersist</code> writer, restore it with <code className="font-mono text-[11px] text-zinc-300">loadSnapshot</code> at startup, and prepend <code className="font-mono text-[11px] text-zinc-300">planInjection()</code> to the system prompt each turn. See <Link href="/docs/memory" className="text-violet-200 hover:text-white">cognitive memory</Link>.</p></DocSection>
  </DocsShell>;
}