import Link from "next/link";
import { Code, DocHeader, DocSection, DocsShell, Note } from "@/components/docs/DocsShell";

const catalog = [
  ["read", "Read a text file with 1-based line numbers and paging."],
  ["list", "List a directory tree with depth and output limits."],
  ["glob", "Find files by name or path pattern: *, **, ?, {a,b}."],
  ["grep", "Search file contents and return capped path:line matches."],
  ["edit", "Apply an exact replacement to a file."],
  ["write", "Create or replace a text file."],
  ["bash", "Run a shell command with a timeout; included by default."],
  ["outline", "Summarize the repository structure when the environment supports it."],
  ["web_fetch", "Fetch a URL and return bounded page text."],
  ["recall", "Search this project's memory. Read-only, and CLI-registered."],
];

export default function ToolsPage() {
  return <DocsShell current="/docs/tools">
    <DocHeader eyebrow="RUNTIME / TOOLS" title="Give your agent the right tools." description="Tools are the agent’s interface to your product. Define their inputs, implement their effects, and pass only the capabilities this run should have. NAH uses the AI SDK v5 tool format, so your tools stay ordinary TypeScript." />

    <DocSection id="tool-shape" title="A tool has a schema and an implementation">
      <p>Define a tool with the AI SDK <code>tool()</code> helper. The input schema tells the model what arguments it may provide; <code>execute</code> validates those arguments and performs your operation. Return a concise, serializable result the model can use in its next step.</p>
      <Code language="ts">{"import { tool } from \"ai\";\nimport { z } from \"zod\";\n\nconst lookupIssue = tool({\n  description: \"Look up an issue by its key, such as APP-42.\",\n  inputSchema: z.object({\n    key: z.string().describe(\"Issue key, for example APP-42\"),\n  }),\n  execute: async ({ key }) => {\n    const issue = await issues.get(key);\n    if (!issue) return { found: false, key };\n    return {\n      found: true,\n      key: issue.key,\n      title: issue.title,\n      status: issue.status,\n    };\n  },\n});"}</Code>
      <p>Descriptions and field descriptions are part of the model-facing interface. State when to use the tool, what inputs mean, and any important constraints. Keep results focused: return the fields needed for the task instead of entire database records.</p>
    </DocSection>

    <DocSection id="attach" title="Pass a tool map to runAgent">
      <p>Tools are properties on a plain object. Property names become the names the model calls. Compose only the tools the task needs, then pass that map to <code>runAgent</code>.</p>
      <Code language="ts">{"import { runAgent } from \"not-another-harness\";\n\nconst tools = { lookupIssue, searchDocs };\nconst run = runAgent({\n  model,\n  prompt: \"Find the issue and summarize the documented fix.\",\n  system: \"Use the available tools to answer accurately.\",\n  tools,\n});\n\nfor await (const event of run.events) {\n  if (event.type === \"tool-call\") {\n    console.log(`Calling ${event.toolName}`, event.input);\n  }\n}\nconst result = await run.result;"}</Code>
      <p>Use your own tool map alone for a focused assistant, or combine it with selected built-ins. You do not have to expose every tool returned by <code>createCodingTools</code>.</p>
      <Code language="ts">{"import { createCodingTools, runAgent } from \"not-another-harness\";\nimport { createNodeEnvironment } from \"not-another-harness/node\";\n\nconst coding = createCodingTools(createNodeEnvironment(cwd), {\n  withBash: false,\n  withWebFetch: false,\n});\nconst tools = {\n  read: coding.read,\n  grep: coding.grep,\n  lookupIssue,\n};\n\nconst run = runAgent({ model, prompt, system, tools });"}</Code>
      <Note title="The map is the capability boundary">If a tool is not in the map, the model cannot call it. Build the map on the server from the authenticated user and current task; never rely on prompt text to restrict access.</Note>
    </DocSection>

    <DocSection id="scope" title="Scope tools to the current user">
      <p>For values fixed for the whole run, close over them when creating the tool. This keeps tenant and permission checks next to the operation and avoids asking the model to supply trusted identity data.</p>
      <Code language="ts">{"function makeWorkspaceTools(actor: Actor, workspaceId: string) {\n  return {\n    searchWorkspace: tool({\n      description: \"Search files in the current workspace.\",\n      inputSchema: z.object({ query: z.string() }),\n      execute: async ({ query }) => {\n        await access.assertCanRead(actor, workspaceId);\n        return workspace.search({ workspaceId, query });\n      },\n    }),\n  };\n}\n\nconst tools = makeWorkspaceTools(currentActor, activeWorkspace.id);\nconst run = runAgent({ model, prompt, system, tools });"}</Code>
      <p>When a value genuinely changes per model step, provide <code>toolsContext</code>, keyed by tool name. The SDK passes that slice to the tool as <code>options.context</code>.</p>
      <Code language="ts">{"const tools = {\n  searchWorkspace: tool({\n    description: \"Search the workspace.\",\n    inputSchema: z.object({ query: z.string() }),\n    execute: async ({ query }, { context }) => {\n      const { requestId } = context as { requestId: string };\n      return searchWorkspace(query, { requestId });\n    },\n  }),\n};\n\nconst run = runAgent({\n  model, prompt, system, tools,\n  toolsContext: { searchWorkspace: { requestId } },\n});"}</Code>
      <Note title="Context shape">The map must be keyed by the tool name. A run-wide identity or permission is usually simpler and safer in a closure.</Note>
    </DocSection>

    <DocSection id="approval" title="Require approval for sensitive tools">
      <p>Use AI SDK v5 <code>toolApproval</code> to hold calls until a person decides. Name the gated tools explicitly; tools omitted from this object run without this approval gate. An approval request ends the run with <code>awaiting-approval</code>, so persist the transcript, collect a decision, append the approval response, and resume the run.</p>
      <Code language="ts">{"import { appendApprovalResponses, runAgent } from \"not-another-harness\";\n\nconst tools = { lookupIssue, deleteIssue };\nconst options = {\n  model, prompt, system, tools,\n  toolApproval: { deleteIssue: \"user-approval\" },\n};\n\nconst first = await runAgent(options).result;\nif (first.reason === \"awaiting-approval\") {\n  const decisions: Record<string, { approved: boolean }> = {};\n  for (const pending of first.pendingApprovals) {\n    decisions[pending.approvalId] = { approved: await askHuman(pending) };\n  }\n  const resumed = runAgent({\n    ...options, prompt: \"\",\n    messages: appendApprovalResponses(first.messages, decisions),\n  });\n  const result = await resumed.result;\n}"}</Code>
      <p>For a permission callback that runs immediately before a built-in mutation, use <code>createCodingTools</code>’s <code>approveToolCall</code> option instead. This is distinct from the transcript-based <code>toolApproval</code> flow.</p>
      <Code language="ts">{"const coding = createCodingTools(environment, {\n  approveToolCall: async (toolName, input) =>\n    askForApproval({ toolName, input }),\n});"}</Code>
      <p>See the <Link href="/docs/sdk" className="text-violet-200 hover:text-white">SDK quickstart</Link> for the full runtime setup and the <Link href="/docs/events" className="text-violet-200 hover:text-white">event guide</Link> for rendering tool calls and results.</p>
    </DocSection>

    <DocSection id="built-ins" title="Built-in coding tools">
      <p><code>createCodingTools(environment, options)</code> returns a ready-to-use AI SDK tool map rooted at the provided environment. The defaults are intended for repository work; disable capabilities the agent should not have.</p>
      <div className="overflow-hidden rounded-xl border border-white/[0.08]"><div className="grid grid-cols-[100px_1fr] border-b border-white/[0.07] bg-white/[0.025] px-4 py-2 font-mono text-[9px] uppercase tracking-widest text-zinc-600"><span>Tool</span><span>Purpose</span></div>{catalog.map(([name, summary]) => <div key={name} className="grid grid-cols-[100px_1fr] border-b border-white/[0.06] px-4 py-3 last:border-0"><code className="font-mono text-[11px] text-violet-200">{name}</code><span className="text-xs leading-5 text-zinc-400">{summary}</span></div>)}</div>
      <Code language="ts">{"const tools = createCodingTools(environment, {\n  withBash: false,             // omit shell access\n  withGlob: true,              // pattern-based discovery\n  withOutline: false,          // omit repository outline\n  withWebFetch: false,         // disable network fetches\n  requireReadBeforeWrite: true,\n  caps: { read: { maxLines: 300 } },\n});"}</Code>
      <p>Read-only tools — read, list, grep, and glob — are not approval-gated. Edit, write, bash, and web_fetch use <code>approveToolCall</code> when you provide it; without a callback they are allowed. The filesystem environment roots paths to the selected workspace and rejects paths that escape it.</p>
    </DocSection>

    <DocSection id="patterns" title="Tool design checklist">
      <ul className="ml-5 list-disc space-y-2"><li>Give each tool one clear action and a precise description.</li><li>Validate every model-provided value with a schema, including IDs and ranges.</li><li>Derive identity, tenant, and permission from trusted server state.</li><li>Return small structured results and handle expected failures explicitly.</li><li>Put irreversible actions behind an approval or application policy.</li><li>Expose only the tools relevant to this agent and run.</li></ul>
      <p>For filesystem discovery patterns, output bounds, and the built-in approval callback in detail, continue to <Link href="/docs/sdk" className="text-violet-200 hover:text-white">the SDK quickstart</Link> and <Link href="/docs/agent-loop" className="text-violet-200 hover:text-white">the agent loop</Link>.</p>
    </DocSection>
  </DocsShell>;
}
