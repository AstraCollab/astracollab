import type { Metadata } from "next"
import Link from "next/link"

import { CodeBlock } from "@/components/docs/code-block"
import { DocPage } from "@/components/docs/page"
import { Callout, type DocSectionSpec } from "@/components/docs/primitives"

export const metadata: Metadata = {
  title: "Recall",
  description:
    "Token-overlap ranking with no model and no embedding service — the trade being made, and the register of facts that makes it the right one."
}

/**
 * Recall.
 *
 * The most opinionated page here, and the one most worth arguing with. Token
 * overlap instead of embeddings is a deliberate trade, so this page states the
 * trade rather than the capability.
 */

const SECTIONS: readonly DocSectionSpec[] = [
  {
    id: "how",
    title: "How ranking works",
    body: (
      <>
        <p>
          Ranking is token overlap, normalised by the smaller side, with
          paraphrases of one fact collapsed to their best-scoring instance. No
          model and no embedding service is involved, anywhere in the path.
        </p>
        <CodeBlock language="ts">{`const { results, empty } = await memory.recall.search({
  query: "where do we deploy",
  limit: 8
})`}</CodeBlock>
        <p>
          Normalising by the smaller side rather than the larger is what makes a
          short query score sensibly against a long fact. Cosine, Jaccard and
          overlap-ratio all rank these pairs differently, and the one that divides
          by the longer string systematically under-ranks short stored facts
          against long queries — which is most of them.
        </p>
        <p>
          Collapsing paraphrases to their best-scoring instance happens before the
          limit is applied, so <code>limit: 8</code> means eight distinct facts
          rather than eight ways of saying one.
        </p>
      </>
    )
  },
  {
    id: "trade",
    title: "The trade",
    body: (
      <>
        <p>
          A semantic index earns its keep on fuzzy paraphrase over very large
          corpora. The register an agent actually stores is URLs, build ids, ports,
          paths and conventions — where exact tokens are both faster and more
          precise, and where an embedding adds latency, cost, and a failure mode at
          the one moment you cannot afford one: mid-conversation.
        </p>
        <p>
          So the trade is: worse at paraphrase, better at everything else. A
          question that says &ldquo;where does staging live&rdquo; will not match a
          memory that says <code>ZQ7X4M2K</code>, and no embedding would have
          rescued that either. A question that says &ldquo;what&rsquo;s our deploy
          host&rdquo; will match a memory containing{" "}
          <code>internal-hbr-2291.pineapple.example</code> on the word{" "}
          <code>deploy</code> if it has one, and a model-free index cannot fail to
          be available when the provider is not.
        </p>
      </>
    )
  },
  {
    id: "consequence",
    title: "The practical consequence",
    body: (
      <>
        <p>
          Recall quality is a property of the deployment rather than of the
          provider. A question that shares no words with a memory will not match
          it — which is why the index is pre-staged into{" "}
          <Link href="/docs/injection">every prompt</Link> as well. A memory you
          never had to ask for is a memory that cannot be missed.
        </p>
        <p>
          That pairing is the actual design: cheap broad coverage from the index
          line, exact retrieval from recall, and a full body only when the message
          named something concrete. Neither mechanism has to be good at the
          other&rsquo;s job.
        </p>
      </>
    )
  },
  {
    id: "empty",
    title: "An empty result is an answer",
    body: (
      <>
        <p>
          An empty result returns <code>empty: true</code> rather than an empty
          array. The distinction is the point: a search that ran and found
          nothing is a fact about your store, and a caller that cannot tell it
          from a search that failed will invent something to fill the gap.
        </p>
        <Callout>
          The SDK turns that into &ldquo;if you were not told, say so rather than
          guessing&rdquo;, because a silent miss is how a language model invents a
          fact it was never given.
        </Callout>
      </>
    )
  },
  {
    id: "inspect",
    title: "Inspecting a match",
    body: (
      <>
        <p>
          The{" "}
          <Link href="/dashboard/memory">recall inspector</Link> names the terms
          that matched for any query, which is the fastest way to understand why
          something ranked. It is also the honest answer to &ldquo;why did this come
          back&rdquo; — a list of overlapping tokens, not a score pretending to be
          a reason.
        </p>
        <p>
          <code>limit</code> defaults to{" "}
          <code>COGNITIVE_MEMORY_DEFAULT_RECALL_LIMIT</code>, which is 8. A recall is
          not usually the thing standing between you and a correct answer —{" "}
          <Link href="/docs/injection">the context build</Link> is — so this is not
          the number to raise first.
        </p>
      </>
    )
  }
]

export default function RecallPage() {
  return (
    <DocPage
      href="/docs/recall"
      title="Recall"
      description="Token overlap, normalised by the smaller side, with no model and no embedding service anywhere in the path. Here is the trade that buys."
      sections={SECTIONS}
    />
  )
}
