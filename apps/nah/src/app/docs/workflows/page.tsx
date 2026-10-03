import Link from "next/link";
import { Code, DocHeader, DocSection, DocsShell, Note } from "@/components/docs/DocsShell";

const sdkSample = `import { createStep, createWorkflow, z } from "not-another-harness";

const collectChanges = createStep({
  id: "collect-changes",
  inputSchema: z.object({ base: z.string().optional() }),
  outputSchema: z.object({ files: z.array(z.string()) }),
  execute: async ({ inputData }) => ({
    files: await changedFiles(inputData.base ?? "HEAD"),
  }),
});

const reviewBatch = createStep({
  id: "review-batch",
  inputSchema: z.array(z.string()),
  execute: async ({ inputData, context, signal }) => {
    // \`delegate\` is put there by the orchestrator that runs the workflow.
    const { delegate } = context;
    const child = await delegate({
      title: \`review \${inputData.length} files\`,
      task: \`Review these for correctness bugs: \${inputData.join(", ")}. Edit nothing.\`,
      signal,
    });
    return { files: inputData, report: child.text };
  },
});

const reviewChanges = createWorkflow({
  id: "review-changes",
  description: "Review what changed, one child per group of files, then merge.",
})
  .then(collectChanges)
  .map({ inputKey: "files", outputKey: "reviews", mapper: (files) => reviewBatch })
  .then(mergeReviews)
  .commit();`;

const compositionSample = `createWorkflow({ id: "ship-check" })
  .then(collectChecks)                                   // what does this project run?
  .parallel([[typecheck], [lint], [test]])              // concurrently
  .branch([[(prev) => prev.some((c) => !c.ok), fixFailures]], {
    otherwise: reportSuccess,                            // first match wins
  })
  .commit();

const full = createWorkflow({ id: "full-review" })
  .then(reviewChanges)                                  // a committed workflow nests whole
  .then(shipCheck)
  .commit();`;

const suspendSample = `const run = reviewChanges.createRun();
const first = await run.start({ inputData: { base: "main" } });

if (first.status === "suspended") {
  // Nothing before this step is recomputed on resume.
  const done = await run.resume({ resumeData: await askHuman(run.snapshot()) });
}

// Or watch it, if you want progress rather than a promise.
const { events, result } = reviewChanges.createRun().stream({ inputData: {} });
for await (const event of events) console.log(event.type, event.stepId);`;

