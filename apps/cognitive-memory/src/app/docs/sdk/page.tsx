import type { Metadata } from "next"
import Link from "next/link"

import { CodeBlock } from "@/components/docs/code-block"
import { DocPage } from "@/components/docs/page"
import {
  Callout,
  DocTable,
  Warning,
  type DocColumn,
  type DocSectionSpec
} from "@/components/docs/primitives"

export const metadata: Metadata = {
  title: "SDK",
  description:
    "The typed client, the runTurn helper, and the deterministic layer that runs in-process with no database, no network and no model."
}

/**
 * The SDK.
 *
 * Two things in one package, on purpose: an HTTP client, and the deterministic
 * cognitive layer that also runs in-process. Shipping both is what makes it
 * possible to start against the service and later run the same logic locally
 * without the behaviour changing underneath you.
 */

const METHODS: readonly DocColumn[] = [
  { label: "Method", width: "13.5rem", mono: true },
  { label: "Endpoint", width: "12rem", mono: true },
  { label: "Does" }
]

const SECTIONS: readonly DocSectionSpec[] = [
  {
    id: "install",
    title: "Install",
    body: (
      <>
        <CodeBlock language="sh">{"pnpm add @astracollab/cogmem"}</CodeBlock>
        <p>
          ~3kB gzipped, ESM-first, and its only hard dependency is{" "}
          <code>ofetch</code>. <code>ai</code> and <code>zod</code> are optional
          peers, needed solely for the model-backed arbiter on the{" "}
          <code>@astracollab/cogmem/arbiter</code> entry point — so a consumer with
          no model provider installs neither.
        </p>
        <p>
          Imports are arranged for tree-shaking: <code>createClient</code> alone
          does not pull the in-process engine in, and the package declares no side
          effects.
        </p>
      </>
    )
  },
  {
    id: "client",
    title: "The client",
    body: (
      <>
        <CodeBlock language="ts">{`import { createClient } from "@astracollab/cogmem"

const memory = createClient({
  apiKey: process.env.COGNITIVE_MEMORY_KEY!,
  baseUrl: "http://localhost:3000"
})`}</CodeBlock>
        <p>
          <code>apiKey</code> is the only required field. <code>baseUrl</code>{" "}
          defaults to the current origin in a browser and localhost otherwise;{" "}
          <code>timeout</code>, <code>retry</code>, <code>headers</code> and{" "}
          <code>debug</code> are optional.
        </p>
        <Callout>
          Debug logging is on by default, which is a deliberate choice for anyone
          who has been burned by a wrong base URL — which is everyone, exactly
          once. Turn it off when you have stopped being that person.
        </Callout>
        <p>
          Two construction styles ship on purpose — <code>new Cogmem(…)</code> and{" "}
          <code>createClient(…)</code> — because there is no reason to make anyone
          rename, and the factory is the one that is easy to mock in a test.
        </p>
      </>
    )
  },
  {
    id: "turn",
    title: "The turn helper",
    body: (
      <>
        <p>
          <code>runTurn</code> is the recommended entry point, because the order is
          the part that is easy to get wrong: build context keyed on the message
          being answered, run the model, learn from the finished exchange, then
          record how the domain went.
        </p>
        <CodeBlock language="ts">{`import { createClient, runTurn } from "@astracollab/cogmem"

const memory = createClient({
  apiKey: process.env.COGNITIVE_MEMORY_KEY!,
  baseUrl: "http://localhost:3000"
})

const { context, learning, learningSkipped } = await runTurn(
  memory,
  { userMessage, run: (block) => callYourModel(block, userMessage) },
  { domain: "database", sessionId }
)`}</CodeBlock>
        <p>
          The last two steps never fail the turn. A memory outage cannot take down a
          model call that already succeeded, so the helper catches and reports
          instead of rethrowing.
        </p>
        <p>
          <code>learningSkipped</code> is returned rather than left null, because a
          silent skip looks identical to a working one until the thing you taught
          it never comes back. Log it.
        </p>
        <Warning title="domain is not optional in practice">
          It is the input that makes the{" "}
          <Link href="/docs/self-model">self-model</Link> mean anything. Without it
          the reliability scores stay at their priors and no weak-domain warning
          ever fires, which is the most common reason this looks like it is not
          working.
        </Warning>
      </>
    )
  },
  {
    id: "helpers",
    title: "The helpers",
    body: (
      <>
        <p>
          Three functions that compose the resource calls into the sequences people
          get wrong when they write the loop themselves. Each takes the client
          explicitly rather than closing over one, so a second client — a test
          double, a second organisation — needs no module-level singleton.
        </p>
        <DocTable
          columns={[
            { label: "Helper", width: "10rem", mono: true },
            { label: "Does", width: "12rem" }
          ]}
          rows={[
            [
              <code key="r">runTurn</code>,
              "The whole turn: build, run, learn, record."
            ],
            [
              <code key="e">recallOrExplain</code>,
              "Recall, phrased for a prompt."
            ],
            [
              <code key="s">seedMemories</code>,
              "Store a list of facts once."
            ]
          ]}
        />

        <CodeBlock language="ts">{`import { recallOrExplain, seedMemories } from "@astracollab/cogmem"

// Recall, already formatted to paste into a prompt.
const brief = await recallOrExplain(memory, "where do we deploy", { limit: 5 })

// Load what you already know. Safe to re-run: restatements come back merged.
const { stored, merged, rejected } = await seedMemories(memory, {
  facts: ["Deploys go out on Tuesdays and Thursdays only"]
})`}</CodeBlock>

        <p>
          <code>recallOrExplain</code> returns a string rather than results
          because the caller&rsquo;s next step is almost always &ldquo;put this in
          the prompt&rdquo;. Doing the formatting here is what makes every
          integration handle the empty case the same way — by saying so, rather
          than letting a model fill the gap with a guess. Override the wording
          with <code>emptyMessage</code>.
        </p>
        <p>
          <code>seedMemories</code> exists because a migration should not have to
          know what the service already holds. Anything refused comes back under{" "}
          <code>rejected</code> with a reason, so a seed that stored nothing tells
          you why instead of looking like success.
        </p>
      </>
    )
  },
  {
    id: "resources",
    title: "Resources",
    body: (
      <>
        <p>
          Method names map one-to-one onto endpoints, so the client is never a
          second, divergent copy of the service. Resources are{" "}
          <code>readonly</code>, which stops a caller reassigning one half of the
          client and wondering why the other half stopped seeing the change.
        </p>
        <DocTable
          columns={METHODS}
          rows={[
            [
              "memory.context.build()",
              "POST /v1/context",
              "The prompt block, its entries, total tokens, truncation."
            ],
            [
              "memory.recall.search()",
              "POST /v1/recall",
              "Ranked results. empty: true when nothing matched."
            ],
            ["memory.turns.learn()", "POST /v1/turns", "Learn a completed turn."],
            ["memory.memories.list()", "GET /v1/memories", "What is held, with tier counts."],
            ["memory.memories.get(id)", "GET /v1/memories/:id", "One memory in full."],
            [
              "memory.memories.create()",
              "POST /v1/memories",
              "Store facts outright. Restatements fold in."
            ],
            [
              "memory.memories.promote()",
              "PATCH /v1/memories/:id",
              "Move between tiers."
            ],
            ["memory.memories.remove()", "DELETE /v1/memories/:id", "Forget one memory."],
            [
              "memory.tensions.list()",
              "GET /v1/tensions",
              "Contradictions, filterable by status."
            ],
            ["memory.tensions.create()", "POST /v1/tensions", "Record a contradiction."],
            [
              "memory.tensions.resolve()",
              "POST /v1/tensions/:id",
              "Resolve one, keeping the pattern."
            ],
            ["memory.selfModel.get()", "GET /v1/self-model", "Reliability per domain."],
            [
              "memory.selfModel.record()",
              "POST /v1/self-model/outcome",
              "Record how a domain went."
            ],
            [
              "memory.stats.get()",
              "GET /v1/stats",
              "Counts, weak domains, open contradictions."
            ],
            [
              "memory.health()",
              "GET /api/v1/health",
              "Liveness, limits, extractor mode. No key spent."
            ]
          ]}
        />
      </>
    )
  },
  {
    id: "errors",
    title: "Config and errors",
    body: (
      <>
        <p>
          Every non-2xx response throws <code>CognitiveMemoryError</code> carrying
          the tag, the message, and <code>requiredScope</code> or{" "}
          <code>issues</code> where they apply. A wrong key and a wrong scope are
          therefore distinguishable in a catch block, without matching on message
          text.
        </p>
        <CodeBlock language="ts">{`import { CognitiveMemoryError } from "@astracollab/cogmem"

try {
  await memory.turns.learn({ userMessage, assistantResponse })
} catch (error) {
  if (!(error instanceof CognitiveMemoryError)) throw error
  if (error.isScopeError()) console.error("widen the key:", error.requiredScope)
  else if (error.isValidationError()) console.error("bad body:", error.issues)
  else throw error
}`}</CodeBlock>
        <p>
          Ask the question semantically rather than matching on a status number.
          <code>status === 403</code> scatters a magic number through every
          integration and means something slightly different at each one;
          <code>isScopeError()</code> means the same thing everywhere.
        </p>
        <DocTable
          columns={[
            { label: "Predicate", width: "12rem", mono: true },
            { label: "True when", width: "5rem", mono: true },
            { label: "Retry" }
          ]}
          rows={[
            ["isAuthError()", "401", "No — rotate the key"],
            ["isScopeError()", "403", "No — widen the key"],
            ["isValidationError()", "400", "No — fix the body"],
            ["isNotFoundError()", "404", "No"],
            ["isRateLimitError()", "429", "Yes"],
            ["isServerError()", "≥ 500", "Yes — the client already does"]
          ]}
        />
        <p>
          The client retries 429 and 5xx for you. Wrapping those in your own retry
          loop is how a memory outage turns into a request flood. The tags behind
          each status are in <Link href="/docs/api#errors">the API reference</Link>.
        </p>
      </>
    )
  },
  {
    id: "in-process",
    title: "The in-process layer",
    body: (
      <>
        <p>
          The second thing in the package is the deterministic layer — tiering,
          ranking, reconciliation, the fast gate — and it runs with no database, no
          network, and no model in the retrieval path.
        </p>
        <p>
          That is what makes the shared primitives matter: the same code decides
          what a memory is worth on the server and in your test, so the two cannot
          drift. A test can assert on a ranking without a fixture database, and a
          local tool can classify text without asking a provider.
        </p>
        <Callout>
          The model-backed arbiter is a separate entry point —{" "}
          <code>@astracollab/cogmem/arbiter</code> — precisely so that{" "}
          <code>ai</code> and <code>zod</code> stay optional. Importing the
          deterministic layer never pulls in a model dependency.
        </Callout>
      </>
    )
  },
  {
    id: "other-languages",
    title: "Other languages",
    body: (
      <>
        <p>
          There is no Python, Go, or Rust client, and that is a deliberate position
          rather than a gap in the roadmap: the API is a dozen JSON endpoints over
          bearer auth, so a generated client in each language would be a second
          surface to keep in step with the service for no gain.
        </p>
        <p>
          The integration is two calls, and any HTTP client does it — see{" "}
          <Link href="/docs/api#two-calls">the API reference</Link> for both with
          curl.
        </p>
      </>
    )
  }
]

export default function SdkPage() {
  return (
    <DocPage
      href="/docs/sdk"
      title="SDK"
      description="One package with two halves: a typed client for the service, and the deterministic cognitive layer to run in-process. The shared primitives are why they cannot drift."
      sections={SECTIONS}
    />
  )
}
