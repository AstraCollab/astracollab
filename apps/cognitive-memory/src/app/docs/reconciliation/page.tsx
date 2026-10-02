import type { Metadata } from "next"
import Link from "next/link"

import { DocPage } from "@/components/docs/page"
import { Callout, DocTable, type DocSectionSpec } from "@/components/docs/primitives"

export const metadata: Metadata = {
  title: "Reconciliation",
  description:
    "How a restatement is folded into what is already held, the one rule that governs every merge, and why a false positive is cheaper than a false negative."
}

/**
 * Reconciliation.
 *
 * Two statements can say the same thing, and storing both is how a memory layer
 * becomes unsearchable inside a week. This page is the rule that decides when
 * they are the same thing — and the rule is deliberately biased, which is the
 * whole design.
 */

const SECTIONS: readonly DocSectionSpec[] = [
  {
    id: "problem",
    title: "The problem",
    body: (
      <>
        <p>
          A user corrects themselves constantly, and most corrections are
          restatements: &ldquo;run migrations against staging&rdquo;, then{" "}
          &ldquo;always run migrations against staging&rdquo;, then{" "}
          &ldquo;reminder that we run migrations against staging before deploys&rdquo;.
          Stored as three rows, the third is the best match for the word{" "}
          <code>migrations</code> and the store now contains two facts per real
          fact.
        </p>
        <p>
          That compounds. Duplicate index lines cost budget on every single turn,
          they crowd out real facts from the same tier, and after a week the
          retrieval is mostly returning the store&rsquo;s own history.
        </p>
        <p>
          So a candidate is compared against what is already held and folded in —
          under one rule that governs every merge.
        </p>
      </>
    )
  },
  {
    id: "rule",
    title: "The merge rule",
    body: (
      <>
        <Callout>
          A merge must keep every distinctive token of both sides. A replacement
          missing one is refused, and both entries are kept.
        </Callout>
        <p>
          Distinctive tokens are the ones that carry a fact&rsquo;s identity —
          identifiers, numbers, codes. Function words and generic nouns
          (&ldquo;file&rdquo;, &ldquo;name&rdquo;, &ldquo;project&rdquo;) are
          excluded because they recur in every restatement and hide real
          differences.
        </p>
        <p>
          Concretely: &ldquo;Always run migrations against staging&rdquo; and
          &ldquo;Always run migrations against staging, never production&rdquo; do
          <b>not</b> merge. The second says strictly more, and dropping the
          qualifier is exactly the failure this rule exists to prevent.
        </p>
      </>
    )
  },
  {
    id: "bias",
    title: "Why the test is biased",
    body: (
      <>
        <p>
          The test is deliberately biased towards reporting a loss. A false
          positive — two things reported as distinct that are actually the same —
          costs one duplicate row, which is recoverable and visible. A false
          negative — two things merged that were not — deletes a fact
          permanently, and nothing in the system will ever report it.
        </p>
        <DocTable
          columns={[
            { label: "Wrong in this direction", width: "11rem" },
            { label: "Costs" },
            { label: "Recoverable" }
          ]}
          rows={[
            [
              "Reports a duplicate that is not",
              "One extra row, one index line of budget per turn",
              <>
                <Link href="/dashboard/memory">Visible in the library</Link>, and
                deletable
              </>
            ],
            [
              "Merges two different facts",
              "A fact, permanently",
              "No. Nothing reports it."
            ]
          ]}
        />
        <p>
          The asymmetry is the argument. When both errors are invisible, choose the
          one that leaves evidence.
        </p>
      </>
    )
  },
  {
    id: "decision",
    title: "The ADD / MERGE / REPLACE / REJECT decision",
    body: (
      <>
        <p>
          With a model configured, the decision is made{" "}
          <b className="text-zinc-200">once per turn for all candidates
          together</b>, rather than per candidate. One call sees the whole set, so
          two statements in the same message that overlap are reconciled against
          each other rather than against a store neither of them has seen yet.
        </p>
        <p>
          Any failure falls back to keeping both. That is the same bias as the
          merge rule, applied one level up: a model that is unavailable, times out,
          or returns something unparseable must not be able to delete anything.
        </p>
        <p>
          The response from <code>POST /v1/turns</code> reports what happened to
          every candidate, so the decision is inspectable rather than inferred from
          what is in the store afterwards.{" "}
          <Link href="/docs/api">The API reference</Link> has the shape.
        </p>
      </>
    )
  },
  {
    id: "tiers",
    title: "Where the result lands",
    body: (
      <>
        <p>
          A merged fact inherits the higher of the two tiers, because a fact that
          was worth promoting did not stop being worth it. New statements that
          merge into nothing new land in{" "}
          <Link href="/docs/tiers">L1</Link>, hot, so the very next prompt has
          them.
        </p>
        <p>
          What never happens is a merge that demotes a fact as a side effect. A
          correction that adds a qualifier is a new, stricter fact — and it is
          stored as one, with the original kept.
        </p>
      </>
    )
  }
]

export default function ReconciliationPage() {
  return (
    <DocPage
      href="/docs/reconciliation"
      title="Reconciliation"
      description="Two statements can say the same thing, and storing both is how a memory layer becomes unsearchable inside a week. One rule governs every merge, and it is biased on purpose."
      sections={SECTIONS}
    />
  )
}