export default function WorkflowsPage() {
  return <DocsShell current="/docs/workflows"><DocHeader eyebrow="RUNTIME / WORKFLOWS" title="The sequence you already know." description="Delegation is a decision you make at the moment you need it. A workflow is the part you know every time: which steps, in what order, where they fan out, and where a judgement call belongs. Write it once, name it, and the agent runs it instead of improvising the same tool calls." />
    <DocSection id="shape" title="Steps and a builder"><p>A step is a function with an id and a schema. Schemas are enforced rather than documentary: a step that returns the wrong shape fails the run rather than feeding a malformed value into whatever reads it next. A workflow composes steps with <code className="font-mono text-[11px] text-zinc-300">.then</code>, <code className="font-mono text-[11px] text-zinc-300">.parallel</code>, <code className="font-mono text-[11px] text-zinc-300">.branch</code> and <code className="font-mono text-[11px] text-zinc-300">.map</code>, and <code className="font-mono text-[11px] text-zinc-300">.commit()</code> is what turns the builder into a runnable thing — it is where step ids are checked for uniqueness, because those ids key the run&apos;s results.</p><Code language="ts">{sdkSample}</Code></DocSection>

    <DocSection id="composition" title="Composing without copying"><p>Steps chain without an envelope: when the next step declares an object schema it is fed the matching keys of the previous output, and when none of those keys exist it gets the previous output whole. <code className="font-mono text-[11px] text-zinc-300">.parallel</code> runs its branches concurrently and yields the array of their outputs. <code className="font-mono text-[11px] text-zinc-300">.branch</code> takes the first matching condition, with an optional <code className="font-mono text-[11px] text-zinc-300">otherwise</code> for the fallthrough. A committed workflow nests as a single <code className="font-mono text-[11px] text-zinc-300">.then</code> argument, so a review is a unit you reuse rather than three steps you paste twice.</p><Code language="ts">{compositionSample}</Code><Note title="Bounded on purpose">Nesting is depth-capped and fan-out is capped too, so a cycle is an error instead of a hang, and a stray <code className="font-mono text-[11px] text-zinc-300">.parallel</code> of a thousand cannot become a thousand model calls.</Note></DocSection>

    <DocSection id="suspend" title="Stopping for a person"><p>Some steps cannot be decided by code — a diff that needs a human to approve, a deploy that needs a name. Throw <code className="font-mono text-[11px] text-zinc-300">StepSuspend</code> and the run returns <code className="font-mono text-[11px] text-zinc-300">status: &quot;suspended&quot;</code> instead of failing. Resuming continues from that step and reuses every earlier step&apos;s output rather than recomputing it, which is the point: a step that suspended usually sat in front of something expensive.</p><Code language="ts">{suspendSample}</Code></DocSection>

    <DocSection id="agent" title="Inside a step, a sub-agent"><p>This is the seam between the two features. <code className="font-mono text-[11px] text-zinc-300">Orchestrator.runWorkflow</code> puts its <code className="font-mono text-[11px] text-zinc-300">delegate</code> into every step&apos;s context, so a step that needs judgement calls a real child agent instead of trying to prompt its way there. A step that delegates <em>waits</em> for a concurrency slot rather than throwing, because the sequence it belongs to is already the orchestrator&apos;s queue. The difference from delegating the workflow wholesale: a workflow step shares the caller&apos;s workspace and state, while a sub-agent gets its own transcript and its own checkout.</p><Link href="/docs/delegation" className="text-violet-200 hover:text-white">Delegation and isolation →</Link></DocSection>

    <DocSection id="cli" title="In the CLI"><p>NAH ships two. <code className="font-mono text-[11px] text-zinc-300">review-changes</code> collects what differs from a base, groups the files, sends each group to its own reviewing child, and merges the findings — the gathering steps run Git themselves, because spending a model call to obtain a string the shell already knows can get it wrong in a way that only surfaces as a mysteriously empty review. <code className="font-mono text-[11px] text-zinc-300">ship-check</code> runs the workspace&apos;s own <code className="font-mono text-[11px] text-zinc-300">typecheck</code>, <code className="font-mono text-[11px] text-zinc-300">lint</code> and <code className="font-mono text-[11px] text-zinc-300">test</code> scripts in parallel — only the ones the workspace actually defines, so it never reports a failure the project never claimed to have.</p><p>Type <code className="font-mono text-[11px] text-zinc-300">/workflow</code> to list them, <code className="font-mono text-[11px] text-zinc-300">/workflow review-changes main</code> to run one against a base. The agent has the same two tools: <code className="font-mono text-[11px] text-zinc-300">list_workflows</code> and <code className="font-mono text-[11px] text-zinc-300">run_workflow</code>, and its prompt tells it to reach for an existing workflow before assembling the same multi-step sequence out of tool calls.</p><Link href="/docs/cli" className="text-violet-200 hover:text-white">CLI modes and permission handling →</Link></DocSection>
  <DocSection id="authoring" title="Describing one instead of writing it"><p>Nobody should have to open a file to get a new sequence. <code className="font-mono text-[11px] text-zinc-300">/workflow new A workflow that cuts a release to a tag and opens a PR</code> takes the description in plain English and hands it to the agent as a turn. It reads the repository to find the real scripts, paths and refs your words point at, writes down the steps, and then — before it writes a line of code — asks for whatever it genuinely cannot learn on its own: a base ref, a publish path, who signs off. Each question arrives with the default it would have picked and why, so answering is a word, not an interview. The answers come back into the same conversation, and the file lands in <code className="font-mono text-[11px] text-zinc-300">.nah/workflows/</code>.</p><p>A file there default-exports a function that is handed the API instead of importing it, because a file inside the workspace resolves its modules from the project root and would not find the package. nah looks the file up by name at the moment the workflow is run, so a sequence written mid-session is runnable straight away, and an edited one is picked up rather than served from the first draft. <code className="font-mono text-[11px] text-zinc-300">/workflow</code> on its own lists what the workspace has and names any file that will not load.</p><Code language="js">{`// .nah/workflows/release.mjs
export default ({ createStep, createWorkflow, z }) =>
  createWorkflow({
    id: "release",
    description: "Cut a release tag and open a PR. Needs base: the ref to release from.",
    inputSchema: z.object({ base: z.string().describe("Git ref to tag.") }),
    outputSchema: z.object({ tag: z.string(), pr: z.string() }),
  })
    .then(collectCommits)
    .then(draftRelease)
    .commit();`}</Code></DocSection>
  </DocsShell>;
}
