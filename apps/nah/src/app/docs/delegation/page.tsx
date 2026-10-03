import Link from "next/link";
import { Code, DocHeader, DocSection, DocsShell, Note } from "@/components/docs/DocsShell";

const sdkSample = `import {
  createCodingTools,
  createGitWorktreeIsolation,
  formatSubtaskReport,
  Orchestrator,
  orchestratorPrompt,
} from "not-another-harness";
import { createNodeEnvironment } from "not-another-harness/node";

const orchestrator = new Orchestrator({
  model,
  system: \`\${buildSystemPrompt({ cwdLabel: cwd })}\n\n\${orchestratorPrompt({
    concurrency: 3,
  })}\`,
  isolation: createGitWorktreeIsolation({ cwd }),
  createTools: (root) =>
    createCodingTools(createNodeEnvironment(root), { approveToolCall }),
  maxConcurrency: 3,
  maxSteps: 20,
  onUsage: (usage) => session.rollSpend(usage),
});

const results = await orchestrator.runAll([
  { title: "extract the parser", task: "Move parse() into parser.ts. Keep the export." },
  { title: "cover the parser", task: "Add tests for parse() edge cases." },
]);`;

const isolationSample = `const isolation = {
  description: "temporary Git worktree",
  prepare: async ({ title, task }) => ({
    cwd: worktreePath,          // where the child's tools are confined
    boundaryNotes: [           // what the child cannot infer
      "- The parent has uncommitted changes in src/, docs/.",
    ],
    collect: async () => ({     // what the parent reviews
      baseRevision, changedPaths, diff,
    }),
    cleanup: async ({ retain }) => {
      if (!retain) await runGit("worktree", "remove", "--force");
    },
  }),
};`;

const reportSample = `Delegated task: extract the parser
Base revision: 4f1c9ab
status: completed; steps: 6; tool calls: 9; tokens: 41200 in / 1840 out / 43040 total; estimated usage: false; elapsed: 62140ms
Changed paths: src/parser.ts, src/index.ts

Review this diff before applying any of it:
diff --git a/src/index.ts b/src/index.ts
...`;

export default function DelegationPage() {
  return <DocsShell current="/docs/delegation"><DocHeader eyebrow="RUNTIME / DELEGATION" title="Hand a plan to sub-agents." description="When a task decomposes into pieces that do not depend on each other, NAH can run them as separate child agents at once — each in its own transcript, each in an isolated workspace, each coming back as a diff you review." />
    <DocSection id="model" title="A parent and its children"><p><code className="font-mono text-[11px] text-zinc-300">runAgent</code> is one agent in one workspace. <code className="font-mono text-[11px] text-zinc-300">Orchestrator</code> is the parent-and-children workflow on top of it: the parent hands over a bounded subtask, the child works in a <strong className="text-zinc-200">fresh transcript</strong> against an <strong className="text-zinc-200">isolated workspace</strong>, and the work returns as a reviewable artifact.</p><p>The payoff is context. A wide read-and-reason job stops competing with the parent&apos;s own work for one context window, and a child that goes wrong leaves something reviewable behind instead of half-applied edits. The mechanism stays explicit — the orchestrator is a class you construct and call, not a layer that decides on its own.</p></DocSection>

    <DocSection id="isolation" title="Isolation is the point"><p>An isolation strategy is three operations: hand the child a root its tools are confined to plus the boundary facts it cannot infer, collect what it produced, then clean up. <code className="font-mono text-[11px] text-zinc-300">createGitWorktreeIsolation</code> branches a detached worktree from <code className="font-mono text-[11px] text-zinc-300">HEAD</code>, so a child cannot see uncommitted parent work and cannot collide with a sibling. It tells the child which parent paths are invisible rather than letting it re-implement them. <code className="font-mono text-[11px] text-zinc-300">sharedWorkspaceIsolation()</code> is the fallback when there is no repository.</p><Code language="ts">{isolationSample}</Code><Note title="Not a sandbox">An isolated worktree bounds a child&apos;s writes to its own checkout. It is not an operating-system sandbox: a child&apos;s shell still runs with your user&apos;s privileges, so approval policy and tool scope still apply.</Note></DocSection>

    <DocSection id="fan-out" title="Plans fan out, they do not queue"><p><code className="font-mono text-[11px] text-zinc-300">run</code> handles one subtask. <code className="font-mono text-[11px] text-zinc-300">runAll</code> takes the whole plan and runs it in waves of <code className="font-mono text-[11px] text-zinc-300">maxConcurrency</code> children — a plan is rarely one item, and the cap is a scheduling constraint rather than a refusal. A single task submitted above the cap throws <code className="font-mono text-[11px] text-zinc-300">OrchestratorBusyError</code> instead of queueing, because a queued child can start later than the parent expected and outlive the run that asked for it.</p><Code language="ts">{sdkSample}</Code></DocSection>

    <DocSection id="review" title="Nothing is applied for you"><p>Every child returns its stop reason, step and tool-call counts, token usage, changed paths, and a diff against the revision it branched from. Integrating that diff is the parent&apos;s decision, made on a transcript that still holds the parent&apos;s own reasoning.</p><Code language="text">{reportSample}</Code><p>A diff too large to return inline is truncated, and the report says where the full one is — because a truncated diff nobody can open is not a result.</p></DocSection>

    <DocSection id="cli" title="In the CLI"><p>Outside a sandbox the agent has two tools: <code className="font-mono text-[11px] text-zinc-300">delegate_task</code> for a single independent subtask, and <code className="font-mono text-[11px] text-zinc-300">delegate_tasks</code> to hand over a whole plan in one call, so the fan-out reads as one decision instead of N sequential waits. Both go through one orchestrator with up to three concurrent children, and both require approval under the ask permission mode. Child spend rolls into the session&apos;s own totals.</p><p>The system prompt tells the agent when to reach for them: an independent plan belongs to the children, dependent work belongs to the parent.</p><Link href="/docs/cli" className="text-violet-200 hover:text-white">CLI modes and permission handling →</Link></DocSection>
  </DocsShell>;
}