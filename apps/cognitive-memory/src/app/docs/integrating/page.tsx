import type { Metadata } from "next"
import Link from "next/link"

import { CodeBlock } from "@/components/docs/code-block"
import { CodeTabs } from "@/components/docs/code-tabs"
import { DocPage } from "@/components/docs/page"
import { Callout, Warning, type DocSectionSpec } from "@/components/docs/primitives"

export const metadata: Metadata = {
  title: "Integrating with an agent",
  description:
    "The whole loop end to end: build context, run the model, learn from the finished turn, record how it went — and what to do when the memory service is down."
}

/**
 * Integration.
 *
 * The page to send someone who already has an agent. It is written as one
 * continuous working program rather than as reference fragments, because the
 * four steps are only correct in one order and the order is the thing people get
 * wrong. Every snippet here compiles against the published types, and the
 * emphasised lines are the ones that are load-bearing.
 */

const SECTIONS: readonly DocSectionSpec[] = [
  {
    id: "shape",
    title: "The shape of an integration",
    body: (
      <>
        <p>
          Four steps, and only the first and last touch the network. If your agent
          already has a place where the system prompt is assembled and a place
          where a finished exchange is recorded, you are most of the way there.
        </p>
        <ol className="ml-5 list-decimal space-y-3">
          <li>
            <b className="text-zinc-200">Build context</b> for the message about
            to be answered. Returns text to prepend, plus the accounting.
          </li>
          <li>
            <b className="text-zinc-200">Run the model</b> with that text. Your
            call, unchanged.
          </li>
          <li>
            <b className="text-zinc-200">Learn</b> from the finished exchange.
          </li>
          <li>
            <b className="text-zinc-200">Record the outcome</b> for the domain, so
            the self-model has something to average.
          </li>
        </ol>
        <Callout>
          Step 1 is keyed on the message being <em>answered</em>, not the one
          being sent. That is what makes the trigger work: the block is built from
          what the user just said, so a fact they named gets its full body in the
          prompt that responds to it.
        </Callout>
      </>
    )
  },
  {
    id: "whole-loop",
    title: "The whole loop",
    body: (
      <>
        <p>
          Framework-agnostic, and the shape any framework wrapper should have.
          Note which lines cannot fail the turn.
        </p>
        <CodeBlock language="ts" emphasise={[15, 19, 23, 33]}>{`import { createClient, runTurn } from "@astracollab/cogmem"

const memory = createClient({
  apiKey: process.env.COGNITIVE_MEMORY_KEY!,
  baseUrl: process.env.COGNITIVE_MEMORY_URL ?? "http://localhost:3000"
})

export async function handleTurn(userMessage: string, sessionId: string) {
  const { context, learning, learningSkipped } = await runTurn(
    memory,
    {
      userMessage,
      run: (block) => callYourModel({ system: block, userMessage })
    },
    { domain: "database", sessionId }
  )

  // context.entries says which memory produced each line and what it cost.
  if (context.truncated) log.warn("context truncated", { tokens: context.totalTokens })

  // A silent skip looks exactly like a working one until the thing you taught it
  // never comes back. Check it.
  if (learningSkipped) log.warn("memory did not learn", { learningSkipped })

  return context
}

async function recordOutcome(domain: string, ok: boolean, note?: string) {
  // success is false exactly when a failurePattern is present.
  await memory.selfModel.record({
    domain,
    success: ok,
    ...(ok ? { strategy: note } : { failurePattern: note })
  })
}`}</CodeBlock>
        <p>
          <code>runTurn</code> does all four in the right order and never lets a
          memory failure reach your model call. The two things it cannot do for
          you are the two it leaves to you: deciding what the turn{" "}
          <em>was about</em>, and deciding whether it went well.
        </p>
      </>
    )
  },
  {
    id: "existing-loop",
    title: "Inside an existing agent loop",
    body: (
      <>
        <p>
          Most agents already have the two hooks this needs. Wire memory to the
          point where the system prompt is assembled and the point where the turn
          is finished, and leave everything else alone.
        </p>
        <CodeTabs
          tabs={[
            {
              label: "Vercel AI SDK",
              node: (
                <CodeBlock language="ts">{`import { streamText } from "ai"
import { createClient } from "@astracollab/cogmem"

const memory = createClient({ apiKey: process.env.COGNITIVE_MEMORY_KEY! })

const result = streamText({
  model,
  system: [
    { role: "system", content: "You are a careful engineer." },
    // The memory block goes last so it sits closest to the user's message.
    { role: "system", content: context.text }
  ],
  messages
})

// After the stream finishes, learn from the exchange that actually happened.
result.onFinish(async ({ text }) => {
  await memory.turns
    .learn({ userMessage: last(messages), assistantResponse: text, sessionId })
    .catch((error) => log.warn("memory did not learn", { error }))
})`}</CodeBlock>
              )
            },
            {
              label: "Plain fetch",
              node: (
                <CodeBlock language="ts">{`// No dependency on the SDK at all. Same two calls.
const before = await fetch(\`\${baseUrl}/api/v1/context\`, {
  method: "POST",
  headers: {
    authorization: \`Bearer \${apiKey}\`,
    "content-type": "application/json"
  },
  body: JSON.stringify({ userMessage })
})
const { text } = await before.json()

const answer = await callYourModel({ system: text, userMessage })

await fetch(\`\${baseUrl}/api/v1/turns\`, {
  method: "POST",
  headers: {
    authorization: \`Bearer \${apiKey}\`,
    "content-type": "application/json"
  },
  body: JSON.stringify({ userMessage, assistantResponse: answer, sessionId })
})`}</CodeBlock>
              )
            }
          ]}
        />
        <p>
          Keep the memory block adjacent to the user message rather than at the top
          of the prompt. It is the part that is specific to this turn, and models
          weight the end of a long prompt more heavily than the beginning.
        </p>
      </>
    )
  },
  {
    id: "recall",
    title: "Ad-hoc recall",
    body: (
      <>
        <p>
          Sometimes the right move is to ask rather than to be handed everything.
          <code>recallOrExplain</code> exists for that: it returns a string ready
          to put in a prompt, and it handles the empty case by saying so out loud.
        </p>
        <CodeBlock language="ts">{`import { recallOrExplain } from "@astracollab/cogmem"

const brief = await recallOrExplain(memory, "where do we deploy", { limit: 5 })
const answer = await callYourModel({ system: brief, userMessage })`}</CodeBlock>
        <p>
          With nothing matching, it returns{" "}
          <code>Nothing in memory matches &ldquo;where do we deploy&rdquo;. If you
          were not told, say so rather than guessing.</code> That sentence is the
          point. A silent miss is how a model invents a fact it was never given, so
          the helper makes the miss visible and phrased as an instruction.
        </p>
        <p>
          Override it when your agent has a house style for that:
        </p>
        <CodeBlock language="ts">{`await recallOrExplain(memory, "where do we deploy", {
  limit: 5,
  emptyMessage: "Check src/infra, and say so if it is ambiguous."
})`}</CodeBlock>
      </>
    )
  },
  {
    id: "seeding",
    title: "Seeding what you already know",
    body: (
      <>
        <p>
          An agent that starts empty has to be taught before it is useful. If you
          already have the facts — a conventions file, a runbook, a table of hosts
          — load them once.
        </p>
        <CodeBlock language="ts">{`import { seedMemories } from "@astracollab/cogmem"

const { stored, merged, rejected } = await seedMemories(memory, {
  facts: [
    "Deploys go out on Tuesdays and Thursdays only",
    "The staging database is internal-hbr-2291.pineapple.example",
    "Never run migrations against production"
  ],
  sessionId: "onboarding"
})`}</CodeBlock>
        <p>
          Re-running it is safe. Restatements come back under <code>merged</code>{" "}
          rather than as errors, and anything{" "}
          <Link href="/docs/capture">refused</Link> comes back under{" "}
          <code>rejected</code> with a reason — so a seed that quietly stored
          nothing tells you why instead of looking like success.
        </p>
        <Callout>
          Seed through <code>memories.create</code>, not through turns. A seed
          string is a statement, not an exchange, and a message phrased as a
          question will be skipped as a lookup.
        </Callout>
      </>
    )
  },
  {
    id: "outcomes",
    title: "Feeding the self-model",
    body: (
      <>
        <p>
          The self-model is the one feature that has to be fed deliberately, and
          the rule that catches people is that <b className="text-zinc-200">success
          is false whenever a <code>failurePattern</code> is present</b>. There is
          no third state.
        </p>
        <CodeBlock language="ts" emphasise={[5, 12]}>{`// A turn that went badly: name the pattern, and it counts as a failure.
await memory.selfModel.record({
  domain: "database",
  success: false,
  failurePattern: "migrated the schema without a dry run"
})

// A turn that went well: record what worked, so it can be suggested again.
await memory.selfModel.record({
  domain: "database",
  success: true,
  strategy: "dry run against a restored snapshot first"
})`}</CodeBlock>
        <p>
          Patterns and strategies accumulate on the domain and are what gets
          injected as a{" "}
          <Link href="/docs/injection">guardrail</Link> once a domain drops below
          75%. The strings are deduplicated, so recording the same pattern on every
          failure does not pad the prompt.
        </p>
        <p>
          If you are using <code>runTurn</code>, pass{" "}
          <code>failurePattern</code> or <code>strategy</code> in the options and
          the outcome is recorded for you.
        </p>
      </>
    )
  },
  {
    id: "resilience",
    title: "When memory is down",
    body: (
      <>
        <p>
          Memory is an enhancement. A read failure should degrade to{" "}
          <em>no memory this turn</em>, and a write failure should never reach a
          model call that already succeeded.
        </p>
        <p>
          The client already retries transient failures and throws{" "}
          <code>CognitiveMemoryError</code> otherwise, with predicates so you branch
          on meaning rather than on status numbers:
        </p>
        <CodeBlock language="ts">{`import { CognitiveMemoryError } from "@astracollab/cogmem"

try {
  await memory.turns.learn({ userMessage, assistantResponse })
} catch (error) {
  if (!(error instanceof CognitiveMemoryError)) throw error
  if (error.isAuthError()) alert("the memory key stopped working")
  else if (error.isScopeError()) alert(\`widen the key: \${error.requiredScope}\`)
  else if (error.isServerError()) metric("memory.degraded")
  else throw error
}`}</CodeBlock>
        <Warning title="Do not retry a 400 or a 403">
          <code>isValidationError</code> and <code>isScopeError</code> are the
          caller&rsquo;s problem and will fail identically forever.{" "}
          <code>isServerError</code> and <code>isRateLimitError</code> are worth
          retrying, and the client already does. Wrapping those in your own retry
          loop is how a memory outage turns into a request flood.
        </Warning>
      </>
    )
  },
  {
    id: "testing",
    title: "Testing",
    body: (
      <>
        <p>
          Do not test an integration by pointing it at a running service. The
          package ships the deterministic layer — tiering, ranking, reconciliation,
          the fast gate — as pure functions, so the decisions can be asserted
          without a database, a network, or a model.
        </p>
        <CodeBlock language="ts">{`import { extractDeterministic, relevanceTokens, isLossyRewrite } from "@astracollab/cogmem"
import { describe, expect, it } from "vitest"

it("learns a stated requirement in the user's own words", () => {
  const found = extractDeterministic("Never force push to main")
  expect(found).toHaveLength(1)
  expect(found[0].content).toContain("force push")
})

it("refuses a merge that would drop a qualifier", () => {
  expect(
    isLossyRewrite(
      "Always run migrations against staging",
      "Always run migrations against staging, never production"
    )
  ).toBe(true)
})

it("ranks the memory that shares tokens with the query", () => {
  expect(relevanceTokens("where do we deploy")).toContain("deploy")
})`}</CodeBlock>
        <p>
          For the HTTP surface, construct the client with a stub{" "}
          <code>HttpClient</code> — it is exported for exactly this — and assert on
          the calls. The resources are thin, so a fake transport is a few lines.
        </p>
        <p>
          The behaviours worth pinning in your own tests are the three that fail
          quietly: that context is built before the model runs, that a turn with a
          question does not learn, and that a learning failure does not fail the
          turn.
        </p>
      </>
    )
  },
  {
    id: "checklist",
    title: "Before you ship it",
    body: (
      <>
        <ul className="ml-5 list-disc space-y-3">
          <li>
            <b className="text-zinc-200">The key is scoped to what the agent does.</b>{" "}
            A read-only agent should hold <code>memories:read</code> and nothing
            else. <Link href="/docs/auth">Credentials</Link>.
          </li>
          <li>
            <b className="text-zinc-200">You are logging{" "}
            <code>learningSkipped</code> and <code>truncated</code>.</b> Both are
            silent by default and both are the reason memory looks broken.
          </li>
          <li>
            <b className="text-zinc-200">You set a domain.</b> Without it the
            self-model stays at its priors forever.{" "}
            <Link href="/docs/self-model">The self-model</Link>.
          </li>
          <li>
            <b className="text-zinc-200">You seeded the obvious facts</b> so the
            agent is useful on turn one instead of turn fifty.
          </li>
          <li>
            <b className="text-zinc-200">You checked the context preview</b>{" "}
            against a real message from your logs —{" "}
            <Link href="/dashboard/context">the context preview</Link> is the
            fastest way to find out what the agent is actually being told.
          </li>
        </ul>
        <p>
          And the whole thing is two calls, so a full integration is a page of
          code — see <Link href="/docs/quickstart">the quickstart</Link> for the
          smallest version that works, and{" "}
          <Link href="/docs/api">the API reference</Link> for the exact contract.
        </p>
      </>
    )
  }
]

export default function IntegratingPage() {
  return (
    <DocPage
      href="/docs/integrating"
      title="Integrating with an agent"
      description="The whole loop as one working program: build context, run the model, learn from the finished turn, record how it went — plus what to do when the memory service is down and how to test it without one."
      lead={
        <div className="mt-6 flex flex-wrap gap-2">
          <Link
            href="/docs/api"
            className="rounded-lg border border-white/[0.1] px-2.5 py-1 text-[12px] text-zinc-300 transition hover:border-white/25"
          >
            API reference
          </Link>
          <Link
            href="/docs/sdk"
            className="rounded-lg border border-white/[0.1] px-2.5 py-1 text-[12px] text-zinc-300 transition hover:border-white/25"
          >
            SDK
          </Link>
        </div>
      }
      sections={SECTIONS}
    />
  )
}
