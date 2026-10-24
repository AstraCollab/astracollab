import Link from "next/link";
import { Code, DocHeader, DocSection, DocsShell, Note } from "@/components/docs/DocsShell";

export default function OrchestratorPage() {
  return <DocsShell current="/docs/orchestrator">
    <DocHeader eyebrow="COMPOSE / ORCHESTRATOR" title="Coordinate child agents explicitly." description="Orchestrator runs bounded subtasks with fresh transcripts and controlled workspaces. Your code decides what to delegate, how much can run at once, and how results are reviewed and integrated." />

    <DocSection id="when" title="When to use an orchestrator">
      <p>Use <code>runAgent</code> for one agent working through one task. Add an <code>Orchestrator</code> when that task can be split into independent assignments that benefit from separate context or workspaces—for example, reviewing separate modules or implementing changes that do not depend on each other.</p>
      <p>Orchestrator does not decompose a prompt automatically and does not merge child work. The caller or parent agent writes each assignment, starts the children, and reviews their reports and artifacts.</p>
      <Code language="text">{"parent plans independent subtasks\n  → orchestrator starts child runs\n  → each child gets its own transcript + workspace strategy\n  → results return with status, usage, report, and optional diff\n  → parent reviews and decides what to integrate"}</Code>
    </DocSection>

    <DocSection id="setup" title="Create an orchestrator">
      <p>Provide a model, system instructions, and a tool factory. The factory receives each child’s workspace root, so tools can be confined to that child. Git worktree isolation is useful when children may edit files.</p>
      <Code language="ts">{"import {\n  createCodingTools,\n  createGitWorktreeIsolation,\n  Orchestrator,\n  orchestratorPrompt,\n} from \"not-another-harness\";\nimport { createNodeEnvironment } from \"not-another-harness/node\";\n\nconst orchestrator = new Orchestrator({\n  model,\n  system: [\n    \"You are a coding agent.\",\n    orchestratorPrompt({ concurrency: 3 }),\n  ].join(\"\\n\\n\"),\n  isolation: createGitWorktreeIsolation({ cwd }),\n  createTools: (root) =>\n    createCodingTools(createNodeEnvironment(root), {\n      withBash: true,\n      approveToolCall,\n    }),\n  maxConcurrency: 3,\n  maxSteps: 20,\n  taskTimeoutMs: 10 * 60_000,\n  onUsage: (usage) => session.rollSpend(usage),\n});"}</Code>
      <Note title="System prompt helper"><code>orchestratorPrompt()</code> adds delegation guidance for the parent model: children have no shared conversation history, work from a snapshot, and their diffs need review. It does not create or run children for you.</Note>
    </DocSection>

    <DocSection id="run" title="Run one task or a plan">
      <p>Call <code>run</code> for a single subtask. Use <code>runAll</code> for a plan: it schedules tasks in waves up to the concurrency limit and returns results in submission order. Give every task a self-contained assignment with scope and acceptance criteria because children do not receive the parent’s transcript.</p>
      <Code language="ts">{"const results = await orchestrator.runAll([\n  {\n    title: \"Review the parser\",\n    task: \"Inspect src/parser.ts for correctness bugs. Do not edit. Report each issue with a location and reproduction.\",\n    createTools: (root) => createCodingTools(createNodeEnvironment(root), {\n      withBash: false,\n    }),\n  },\n  {\n    title: \"Review the API handlers\",\n    task: \"Inspect src/api for authorization gaps. Do not edit. Report concrete findings.\",\n  },\n]);\n\nfor (const result of results) {\n  console.log(result.title, result.status, result.usage);\n  if (result.artifact) {\n    console.log(result.artifact.changedPaths);\n    reviewDiff(result.artifact.diff);\n  }\n}"}</Code>
      <p>Each <code>SubtaskResult</code> includes the status, step and tool-call counts, usage, elapsed time, final text, and—when isolation collects one—changed paths and a diff. A child failure is returned as a result with <code>status: "error"</code>, so other tasks can still finish.</p>
    </DocSection>

    <DocSection id="limits" title="Concurrency, budgets, and cancellation">
      <p><code>maxConcurrency</code> defaults to three. <code>runAll</code> accepts plans larger than the limit and runs them in waves. A direct <code>run</code> submitted when all slots are occupied rejects with <code>OrchestratorBusyError</code> rather than queueing unexpectedly.</p>
      <Code language="ts">{"const controller = new AbortController();\nconst orchestrator = new Orchestrator({\n  model, system, createTools,\n  maxConcurrency: 2,\n  maxSteps: 18,\n  maxSpendUsd: 0.40,\n  rates: { input: 3, output: 15 },\n  signal: controller.signal,\n  onEvent: (event) => {\n    if (event.type === \"subtask-start\") showStarted(event.title);\n    if (event.type === \"subtask-event\") forwardChildEvent(event);\n    if (event.type === \"subtask-finish\") showFinished(event.result);\n  },\n});\n\ncontroller.abort(); // abort children still in flight"}</Code>
      <p>A task can override its own <code>maxSteps</code>, <code>maxSpendUsd</code>, <code>signal</code>, isolation strategy, or tool factory. Use <code>onUsage</code> to fold completed child usage into the parent application’s accounting.</p>
    </DocSection>

    <DocSection id="isolation" title="Choose a workspace strategy">
      <p><code>{"createGitWorktreeIsolation({ cwd })"}</code> gives each child a separate checkout. By default it snapshots the parent working tree at child start, including uncommitted changes. That snapshot is frozen: later parent edits are not visible to the child. Siblings cannot write into one another’s worktrees.</p>
      <p>Once a child finishes, its worktree is cleaned up by default and its diff is returned for review. If the diff is too large to include, the workspace is retained and its path is included in the result. Set <code>retain: true</code> to keep worktrees for inspection. <code>sharedWorkspaceIsolation()</code> is available when sharing files is intentional, but concurrent writers can conflict.</p>
      <Note title="Worktree isolation is not a security sandbox">It confines the built-in filesystem tools to a checkout. A child’s shell still runs with the host process’s privileges; use approval policy and a sandbox when operating untrusted code.</Note>
    </DocSection>

    <DocSection id="events" title="Observe child runs">
      <p>Use <code>onEvent</code> to observe starts, each nested harness event, and completion. The child event stream is drained by the orchestrator even if your callback does not render it, so progress handling is optional. <code>totalUsage</code> reports cumulative usage for completed children.</p>
      <Code language="ts">{"const result = await orchestrator.run({\n  title: \"Find the migration path\",\n  task: \"Trace how schema migrations are loaded. Return the relevant files and a concise explanation.\",\n});\n\nconsole.log(result.status, result.text);\nconsole.log(orchestrator.active);      // children currently running\nconsole.log(orchestrator.totalUsage); // completed-child usage"}</Code>
      <p>Forward <code>subtask-event</code> payloads to the same UI renderer used for a normal <code>runAgent</code>, while using the outer subtask ID and title to group child activity.</p>
    </DocSection>

    <DocSection id="workflows" title="Use orchestration from workflows">
      <p>For repeatable sequences, combine the orchestrator with a workflow. <code>runWorkflow</code> supplies <code>delegate</code> and <code>delegateAll</code> in each step’s context, so deterministic steps stay code and only judgement-heavy steps use child agents. A suspended workflow can be found with <code>pendingWorkflows()</code> and continued with <code>resumeWorkflow(runId, answer)</code>.</p>
      <Code language="ts">{"const outcome = await orchestrator.runWorkflow(reviewWorkflow, {\n  inputData: { base: \"main\" },\n  onEvent: (event) => renderWorkflowProgress(event),\n});\nif (outcome.status === \"success\") {\n  useWorkflowResult(outcome.result);\n} else if (outcome.status === \"suspended\") {\n  showQuestion(outcome.suspendPayload);\n}"}</Code>
      <p>See <Link href="/docs/workflows" className="text-violet-200 hover:text-white">Workflows</Link> for defining and composing those sequences, or <Link href="/docs/delegation" className="text-violet-200 hover:text-white">Delegation</Link> for the parent/child integration patterns used by the CLI.</p>
    </DocSection>
  </DocsShell>;
}
