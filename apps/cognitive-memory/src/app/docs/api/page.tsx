import type { Metadata } from "next"
import Link from "next/link"

import { CodeBlock } from "@/components/docs/code-block"
import { Endpoint } from "@/components/docs/endpoint"
import { DocPage } from "@/components/docs/page"
import {
  Callout,
  DocTable,
  Warning,
  type DocColumn,
  type DocSectionSpec
} from "@/components/docs/primitives"

export const metadata: Metadata = {
  title: "API",
  description:
    "Every endpoint, the scope each one needs, and the tagged error shape — so a caller can tell a wrong key from a wrong scope without parsing prose."
}

/**
 * The HTTP surface.
 *
 * A dozen JSON endpoints over bearer auth. Every failure is a tagged error
 * mapped to a status in one place, so the shapes below are exhaustive rather
 * than typical — which is the property that makes them worth printing.
 */

const ENDPOINTS: readonly DocColumn[] = [
  { label: "Method", width: "4.5rem", mono: true },
  { label: "Path", width: "12.5rem", mono: true },
  { label: "Does" },
  { label: "Needs", width: "8.5rem", mono: true }
]

const SECTIONS: readonly DocSectionSpec[] = [
  {
    id: "shape",
    title: "The shape of a call",
    body: (
      <>
        <p>
          Every endpoint is JSON in and JSON out. Authenticate with{" "}
          <code>Authorization: Bearer &lt;key&gt;</code>. There is no versioning
          negotiation and no envelope — the response body is the resource.
        </p>
        <CodeBlock language="sh">{`curl -X POST localhost:3000/api/v1/context \\
  -H "Authorization: Bearer $COGNITIVE_MEMORY_KEY" \\
  -H "content-type: application/json" \\
  -d '{"userMessage":"deploy ZQ7X4M2K to staging"}'`}</CodeBlock>
        <p>
          Paths are mounted under <code>/api</code> on this deployment. A hosted
          deployment serving the SDK from the same origin may present them at the
          root, which is why the{" "}
          <Link href="/docs/sdk">client takes a base URL</Link> rather than
          hardcoding one.
        </p>
      </>
    )
  },
  {
    id: "endpoints",
    title: "Every endpoint",
    body: (
      <>
        <DocTable
          columns={ENDPOINTS}
          rows={[
            [
              "POST",
              "/v1/context",
              "Build the prompt block. Returns text, entries with reasons, and the token cost.",
              "memories:read"
            ],
            [
              "POST",
              "/v1/recall",
              "Deterministic ranked lookup. Returns empty:true when nothing matched.",
              "memories:read"
            ],
            ["POST", "/v1/turns", "Learn from a completed turn.", "memories:write"],
            [
              "POST",
              "/v1/memories",
              "Store facts outright. Restatements are folded in.",
              "memories:write"
            ],
            ["GET", "/v1/memories", "List what is held, with tier counts.", "memories:read"],
            ["GET", "/v1/memories/:id", "One memory in full.", "memories:read"],
            ["PATCH", "/v1/memories/:id", "Move between tiers.", "memories:write"],
            ["DELETE", "/v1/memories/:id", "Forget one memory.", "memories:write"],
            ["GET", "/v1/tensions", "Contradictions, filterable by status.", "memories:read"],
            ["POST", "/v1/tensions", "Record a contradiction.", "memories:write"],
            [
              "POST",
              "/v1/tensions/:id",
              "Resolve one, keeping the pattern.",
              "memories:write"
            ],
            ["GET", "/v1/self-model", "Reliability per domain.", "memories:read"],
            [
              "POST",
              "/v1/self-model/outcome",
              "Record how a domain went.",
              "memories:write"
            ],
            [
              "GET",
              "/v1/stats",
              "Counts, weak domains, active tensions.",
              "stats:read"
            ],
            [
              "GET",
              "/api/v1/health",
              "Liveness, limits, extractor mode, and unusable env values.",
              "—"
            ],
            ["GET", "/v1/keys", "List your keys by prefix.", "session"],
            ["POST", "/v1/keys", "Mint a key. The secret is returned once.", "session"],
            ["DELETE", "/v1/keys/:id", "Revoke a key.", "session"]
          ]}
        />
        <p>
          The last three are session-authenticated, not key-authenticated — minting
          a credential requires the human.{" "}
          <Link href="/docs/auth">Credentials</Link> explains why that is not an
          inconsistency.
        </p>
      </>
    )
  },
  {
    id: "worked",
    title: "The endpoints you will actually call",
    body: (
      <div className="space-y-4">
        <p>
          The table above is the whole surface, which is the right shape for
          &ldquo;does this exist&rdquo;. These four are what an integration is
          actually made of, and each is here with its real request and its real
          response — because the two things you need in order to call something
          are what to send and what comes back, and neither is guessable from a
          method and a path.
        </p>

        <Endpoint
          method="POST"
          path="/v1/context"
          scope="memories:read"
          does={
            <>
              Builds the block to prepend to a system prompt, and accounts for it.
              <code>userMessage</code> is what drives the triggers;{" "}
              <code>forceFull</code> pins specific memories into the block whatever
              their tier; <code>maxTokens</code> overrides the ceiling for this call.
            </>
          }
          ts={`const { text, entries, totalTokens, truncated } =
  await memory.context.build({ userMessage: "deploy ZQ7X4M2K to staging" })

// text goes in front of your system prompt.
// entries accounts for every line in it.`}
          curl={`curl -X POST localhost:3000/api/v1/context \\
  -H "Authorization: Bearer $COGNITIVE_MEMORY_KEY" \\
  -H "content-type: application/json" \\
  -d '{"userMessage":"deploy ZQ7X4M2K to staging"}'`}
          response={`{
  "text": "### Memory index — established earlier in this project\n- Deploy target is ZQ7X4M2K (infra)\n",
  "entries": [
    {
      "id": "mem_8fa21c",
      "tier": "L1",
      "reason": "index",
      "gist": "Deploy target is ZQ7X4M2K",
      "tokens": 9
    },
    {
      "id": "mem_1b40de",
      "tier": "L1",
      "reason": "trigger",
      "gist": "Staging host is internal-hbr-2291.pineapple.example",
      "body": "The staging host for the billing service is internal-hbr-2291.pineapple.example, owned by platform.",
      "tokens": 31
    }
  ],
  "totalTokens": 40,
  "truncated": false
}`}
          note={
            <>
              A memory body is included only when the message named something
              concrete and absent from the transcript — here, <code>ZQ7X4M2K</code>.
              The full rules are on{" "}
              <Link href="/docs/injection">what goes into the prompt</Link>.
            </>
          }
        />

        <Endpoint
          method="POST"
          path="/v1/turns"
          scope="memories:write"
          does={
            <>
              Learns from a finished turn: extracts candidates, reconciles them
              against what is held, files the survivors, and reports what it did
              with each one.
            </>
          }
          ts={`const result = await memory.turns.learn({
  userMessage,
  assistantResponse,
  sessionId
})

result.counts    // { stored, merged, rejected, tensions, promoted }
result.rejected  // [{ content, reason }] — never silent`}
          curl={`curl -X POST localhost:3000/api/v1/turns \\
  -H "Authorization: Bearer $COGNITIVE_MEMORY_KEY" \\
  -H "content-type: application/json" \\
  -d '{"userMessage":"we deploy on Fridays","assistantResponse":"Noted."}'`}
          response={`{
  "stored": [
    {
      "id": "mem_9c31af",
      "content": "we deploy on Fridays",
      "gist": "Deploys happen on Fridays",
      "tier": "L1",
      "domains": [],
      "accessCount": 0,
      "source": "rules",
      "createdAt": 1767225600000,
      "lastAccessedAt": 1767225600000
    }
  ],
  "mergedInto": [],
  "counts": { "stored": 1, "merged": 0, "rejected": 0, "tensions": 0, "promoted": 0 },
  "rejected": []
}`}
          note={
            <>
              A turn whose user message contains a question is a lookup, not a
              lesson, and returns everything empty with the candidates under{" "}
              <code>rejected</code>. <Link href="/docs/capture">Why</Link>.
            </>
          }
        />

        <Endpoint
          method="POST"
          path="/v1/recall"
          scope="memories:read"
          does={
            <>
              Deterministic ranked lookup. Use it when you want to ask rather than
              be handed the index — a targeted question, a support agent, a review
              tool. <code>recallOrExplain</code> wraps this and phrases the result
              for a prompt.
            </>
          }
          ts={`const { results, empty } = await memory.recall.search({
  query: "where do we deploy",
  limit: 8
})

if (empty) return "If you were not told, say so rather than guessing."`}
          curl={`curl -X POST localhost:3000/api/v1/recall \\
  -H "Authorization: Bearer $COGNITIVE_MEMORY_KEY" \\
  -H "content-type: application/json" \\
  -d '{"query":"where do we deploy","limit":8}'`}
          response={`{
  "results": [
    {
      "memory": {
        "id": "mem_8fa21c",
        "content": "Deploy target is ZQ7X4M2K",
        "tier": "L1",
        "domains": ["infra"],
        "accessCount": 4,
        "createdAt": 1767225600000,
        "lastAccessedAt": 1767312000000
      },
      "score": 0.62
    }
  ],
  "empty": false
}`}
          note={
            <>
              <code>empty: true</code> is not an empty array — it means the search
              ran and found nothing, which is a fact about your store and not the
              same as a failure. <Link href="/docs/recall">Recall</Link>.
            </>
          }
        />

        <Endpoint
          method="POST"
          path="/v1/self-model/outcome"
          scope="memories:write"
          does={
            <>
              Records how a domain went. <code>success</code> is{" "}
              <code>false</code> whenever a <code>failurePattern</code> is present;
              there is no third state. Patterns and strategies accumulate on the
              domain and become the guardrail injected into later prompts.
            </>
          }
          ts={`await memory.selfModel.record({
  domain: "database",
  success: false,
  failurePattern: "migrated the schema without a dry run"
})`}
          curl={`curl -X POST localhost:3000/api/v1/self-model/outcome \\
  -H "Authorization: Bearer $COGNITIVE_MEMORY_KEY" \\
  -H "content-type: application/json" \\
  -d '{"domain":"database","success":false,"failurePattern":"migrated without a dry run"}'`}
          response={`{
  "calibrationFactor": 1,
  "activeDomains": ["database"],
  "domains": {
    "database": {
      "reliabilityScore": 0.533,
      "sampleCount": 1,
      "knownFailurePatterns": ["migrated the schema without a dry run"],
      "recommendedStrategies": []
    }
  },
  "weakDomains": []
}`}
          note={
            <>
              <code>reliabilityScore: 0.533</code> after one failure, not{" "}
              <code>0</code> — the moving average carries a prior of two samples, so
              one bad turn cannot pin a warning into every prompt for ever.{" "}
              <Link href="/docs/self-model">The self-model</Link>.
            </>
          }
        />
      </div>
    )
  },
  {
    id: "scopes",
    title: "Scopes",
    body: (
      <>
        <p>
          Four, and a key must hold the one an endpoint needs. A 403 names the
          missing scope, so a caller can widen a key without guessing.
        </p>
        <DocTable
          columns={[
            { label: "Scope", width: "11rem", mono: true },
            { label: "Grants" }
          ]}
          rows={[
            [<code key="r">memories:read</code>, "Context builds, recall, reads, and the self-model."],
            [<code key="w">memories:write</code>, "Learning, storing, promoting, forgetting, resolving."],
            [<code key="s">stats:read</code>, "GET /v1/stats."],
            [
              <code key="k">keys:manage</code>,
              "Rotate sibling keys for the same organisation. Cannot create an organisation or widen its own scopes."
            ]
          ]}
        />
        <p>
          A newly minted key gets <code>memories:read</code>,{" "}
          <code>memories:write</code> and <code>stats:read</code> by default. An
          agent that only reads should be issued only the read scope.
        </p>
      </>
    )
  },
  {
    id: "errors",
    title: "Errors",
    body: (
      <>
        <p>
          A failure carries a tag, a message, and whatever is actionable. A caller
          can therefore tell a wrong key from a wrong scope, and a malformed body
          from an outage, without parsing prose.
        </p>
        <CodeBlock language="json">{`{
  "error": "Forbidden",
  "message": "This key lacks the memories:write scope.",
  "requiredScope": "memories:write"
}`}</CodeBlock>
        <DocTable
          columns={[
            { label: "Status", width: "6rem", mono: true },
            { label: "error", width: "13rem", mono: true },
            { label: "Means" }
          ]}
          rows={[
            ["400", "InvalidRequest", "The body or a parameter was wrong. issues carries field paths."],
            ["401", "Unauthorized", "No key, or a key that is revoked, expired or unknown."],
            ["403", "Forbidden", "Valid key, wrong scope. requiredScope says which."],
            ["404", "NotFound", "No such memory or tension. resource and id say which."],
            [
              "500",
              "StorageFailure",
              "The database failed. Retry, and do not treat the body as actionable."
            ],
            [
              "502",
              "ModelFailure",
              "A configured model provider failed. The deterministic path is unaffected."
            ],
            [
              "503",
              "BootstrapDisabled",
              "The service is up but has been configured not to serve this."
            ]
          ]}
        />
        <Callout>
          Anything not in this table is a bug or an outage, and surfaces as a 500
          with the cause logged server-side and nothing about internals in the
          body. A tidy 400 for a driver crash would hide it.
        </Callout>
      </>
    )
  },
  {
    id: "two-calls",
    title: "The two calls that matter",
    body: (
      <>
        <p>
          If you are integrating rather than reading, this is the whole API. Build
          context before the model runs; record the turn after it finishes.
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
          stored, merged and rejected, with reasons.
        </p>
        <Warning title="A turn whose message is a question is skipped">
          Learning from recall turns stored the assistant&rsquo;s own answers back
          as memories, which duplicated facts and evicted real ones. So a turn
          with a question in the user message returns{" "}
          <code>learningSkipped</code> rather than storing anything — check it, or
          a working system and a broken one look identical.{" "}
          <Link href="/docs/capture">What gets learned</Link> has the reasoning.
        </Warning>
      </>
    )
  },
  {
    id: "health",
    title: "Health",
    body: (
      <>
        <p>
          Unauthenticated on purpose: an orchestrator has to reach it without
          holding a key, and nothing in it is tenant data.
        </p>
        <CodeBlock language="json">{`{
  "ok": true,
  "service": "cognitive-memory",
  "extractor": "rules-only",
  "limits": {
    "maxTotalTokens": 2000,
    "maxIndexItems": 60,
    "defaultRecallLimit": 8
  },
  "problems": []
}`}</CodeBlock>
        <p>
          <code>extractor</code> is <code>rules-only</code> or{" "}
          <code>rules+model</code>, and it is the first field to check when memory
          is not learning. <code>problems</code> is empty in the healthy case, so an
          operator can alert on it without a special case — it names environment
          values that were present but unusable, and a missing{" "}
          <code>BETTER_AUTH_SECRET</code> in production.
        </p>
      </>
    )
  }
]

export default function ApiPage() {
  return (
    <DocPage
      href="/docs/api"
      title="API"
      description="A dozen JSON endpoints over bearer auth, four scopes, and one table from domain error to HTTP status — so the shapes here are exhaustive rather than typical."
      sections={SECTIONS}
    />
  )
}
