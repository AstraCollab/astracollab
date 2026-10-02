import type { Metadata } from "next"
import Link from "next/link"

import { DocPage } from "@/components/docs/page"
import { Callout, DocTable, type DocSectionSpec } from "@/components/docs/primitives"

export const metadata: Metadata = {
  title: "Dashboard",
  description:
    "Ten pages, authenticated by session rather than by API key — and the two of them that turn a vague feeling into a specific fix."
}

/**
 * The dashboard.
 *
 * Ordered by the order the questions get asked: what is my agent being told,
 * what has it learned, what does it contradict, what is it bad at, what is that
 * costing, and only then the credentials.
 */

const SECTIONS: readonly DocSectionSpec[] = [
  {
    id: "auth",
    title: "How it is authenticated",
    body: (
      <>
        <p>
          By session cookie, not by API key. Looking at your own memory should not
          cost you a credential, and handing out keys to open a page would train
          exactly the habit this service discourages.
        </p>
        <p>
          So <code>/api/dashboard/*</code> never accepts an API key, and the
          agent-facing <code>/v1/*</code> never accepts a session. Two entry
          points, two authenticators, each with the authority it actually needs.{" "}
          <Link href="/docs/auth">Credentials</Link> is the full argument.
        </p>
      </>
    )
  },
  {
    id: "pages",
    title: "The pages",
    body: (
      <>
        <DocTable
          columns={[
            { label: "Route", width: "15rem", mono: true },
            { label: "Answers" }
          ]}
          hrefs={[
            "/dashboard",
            "/dashboard/context",
            "/dashboard/activity",
            "/dashboard/memory",
            "/dashboard/tensions",
            "/dashboard/self-model",
            "/dashboard/analytics",
            "/dashboard/start",
            "/dashboard/keys",
            "/dashboard/settings"
          ]}
          rows={[
            [
              "/dashboard",
              "What needs a human: unresolved contradictions, weak domains, whether the budget is truncating."
            ],
            [
              "/dashboard/context",
              "The exact block your agent would be given for any message, with the reason and cost of every line."
            ],
            [
              "/dashboard/activity",
              "Every context build, with the block that was sent and the reason each line was included."
            ],
            [
              "/dashboard/memory",
              "Search, filter, edit, retier and bulk-forget. Plus a recall inspector that names the terms that matched."
            ],
            [
              "/dashboard/tensions",
              "Contradictions by status, with resolve, reopen, and the reusable pattern a resolution revealed."
            ],
            [
              "/dashboard/self-model",
              "Reliability per domain with every sample behind the score, and a form to record an outcome."
            ],
            [
              "/dashboard/analytics",
              "Tokens per turn over time, the reason mix, per-endpoint and per-key spend, tier distribution."
            ],
            [
              "/dashboard/start",
              "SDK and curl snippets, and a live tester that sends real requests with a key you paste."
            ],
            ["/dashboard/keys", "Issue, scope, expire and revoke agent credentials."],
            [
              "/dashboard/settings",
              "Budgets, extraction, retention, the organisation, and a danger zone."
            ]
          ]}
        />
      </>
    )
  },
  {
    id: "analytics",
    title: "Analytics: which rule spent the tokens",
    body: (
      <>
        <p>
          Splits the token spend by the rule that caused each line: index, trigger,
          tension, guardrail. That is the whole reason{" "}
          <Link href="/docs/injection">injection reasons</Link> are recorded rather
          than inferred.
        </p>
        <p>
          A build that spends its whole budget on index lines and no bodies is not
          a memory that needs a bigger budget, it is a store with nothing worth
          promoting, and the two problems have opposite fixes. 118k tokens is a
          number with no action attached; &ldquo;104k of it was index lines and 2k
          was full bodies&rdquo; is a diagnosis.
        </p>
        <Callout>
          This is the page to read when a deployment feels expensive. Not the
          context page, which tells you what went wrong on one turn — analytics
          tells you whether the fix is a budget or the store.
        </Callout>
      </>
    )
  },
  {
    id: "activity",
    title: "Activity: what was actually sent",
    body: (
      <>
        <p>
          Replays the block that was actually sent, not the one the planner would
          produce today. Re-running the planner against current memory answers{" "}
          &ldquo;what would the agent get now&rdquo;, which is a much better-looking
          answer than the one that caused whatever you are trying to understand.
        </p>
        <p>
          The triggering message is not stored with it — that is the conversation,
          not the memory — but the identifiers inside it are, because those are
          what explain why a full body was spent.
        </p>
        <p>
          So when a turn looks wrong, this is where you find out whether the
          mistake was in what was held, in what was selected, or in what the model
          did with it. Those are three different bugs and they are not
          distinguishable from the prompt alone.
        </p>
      </>
    )
  },
  {
    id: "settings",
    title: "Settings: overrides that are visible",
    body: (
      <>
        <p>
          Per-organisation overrides of the token ceiling, the index limit and the
          recall default, plus whether model extraction runs at all and how long the
          logs are kept.
        </p>
        <p>
          Each override is nullable, and null means &ldquo;inherit the deployment
          default&rdquo;: a setting that silently reverts is worse than no setting
          at all, so the page shows both numbers and clearing the override is one
          click rather than a guess at what the deployment default was last week.
        </p>
        <p>
          The same three values are{" "}
          <Link href="/docs/self-hosting">deployment-level environment variables</Link>.
          The dashboard is the per-organisation layer above them, not a replacement.
        </p>
      </>
    )
  },
  {
    id: "start",
    title: "Getting started from here",
    body: (
      <>
        <p>
          <Link href="/dashboard/start">Get started</Link> holds SDK and curl
          snippets generated for the deployment you are actually signed in to, plus
          a live tester that sends real requests with a key you paste. It is the
          fastest way to confirm a key works before wiring it into an agent.
        </p>
        <p>
          If you would rather read first:{" "}
          <Link href="/docs/quickstart">the quickstart</Link> is two calls,{" "}
          <Link href="/docs/injection">what goes into the prompt</Link> is where the
          design bets are, and <Link href="/docs/api">the API reference</Link> is
          exhaustive.
        </p>
      </>
    )
  }
]

export default function DashboardPage() {
  return (
    <DocPage
      href="/docs/dashboard"
      title="Dashboard"
      description="Ten pages, all authenticated by session cookie rather than by API key. Two of them are worth calling out, because they turn a vague feeling into a specific fix."
      sections={SECTIONS}
    />
  )
}
