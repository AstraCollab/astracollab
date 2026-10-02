import type { Metadata } from "next"
import Link from "next/link"

import { DocPage } from "@/components/docs/page"
import { Callout, type DocSectionSpec } from "@/components/docs/primitives"

export const metadata: Metadata = {
  title: "The model",
  description:
    "Why a list of strings plus a similarity search fails in production, and the three gaps this service is built around."
}

/**
 * The model.
 *
 * The argument the rest of the documentation is built on, kept on its own page
 * because it is the thing to check first. If the three gaps below do not sound
 * like problems you have, this is the wrong tool, and it is better to find that
 * out here than after wiring it into an agent.
 */

const SECTIONS: readonly DocSectionSpec[] = [
  {
    id: "premise",
    title: "The premise",
    body: (
      <>
        <p>
          Most &ldquo;memory&rdquo; for agents is a list of strings and a similarity
          search. That is enough to make a demo feel like recall, and it fails in
          three specific ways that show up in production.
        </p>
        <p>
          None of them are retrieval bugs. They are modelling bugs: the store has
          no way to represent what actually happened, so the failure is invisible
          at query time and only shows up as an agent being confidently wrong.
        </p>
      </>
    )
  },
  {
    id: "contradiction",
    title: "It cannot hold a contradiction",
    body: (
      <>
        <p>
          Two stored claims that cannot both be true are, in a flat list,
          indistinguishable from two unrelated facts. There is nowhere to put{" "}
          &ldquo;these disagree&rdquo; — so one of them quietly wins, and the agent
          proceeds on a premise the user has already contradicted.
        </p>
        <p>
          This is the failure that is hardest to notice, because the agent is
          fluent either way. A user says &ldquo;actually, we switched to
          Postgres&rdquo;, the newer statement is retrieved or is not, and either
          way nothing in the system records that there was a disagreement to
          resolve.
        </p>
        <p>
          Here a contradiction is a <Link href="/docs/tensions">first-class
          record</Link>: a pair, an actionable question, and a status. It is pinned
          into every prompt until it is answered.
        </p>
      </>
    )
  },
  {
    id: "cost",
    title: "It has no notion of cost",
    body: (
      <>
        <p>
          A similarity search returns k results, and k is chosen by whoever wrote
          the call. As the store grows, so does the prompt, and the material
          included falls into two groups: things that were relevant, and things that
          merely looked like they might be.
        </p>
        <p>
          The second group is what{" "}
          <a
            href="https://research.trychroma.com/context-rot"
            target="_blank"
            rel="noreferrer"
          >
            Chroma&rsquo;s 2025 context-rot report
          </a>{" "}
          measures. Adding topically-related distractors is not free: it costs
          tokens, it costs attention, and it makes the model worse at the thing you
          were trying to help it with.
        </p>
        <p>
          The fix is to make cost a decision rather than a side effect.{" "}
          <Link href="/docs/tiers">Tiers</Link> do that: what is in the prompt
          every turn, what is only there if something asks for it, and what costs
          nothing at all until it is promoted.
        </p>
      </>
    )
  },
  {
    id: "explanation",
    title: "It cannot say why something matched",
    body: (
      <>
        <p>
          A cosine score is not an explanation. When a user asks why their agent
          believes something, the honest answer is a floating point number, which
          is not an answer.
        </p>
        <p>
          Every injection here is recorded with the rule that produced it —{" "}
          <Link href="/docs/injection">index</Link>, <Link href="/docs/injection">trigger</Link>,{" "}
          <Link href="/docs/injection">tension</Link>, or{" "}
          <Link href="/docs/injection">guardrail</Link> — and its token cost. So{" "}
          <Link href="/dashboard/context">the context preview</Link> can show the
          exact block your agent would be given, line by line, with the reason
          each line is there.
        </p>
        <Callout>
          That is what makes a memory store debuggable. Without it, the only way
          to find out why an agent believed something is to change the prompt and
          observe, which is a debugging loop measured in hours.
        </Callout>
      </>
    )
  },
  {
    id: "consequences",
    title: "What follows from that",
    body: (
      <>
        <p>Three commitments, each of which costs something, and each of which is a decision:</p>
        <ul className="ml-5 list-disc space-y-3">
          <li>
            <b className="text-zinc-200">Contradictions are rows.</b> They are
            stored, pinned, and resolved explicitly. This means the system can
            ask a question instead of picking a winner.
          </li>
          <li>
            <b className="text-zinc-200">Cost is explicit.</b> Every line has a
            price and a reason, and the budget is a number you set rather than a
            side effect of k. See <Link href="/docs/tiers">the four tiers</Link>.
          </li>
          <li>
            <b className="text-zinc-200">No model in the retrieval path.</b>{" "}
            <Link href="/docs/recall">Recall is token overlap</Link>, because a
            memory service that can fail because a provider is slow is a memory
            service you cannot reason about mid-conversation.
          </li>
        </ul>
        <p>
          The last one is a real trade and it is worth stating plainly: fuzzy
          paraphrase over a very large corpus is exactly where an embedding index
          earns its keep, and this gives that up. The reasoning is on the{" "}
          <Link href="/docs/recall">recall page</Link>.
        </p>
      </>
    )
  }
]

export default function ModelPage() {
  return (
    <DocPage
      href="/docs/model"
      title="The model"
      description="What a memory layer has to be able to represent before retrieval quality even becomes the right question — and the three things a list of strings cannot hold."
      sections={SECTIONS}
    />
  )
}
