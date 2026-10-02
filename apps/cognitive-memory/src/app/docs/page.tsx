import type { Metadata } from "next"
import Link from "next/link"

import { CodeBlock } from "@/components/docs/code-block"
import { DocPage } from "@/components/docs/page"
import {
  Callout,
  DocTable,
  PageCards,
  type DocSectionSpec
} from "@/components/docs/primitives"
import { findDocPage } from "@/lib/docs"

export const metadata: Metadata = {
  title: "Overview",
  description:
    "A memory service for agents: durable facts stored in four tiers, contradictions held open, a bounded prompt block, and a recorded reason for every line injected."
}

/**
 * The index.
 *
 * The landing page argues that this is worth having. This page is what you read
 * once you have decided, so it opens with the shape of the thing and a way in,
 * and every rule it states corresponds to something enforced in code and pinned
 * by a test — a document that describes intended behaviour rather than actual
 * behaviour is worse than none.
 */

/**
 * Resolved through the map rather than by index, so a page that moves between
 * groups does not quietly stop appearing on the index.
 */
const concept = (slug: string) => findDocPage(`/docs/${slug}`)!

const SECTIONS: readonly DocSectionSpec[] = [
  {
    id: "shape",
    title: "The shape of it",
    body: (
      <>
        <p>
          Most &ldquo;memory&rdquo; for agents is a list of strings and a similarity
          search. That is enough to make a demo feel like recall, and it fails in
          three specific ways that show up in production.
        </p>
        <p>
          <b>It cannot hold a contradiction.</b> Two stored claims that cannot both
          be true are, in a flat list, indistinguishable from two unrelated facts.
          There is nowhere to put &ldquo;these disagree&rdquo; — so one of them
          quietly wins, and the agent proceeds on a premise the user has already
          contradicted.
        </p>
        <p>
          <b>It has no notion of cost.</b> A similarity search returns k results,
          and k is chosen by whoever wrote the call. As the store grows, so does
          the prompt, and the material included falls into two groups: things that
          were relevant, and things that merely looked like they might be. The
          second group is what Chroma&rsquo;s 2025 context-rot report measures.
        </p>
        <p>
          <b>It cannot say why something matched.</b> A cosine score is not an
          explanation. When a user asks why their agent believes something, the
          honest answer is a floating point number, which is not an answer.
        </p>
        <p>
          This service is built around those three gaps. It stores{" "}
          <Link href="/docs/tiers">tiers</Link>, so cost per turn is a decision
          rather than an accident. It stores contradictions as first-class rows.
          And every injection is recorded with the rule that produced it, so the{" "}
          <Link href="/dashboard/context">dashboard</Link> can show the exact block
          a model is about to receive.
        </p>
        <p>
          The <Link href="/docs/model">model page</Link> is the long version of this
          argument.
        </p>
      </>
    )
  },
  {
    id: "turn",
    title: "How a turn works",
    body: (
      <>
        <p>
          Five steps, in this order. The order is the design: capture runs
          deterministically before anything optional, and the prompt is assembled
          before the model is called rather than assembled from whatever the model
          remembered to ask for.
        </p>
        <ol className="ml-5 list-decimal space-y-4">
          <li>
            <b className="text-zinc-200">Capture.</b> Deterministic patterns first:
            URLs, assignments, stated requirements. No model, no refusal, no silent
            loss. See <Link href="/docs/capture">what gets learned</Link>.
          </li>
          <li>
            <b className="text-zinc-200">Reconcile.</b> Restatements are folded
            into what is held — but only when the merge keeps every distinctive
            token, or both entries are kept. See{" "}
            <Link href="/docs/reconciliation">reconciliation</Link>.
          </li>
          <li>
            <b className="text-zinc-200">File.</b> Into a tier. New facts land hot,
            so the next prompt already has them. See{" "}
            <Link href="/docs/tiers">the four tiers</Link>.
          </li>
          <li>
            <b className="text-zinc-200">Plan.</b> A gist line for everything; a
            full body only for identifiers the message named, unresolved
            contradictions, and weak domains. See{" "}
            <Link href="/docs/injection">what goes into the prompt</Link>.
          </li>
          <li>
            <b className="text-zinc-200">Inject.</b> Inside a token budget that
            reports when it truncated.
          </li>
        </ol>
      </>
    )
  },
  {
    id: "measured",
    title: "Measured",
    body: (
      <>
        <p>
          <code>pnpm --filter cognitive-memory measure</code>, on 200 stored
          memories. The interesting figure is the last row: 77% fewer tokens than
          injecting everything, with recall that does not depend on a model being
          available.
        </p>
        <DocTable
          columns={[{ label: "Measure", width: "14rem", mono: true }, { label: "p50" }]}
          rows={[
            ["Recall", "5.0 ms"],
            ["Context build", "2.9 ms"],
            ["Index + triggers", "1,320 tokens"],
            ["Every body", "3,643 tokens"]
          ]}
        />
        <Callout>
          Every context build is also recorded — the block, the reason each line was
          included, its token cost, and the identifiers the triggering message
          named. That is what makes <Link href="/dashboard/analytics">analytics</Link>{" "}
          an argument rather than a decoration: 118k tokens is a number with no
          action attached, and &ldquo;104k of it was index lines and 2k was full
          bodies&rdquo; says the store has nothing worth promoting, which has the
          opposite fix from raising the ceiling.
        </Callout>
        <p>
          The figures are reproduced in <Link href="/docs/self-hosting">self-hosting</Link>,
          with the command that regenerates them.
        </p>
      </>
    )
  },
  {
    id: "next",
    title: "Where to go next",
    body: (
      <>
        <p>
          If you want it working, <Link href="/docs/quickstart">the quickstart</Link>{" "}
          is two calls and a key. If you are deciding whether to trust it, read{" "}
          <Link href="/docs/injection">what goes into the prompt</Link> and{" "}
          <Link href="/docs/recall">recall</Link> — those two pages are where the
          design bets are, and both are the ones to check against the code.
        </p>
        <p>
          The smallest useful integration is a context build before the model runs
          and a turn recorded after it finishes. Nothing else is required, and
          nothing else is what makes memory work:
        </p>
        <CodeBlock language="sh">{`# what the agent should know before it answers
curl -X POST localhost:3000/api/v1/context \\
  -H "Authorization: Bearer $COGNITIVE_MEMORY_KEY" \\
  -H "content-type: application/json" \\
  -d '{"userMessage":"deploy ZQ7X4M2K to staging"}'

# what it should remember from the finished turn
curl -X POST localhost:3000/api/v1/turns \\
  -H "Authorization: Bearer $COGNITIVE_MEMORY_KEY" \\
  -H "content-type: application/json" \\
  -d '{"userMessage":"...","assistantResponse":"..."}'`}</CodeBlock>
      </>
    )
  }
]

export default function DocsOverviewPage() {
  return (
    <DocPage
      href="/docs"
      title="Cognitive Memory"
      description="A memory service for agents. It stores durable facts, holds open the ones that contradict each other, decides what to put in front of a model each turn, and tells you why. The retrieval path is deterministic by design, and the reasoning behind every threshold is written down because the numbers are only defensible with it."
      actions={
        <>
          <Link
            href="/docs/quickstart"
            className="rounded-lg bg-violet-500 px-3.5 py-2 text-[13px] font-medium text-white transition hover:bg-violet-400"
          >
            Start with the quickstart
          </Link>
          <Link
            href="/dashboard"
            className="rounded-lg border border-white/12 px-3.5 py-2 text-[13px] text-zinc-300 transition hover:border-white/25"
          >
            Get an API key
          </Link>
          <Link
            href="/#tiers"
            className="rounded-lg border border-white/12 px-3.5 py-2 text-[13px] text-zinc-300 transition hover:border-white/25"
          >
            Back to the overview
          </Link>
        </>
      }
      lead={<PageCards label="Start here" pages={[concept("quickstart"), concept("integrating"), concept("injection"), concept("recall")]} />}
      sections={SECTIONS}
    />
  )
}
