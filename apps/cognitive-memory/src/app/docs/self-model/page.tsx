import type { Metadata } from "next"
import Link from "next/link"

import { CodeBlock } from "@/components/docs/code-block"
import { DocPage } from "@/components/docs/page"
import {
  Callout,
  DocTable,
  Warning,
  type DocSectionSpec
} from "@/components/docs/primitives"

export const metadata: Metadata = {
  title: "The self-model",
  description:
    "Reliability per domain as a moving average over recorded outcomes, why that average carries a prior of two, and why nothing here is inferred."
}

/**
 * The self-model.
 *
 * How the agent is told what it is bad at. Entirely opt-in and entirely
 * explicit: nothing is inferred from behaviour, because an inferred reliability
 * score that nobody recorded is a number nobody can act on.
 */

const SECTIONS: readonly DocSectionSpec[] = [
  {
    id: "what",
    title: "What it tracks",
    body: (
      <>
        <p>
          Reliability per domain, tracked as a moving average over outcomes you
          record. Any active domain below 75% is written into every prompt under a{" "}
          <code>Weak Domains — Under 75% Reliability</code> heading, listing its
          known failure patterns and what has worked.
        </p>
        <CodeBlock language="ts">{`await memory.selfModel.record({
  domain: "database",
  success: false,
  failurePattern: "migrated the schema without a dry run"
})`}</CodeBlock>
        <p>
          A domain is a label you choose and pass on the turn — the same{" "}
          <code>domain</code> the{" "}
          <Link href="/docs/quickstart">quickstart</Link> sets. There is no
          classifier deciding what a task was about, because a misfiled domain
          produces a confident score about the wrong subject.
        </p>
      </>
    )
  },
  {
    id: "prior",
    title: "Why the average carries a prior",
    body: (
      <>
        <p>
          One detail worth stating plainly, because the obvious formula gets it
          wrong. The average carries a prior of <b className="text-zinc-200">two
          samples</b>.
        </p>
        <p>
          Dividing by the sample count makes the first outcome fully replace the
          starting estimate, so a single failed task takes a domain from 0.8 to 0 —
          and the domain then trips the 75% threshold forever, on the strength of
          one data point. With the prior, one failure is a strong signal and ten are
          conclusive, which is what a reliability number should mean.
        </p>
        <p>
          Concretely, with a domain that started at 0.8: the first failure moves it
          to 0.533, the second to 0.4, and the weight keeps shrinking —{" "}
          <code>1 / (min(samples, 10) + 2)</code> — so early evidence moves the
          number and later evidence refines it. The naive version would have put it
          at 0 on the first failure and left it there, tripping the guardrail on
          the strength of a single task.
        </p>
        <Callout>
          A prior is not a thumb on the scale in the direction you want. It is the
          reason one observation cannot manufacture certainty in either direction —
          which is the only property that makes a score worth displaying.
        </Callout>
      </>
    )
  },
  {
    id: "outcomes",
    title: "What counts as an outcome",
    body: (
      <>
        <p>
          Whatever <code>POST /v1/self-model/outcome</code> accepts: a{" "}
          <code>domain</code>, a boolean <code>success</code>, and optionally a{" "}
          <code>failurePattern</code> or a <code>strategy</code>.
        </p>
        <p>
          The optional strings are what turn the score into something actionable,
          because &ldquo;database: 0.6&rdquo; does not suggest a fix and{" "}
          &ldquo;database: 0.6, always migrates without a dry run&rdquo; does. A
          failure contributes its <code>failurePattern</code> to the domain&rsquo;s
          list; a success contributes its <code>strategy</code>. Both are
          deduplicated, so recording the same pattern twice does not pad the
          prompt.
        </p>
        <DocTable
          columns={[
            { label: "Field", width: "10rem", mono: true },
            { label: "What it does" }
          ]}
          rows={[
            [<code key="d">domain</code>, "The subject being scored. Arbitrary label, chosen by you."],
            [
              <code key="s">success</code>,
              "How it went. The score is a function of these and nothing else."
            ],
            [
              <code key="f">failurePattern</code>,
              "On a failure, added to the domain’s known failure patterns — the part that reaches the prompt."
            ],
            [
              <code key="g">strategy</code>,
              "On a success, added to the domain’s recommended strategies."
            ]
          ]}
        />
        <p>
          Every sample behind a score is retained, not just the aggregate.{" "}
          <Link href="/dashboard/self-model">The self-model page</Link> shows them
          individually, which is the difference between a number and an
          explanation.
        </p>
      </>
    )
  },
  {
    id: "nothing-inferred",
    title: "Nothing here is inferred",
    body: (
      <>
        <p>
          Without outcomes recorded through{" "}
          <code>POST /v1/self-model/outcome</code>, the model stays at its priors and
          no weak-domain warning ever fires.
        </p>
        <Warning title="The most common reason this looks broken">
          It is almost always this. The service does not watch your agent fail and
          quietly update a score, because a score nobody recorded has no
          explanation attached and a reliability number without an explanation is a
          feeling. If no weak domains appear, check that outcomes are being
          recorded for the same domain strings you are passing on the turn —{" "}
          <code>database</code> and <code>Database</code> are two domains.
        </Warning>
        <p>
          The same caution applies to{" "}
          <Link href="/docs/tensions">tensions</Link>: both features are fed by
          explicit signals, and a deployment that records neither will have a
          perfectly healthy store that teaches its agent nothing about itself.
        </p>
      </>
    )
  },
  {
    id: "injection",
    title: "How a weak domain reaches the prompt",
    body: (
      <>
        <p>
          As a <Link href="/docs/injection">guardrail</Link> at{" "}
          <Link href="/docs/tiers">L0</Link> — a full body, always, outside the
          budget — headed{" "}
          <code>Weak Domains — Under 75% Reliability</code>. It carries the
          domain&rsquo;s known failure patterns and what has worked, which is the
          form that changes behaviour: &ldquo;you have been unreliable at
          database&rdquo; is a fact, and the patterns are instructions.
        </p>
        <p>
          The threshold is 75% because below that a domain is costing more in
          rework than it saves in context. It is a deployment-wide constant rather
          than a setting, on the grounds that a per-organisation reliability
          threshold is a number nobody would be able to justify tuning.
        </p>
      </>
    )
  }
]

export default function SelfModelPage() {
  return (
    <DocPage
      href="/docs/self-model"
      title="The self-model"
      description="Reliability per domain, over outcomes you record. Nothing is inferred — which is the point, and also the most common reason it looks like it is not working."
      sections={SECTIONS}
    />
  )
}
