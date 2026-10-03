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
  title: "Quickstart",
  description:
    "Mint an API key, wire two calls around your model, and have memory working in a single turn."
}

/**
 * The quickstart.
 *
 * Two calls, in a specific order, and nothing else. Written for the reader who
 * has already decided and wants it working before they go and read the
 * reasoning — which is why every step here is the smallest one that survives
 * contact with a real agent, and the alternatives are one paragraph away rather
 * than a page away.
 */

const SECTIONS: readonly DocSectionSpec[] = [
  {
    id: "key",
    title: "Get a key",
    body: (
      <>
        <p>
          Sign in to the <Link href="/dashboard">dashboard</Link>, create an
          organisation if you do not have one, and issue a key from{" "}
          <Link href="/dashboard/keys">Keys</Link>. The secret is shown exactly
          once — it is stored as a sha256 hash, so it cannot be shown again and
          cannot be recovered. If you lose it, revoke it and issue another.
        </p>
        <p>
          Keys are scoped. <code>memories:read</code> and{" "}
          <code>memories:write</code> are the two that matter, and{" "}
          <code>stats:read</code> is optional. An agent that only reads should only
          hold the read scope; see <Link href="/docs/auth">credentials</Link> for
          what a key cannot do.
        </p>
        <Callout>
          The dashboard itself is authenticated by your session, not by a key.
          You do not need a key to look at your own memory, and reaching for one
          would train exactly the habit this service discourages.
        </Callout>
      </>
    )
  },
  {
    id: "install",
    title: "Install the client",
    body: (
      <>
        <p>
          One official package, <code>cogmemory</code>. It is ~3kB
          gzipped, ESM-first, and its only hard dependency is <code>ofetch</code>.
        </p>
        <CodeBlock language="sh">{"pnpm add cogmemory"}</CodeBlock>
        <p>
          It contains two things, deliberately. The <b>client</b> talks to this
          service over HTTP. The <b>deterministic layer</b> — tiering, ranking,
          reconciliation, the fast gate — runs in-process with no database, no
          network, and no model in the retrieval path. Shipping both means a
          consumer can start against the service and later run the same logic
          locally without the behaviour changing underneath them.{" "}
          <Link href="/docs/sdk">The SDK page</Link> is the long version.
        </p>
      </>
    )
  },
  {
    id: "turn",
    title: "Wire it around one turn",
    body: (
      <>
        <p>
          <code>runTurn</code> is the recommended entry point, because the order is
          the part that is easy to get wrong: build context keyed on the message
          being answered, run the model, learn from the finished exchange, then
          record how the domain went.
        </p>
        <CodeBlock language="ts">{`import { createClient, runTurn } from "cogmemory"

const memory = createClient({
  apiKey: process.env.COGNITIVE_MEMORY_KEY!,
  baseUrl: "http://localhost:3000"
})

const { context, learning, learningSkipped } = await runTurn(
  memory,
  { userMessage, run: (block) => callYourModel(block, userMessage) },
  { domain: "database", sessionId }
)

// context.text is the block: prepend it to your system prompt.
// context.entries says which memory produced each line, and what it cost.
`}</CodeBlock>
        <p>
          The last two steps never fail the turn. A memory outage cannot take down
          a model call that already succeeded, so the helper catches and reports
          instead of rethrowing — and <code>learningSkipped</code> is returned
          rather than left null, because a silent skip looks identical to a working
          one until the thing you taught it never comes back.
        </p>
        <Warning title="Set a domain">
          <code>domain</code> is the input that makes the{" "}
          <Link href="/docs/self-model">self-model</Link> mean anything. Without it
          the reliability scores stay at their priors and no weak-domain warning
          ever fires, which is the most common reason this looks like it is not
          working.
        </Warning>
      </>
    )
  },
  {
    id: "without-sdk",
    title: "Without the SDK",
    body: (
      <>
        <p>
          The API is a dozen JSON endpoints over bearer auth, so any HTTP client
          does it. Two calls are enough for memory to work: one before the model
          runs, one after it finishes.
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
        <p>
          <code>POST /v1/context</code> returns the block to prepend plus the
          entries that produced it; <code>POST /v1/turns</code> returns what was
          stored, merged and rejected. The full surface is in the{" "}
          <Link href="/docs/api">API reference</Link>.
        </p>
      </>
    )
  },
  {
    id: "check",
    title: "Check that it learned",
    body: (
      <>
        <p>
          Do not trust the first turn — verify the second one. Teach it a fact,
          then ask about it in a new session. If the fact is in the prompt, memory
          is working; if it is not,{" "}
          <Link href="/dashboard/context">the context preview</Link> shows the exact
          block your agent would have been given, with the reason and cost of every
          line, which is the fastest way to find out why.
        </p>
        <DocTable
          columns={[
            { label: "Where", width: "11rem" },
            { label: "What it answers" }
          ]}
          rows={[
            [
              <code key="a">/dashboard/context</code>,
              "What the block would be for any message you paste."
            ],
            [
              <code key="b">/dashboard/activity</code>,
              "What was actually sent, with the reason each line was included."
            ],
            [
              <code key="c">/dashboard/memory</code>,
              "What is held, by tier, and a recall inspector naming the terms that matched."
            ],
            [
              <code key="d">/dashboard/tensions</code>,
              "Contradictions nobody has resolved."
            ]
          ]}
        />
        <p>
          <Link href="/dashboard/analytics">Analytics</Link> is the one to read when
          the numbers look wrong. It splits the token spend by the rule that caused
          each line, so &ldquo;the whole budget went to index lines&rdquo; is a
          diagnosis rather than a feeling.
        </p>
      </>
    )
  }
]

export default function QuickstartPage() {
  return (
    <DocPage
      href="/docs/quickstart"
      title="Quickstart"
      description="Memory is two calls and a key. Get a credential, wrap one model call, and confirm on the second turn that the fact came back."
      sections={SECTIONS}
    />
  )
}
