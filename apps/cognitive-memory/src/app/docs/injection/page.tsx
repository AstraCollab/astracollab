import type { Metadata } from "next"
import Link from "next/link"

import { CodeBlock } from "@/components/docs/code-block"
import { DocPage } from "@/components/docs/page"
import { Callout, DocTable, type DocSectionSpec } from "@/components/docs/primitives"

export const metadata: Metadata = {
  title: "What goes into the prompt",
  description:
    "The block POST /v1/context returns, the four reasons a line can be there, and the deterministic trigger that promotes an index line to a full body."
}

/**
 * Injection.
 *
 * The page to read if you only read one. Every other decision in the service is
 * downstream of this one: what is worth storing is a question about what is
 * worth spending tokens on, and this is where that is answered.
 */

const SECTIONS: readonly DocSectionSpec[] = [
  {
    id: "shape",
    title: "The shape of the block",
    body: (
      <>
        <p>
          <code>POST /v1/context</code> returns the block to prepend to a system
          prompt, plus the entries that produced it and what each cost. The block
          is text and nothing else — prepend it, and the accounting is already done
          for you.
        </p>
        <CodeBlock language="ts">{`const { text, entries, totalTokens, truncated } =
  await memory.context.build({ userMessage, sessionId })

// entries: one per line, with the reason it was included and its token cost
// truncated: true when the budget bit, rather than a silently shorter prompt`}</CodeBlock>
        <p>
          Section headings inside the block are part of the wire format and are
          asserted in tests:{" "}
          <code>⚠️ Correction Detected In This Message</code>,{" "}
          <code>Weak Domains — Under 75% Reliability</code>,{" "}
          <code>Memory index — established earlier in this project</code>, and{" "}
          <code>Unresolved Contradictions</code>. If you grep stored block logs for
          them, they are the strings to grep for.
        </p>
      </>
    )
  },
  {
    id: "reasons",
    title: "Four reasons a line is there",
    body: (
      <>
        <p>
          Every line carries the rule that selected it. This is the whole reason
          the store is auditable: four reasons is a small enough set that a token
          bill can be attributed, and{" "}
          <Link href="/dashboard/analytics">analytics</Link> is then an argument
          rather than a decoration.
        </p>
        <DocTable
          columns={[
            { label: "Reason", width: "7rem", mono: true },
            { label: "Included", width: "8rem" },
            { label: "Why" }
          ]}
          rows={[
            ["index", "gist line", "The default. What nearly every memory costs."],
            [
              "trigger",
              "full body",
              "A concrete identifier absent from the transcript matched this memory."
            ],
            ["tension", "full body", "An unresolved contradiction, with the question to ask."],
            ["guardrail", "full body", "A domain this agent has been unreliable in."]
          ]}
        />
        <Callout>
          Index lines are cheap and full bodies are not, so a spend that is
          almost entirely index lines means the store has nothing worth promoting —
          not that the ceiling is too low. The two have opposite fixes, and the
          reason mix is what tells them apart.
        </Callout>
      </>
    )
  },
  {
    id: "trigger",
    title: "The trigger",
    body: (
      <>
        <p>
          The trigger is the interesting one, and it is deterministic. Pull
          identifiers out of the message — URLs, dotted hosts, paths,
          SCREAMING_SNAKE, camelCase, long kebab-case, hex-ish codes — and keep
          only those absent from the visible transcript.
        </p>
        <p>
          If the caller named something concrete the model cannot already see, and
          a memory mentions it, that memory&rsquo;s body is included. No model is
          asked whether that matters.
        </p>
        <p>
          The &ldquo;absent from the transcript&rdquo; half is what keeps this
          cheap. An identifier the model can already see needs no memory, so
          spending a body on it is pure waste — and in an agent loop the model has
          usually just been told it.
        </p>
      </>
    )
  },
  {
    id: "correction",
    title: "The fast gate",
    body: (
      <>
        <p>
          A synchronous fast gate runs first on the raw message and catches
          explicit corrections — &ldquo;actually, we switched to Postgres&rdquo;,{" "}
          &ldquo;stop using that&rdquo;, &ldquo;that&rsquo;s wrong&rdquo;.
        </p>
        <p>
          When it fires, a{" "}
          <code>Correction Detected In This Message</code> section goes into the
          block, because a user visibly changing their mind is the single most
          reliable signal that the agent&rsquo;s assumption is stale. It is
          synchronous and local because it runs before anything else can be
          skipped, and it is pattern-based for the same reason{" "}
          <Link href="/docs/capture">capture</Link> is: a signal that can be
          missed is not a safety mechanism.
        </p>
      </>
    )
  },
  {
    id: "budget",
    title: "The budget",
    body: (
      <>
        <p>
          Everything above happens inside a token ceiling — index and bodies
          together. When the cap bites the response reports{" "}
          <code>truncated: true</code> and the least recently accessed entries lose
          their place. L0 is exempt:{" "}
          <Link href="/docs/tiers">pinned</Link> content is injected in full
          regardless, because a budget that can silently drop a contradiction is a
          budget that can resolve one without anyone deciding to.
        </p>
        <p>
          The ceiling is <code>COGNITIVE_MEMORY_MAX_TOTAL_TOKENS</code>, set per
          deployment and overridable per organisation.{" "}
          <Link href="/docs/self-hosting">Self-hosting</Link> has the rest of the
          budget surface.
        </p>
      </>
    )
  },
  {
    id: "inspect",
    title: "Inspecting it",
    body: (
      <>
        <p>
          <Link href="/dashboard/context">The context preview</Link> builds the
          block for any message you paste and shows every line with its reason and
          cost. <Link href="/dashboard/activity">Activity</Link> replays the block
          that was actually sent, not the one the planner would produce today —
          re-running the planner against current memory answers &ldquo;what would
          the agent get now&rdquo;, which is a much better-looking answer than the
          one that caused whatever you are trying to understand.
        </p>
        <p>
          The triggering message is not stored with the block — that is the
          conversation, not the memory — but the identifiers inside it are, because
          those are what explain why a full body was spent.
        </p>
      </>
    )
  }
]

export default function InjectionPage() {
  return (
    <DocPage
      href="/docs/injection"
      title="What goes into the prompt"
      description="The block is text and nothing else: prepend it, and the accounting is already done. What is in it, why, and what it cost — line by line."
      sections={SECTIONS}
    />
  )
}
