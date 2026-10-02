import type { Metadata } from "next"
import Link from "next/link"

import { CodeBlock } from "@/components/docs/code-block"
import { DocPage } from "@/components/docs/page"
import { Callout, DocTable, type DocSectionSpec } from "@/components/docs/primitives"

export const metadata: Metadata = {
  title: "Contradictions",
  description:
    "Two claims that cannot both be true, stored as a pair with an actionable question, pinned into every prompt until it is answered."
}

/**
 * Contradictions.
 *
 * The capability that justifies the tiered store existing at all. Everything
 * else on this page follows from one commitment: the agent sees both sides
 * rather than picking one, and a human is asked.
 */

const SECTIONS: readonly DocSectionSpec[] = [
  {
    id: "what",
    title: "What one is",
    body: (
      <>
        <p>
          A contradiction is two claims that cannot both be true, stored as a pair
          with an actionable question. Not a flag on either memory, and not a
          resolution — a third thing, with its own identity and its own lifecycle.
        </p>
        <p>
          The question is the part that matters. &ldquo;These memories
          disagree&rdquo; is not actionable; &ldquo;Which is it?&rdquo; is. Every
          tension carries a question phrased so it can be answered in a sentence,
          because the answer usually arrives as an ordinary user message and the
          thing doing the asking is a prompt.
        </p>
        <CodeBlock language="text">{`### Unresolved Contradictions
- [CRITICAL] "We deploy on Fridays" conflicts with "We never deploy on Fridays". Ask: Which is it?`}</CodeBlock>
      </>
    )
  },
  {
    id: "pinned",
    title: "Why it is always injected",
    body: (
      <>
        <p>
          A tension is pinned into every context build until it is resolved, and it
          is the one thing always injected in full regardless of budget — because
          the whole point is that the agent sees both sides rather than picking one.
        </p>
        <p>
          This is the concrete case for the exemption{" "}
          <Link href="/docs/tiers">L0 gets from the budget</Link>. A tension that
          got truncated away is indistinguishable from a tension that was never
          detected, and both look exactly like a working system right up until the
          agent acts on the wrong premise.
        </p>
        <Callout>
          The severity tag on a tension — <code>CRITICAL</code> above — is not
          severity of the disagreement but of what the agent might do while it is
          unresolved. It is what makes triage possible when there are more open
          tensions than anyone has time to read.
        </Callout>
      </>
    )
  },
  {
    id: "detecting",
    title: "How one is detected",
    body: (
      <>
        <p>
          Detection is deliberately conservative, because a false tension is
          expensive in a way a missed one is not. A tension that does not exist
          pins two claims into every prompt forever and trains the user to ignore
          the section; a missed one is a single bad turn.
        </p>
        <p>
          Two paths produce one. A{" "}
          <Link href="/docs/reconciliation">merge candidate</Link> that cannot
          satisfy{" "}
          <Link href="/docs/reconciliation">the merge rule</Link> while sharing
          enough structure to be about the same thing is a tension, not two
          memories. Separately,{" "}
          <Link href="/docs/capture">capture</Link> compares a new statement
          against what is held, and an explicit negation of a stored claim —{" "}
          &ldquo;we never deploy on Fridays&rdquo;, against a stored{" "}
          &ldquo;we deploy on Fridays&rdquo; — is the clearest signal there is.
        </p>
        <p>
          And a human can always record one directly, which matters more than it
          sounds: the deterministic paths only see claims that were both stored.
          &ldquo;These two things you told me cannot both be true&rdquo; is
          something a person notices and the service cannot.
        </p>
        <CodeBlock language="ts">{`await memory.tensions.create({
  claimA: "We deploy on Fridays",
  claimB: "We never deploy on Fridays",
  actionableQuestion: "Which is it?",
  impact: "critical"
})`}</CodeBlock>
      </>
    )
  },
  {
    id: "resolving",
    title: "Resolving one",
    body: (
      <>
        <p>
          Resolving keeps the resolution, including the reusable pattern it
          revealed. Deleting it would mean rediscovering the same contradiction
          next month.
        </p>
        <p>
          That pattern is the genuinely valuable output. A resolved tension is
          evidence about how this project actually works — that the Fridays rule
          was a deployment-window constraint rather than a general one, say — and
          it is stored as a fact that participates in{" "}
          <Link href="/docs/tiers">tiering</Link> like any other.
        </p>
        <DocTable
          columns={[
            { label: "Operation", width: "10rem" },
            { label: "What it does" }
          ]}
          rows={[
            ["Open", "Pinned into every prompt, listed in the dashboard by status."],
            [
              "Resolved",
              "Marks the answer, stores the pattern it revealed, unpins the pair. The resolution is kept."
            ],
            [
              "Reopened",
              "Pins the pair again. Used when the answer turns out to have been situational."
            ],
            ["Deleted", "Removes it entirely. Discards the pattern too."]
          ]}
        />
        <p>
          Reopen and delete are separate because the second is destructive and the
          first is not. A resolution that was right for one deploy cycle is common
          enough that conflating it with deletion loses the pattern.
        </p>
      </>
    )
  },
  {
    id: "where",
    title: "Where to look",
    body: (
      <>
        <p>
          <Link href="/dashboard/tensions">Tensions</Link> lists them by status with
          resolve and reopen, and{" "}
          <Link href="/dashboard">the overview</Link> counts the open ones, because
          an unresolved tension is the single most likely thing to need a human.
        </p>
        <p>
          They also show up in <code>GET /v1/stats</code> and in{" "}
          <code>GET /v1/tensions?status=open</code>, so a build can surface the
          count without reading prose.{" "}
          <Link href="/docs/api">The API reference</Link> has both.
        </p>
      </>
    )
  }
]

export default function TensionsPage() {
  return (
    <DocPage
      href="/docs/tensions"
      title="Contradictions"
      description="Two claims that cannot both be true, stored as a pair with an actionable question — and pinned into every prompt until a human answers it."
      sections={SECTIONS}
    />
  )
}
