import type { Metadata } from "next"
import Link from "next/link"

import { CodeBlock } from "@/components/docs/code-block"
import { DocPage } from "@/components/docs/page"
import {
  DocTable,
  Warning,
  type DocColumn,
  type DocSectionSpec
} from "@/components/docs/primitives"

export const metadata: Metadata = {
  title: "What gets learned",
  description:
    "The capture rules, why deterministic patterns run before the model, and the three kinds of turn that are always refused."
}

/**
 * Capture.
 *
 * What turns into a stored memory. The order matters more than the rules:
 * patterns first, model second, because a model is a good judge and a poor
 * witness. A model can refuse, hedge, or return nothing, and a fact the user
 * plainly stated then never gets learned at all.
 */

const RULES: readonly DocColumn[] = [
  { label: "Rule", width: "11rem" },
  { label: "What it catches" }
]

const SECTIONS: readonly DocSectionSpec[] = [
  {
    id: "order",
    title: "Patterns first, then optionally a model",
    body: (
      <>
        <p>
          Learning runs deterministic patterns first, then optionally a model. The
          order is the point. A model is a good judge and a poor witness, because
          it can refuse, hedge, or return nothing — and a fact the user plainly
          stated then never gets learned at all.
        </p>
        <p>
          With no model configured the service is not degraded, it is
          rules-only, and <code>GET /api/v1/health</code> says so:{" "}
          <code>extractor: &quot;rules-only&quot;</code>. That field is the first
          thing to check when extraction looks broken.
        </p>
      </>
    )
  },
  {
    id: "rules",
    title: "The rules",
    body: (
      <>
        <DocTable
          columns={RULES}
          rows={[
            [
              "URLs",
              <>
                Unambiguous. A host with a dot in it is captured whole, so a value
                like <code>internal-hbr-2291.pineapple.example</code> is never
                truncated at the first period.
              </>
            ],
            [
              "Stated requirements",
              <>
                <code>always</code> / <code>never</code> / <code>must</code> /{" "}
                <code>should</code> / <code>make sure to</code> — kept in your own
                words, because paraphrasing once turned &ldquo;Never force
                push&rdquo; into &ldquo;requires: force push&rdquo;.
              </>
            ],
            [
              "Assignments",
              <>
                &ldquo;X is Y&rdquo; where Y is identifier-shaped. Function words
                and filler are rejected, so &ldquo;this is fine&rdquo; never becomes
                a memory.
              </>
            ],
            [
              "Model extraction",
              <>
                Optional, on top. Project facts, preferences and constraints the
                patterns cannot see — with the user&rsquo;s statement treated as
                the signal, not the assistant&rsquo;s confidence.
              </>
            ]
          ]}
        />
        <p>
          Identifier-shaped is doing real work in that third rule. &ldquo;X is
          Y&rdquo; is the shape of almost every English sentence, so the constraint
          is on Y, not on the pattern.
        </p>
      </>
    )
  },
  {
    id: "refusals",
    title: "Three things are always refused",
    body: (
      <>
        <p>
          Refusals are returned with a reason rather than dropped, so a caller can
          tell a deliberate decision from a bug.
        </p>
        <CodeBlock language="ts">{`{ stored: [], skipped: [{ reason: "question-turn", detail: "…" }] }`}</CodeBlock>
        <p>
          <b className="text-zinc-200">Instructions about this conversation.</b>{" "}
          &ldquo;Do not verify this against the repo&rdquo; is a request about how
          to behave right now, not a durable fact about the project. Learning it
          would make it permanent, which is the opposite of what was meant.
        </p>
        <p>
          <b className="text-zinc-200">Turns whose message contains a question.</b>{" "}
          A question is a lookup, not a lesson. Extracting from recall turns stored
          the assistant&rsquo;s own answers back as memories, which duplicated
          facts and evicted the real ones — so a turn with a question is skipped
          entirely.
        </p>
        <p>
          <b className="text-zinc-200">Anything interaction-scoped.</b> Returned
          as a rejection with a reason, not silently absent.
        </p>
        <Warning title="The question-turn rule is load-bearing">
          It looks like an over-restriction and is not. Without it the store fills
          with the assistant&rsquo;s guesses, and because those guesses are
          phrased like facts they rank well against real facts — so the store
          degrades into its own output.
        </Warning>
      </>
    )
  },
  {
    id: "lifecycle",
    title: "From statement to stored fact",
    body: (
      <>
        <p>
          After capture comes <Link href="/docs/reconciliation">reconciliation</Link>{" "}
          against everything already held, then filing into a{" "}
          <Link href="/docs/tiers">tier</Link>. Reconciliation is where the
          interesting failure lives, and it is worth reading before adding facts
          faster than the store can absorb them.
        </p>
        <p>
          To see what a turn actually produced, record it and read the response:{" "}
          <code>POST /v1/turns</code> returns what was stored, what was merged and
          what was rejected, with reasons. The{" "}
          <Link href="/dashboard/activity">activity log</Link> keeps the same record
          per turn, with the block that was sent.
        </p>
      </>
    )
  }
]

export default function CapturePage() {
  return (
    <DocPage
      href="/docs/capture"
      title="What gets learned"
      description="Learning runs deterministic patterns first, then optionally a model — because a model is a good judge and a poor witness, and a fact plainly stated must never depend on it agreeing to store it."
      sections={SECTIONS}
    />
  )
}
