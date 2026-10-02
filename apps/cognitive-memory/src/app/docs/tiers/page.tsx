import type { Metadata } from "next"
import Link from "next/link"

import { DocPage } from "@/components/docs/page"
import { Callout, DocTable, type DocSectionSpec } from "@/components/docs/primitives"

export const metadata: Metadata = {
  title: "Four tiers",
  description:
    "L0 through L3: what each tier holds, what it costs per turn, and why a new fact lands hot rather than waiting for a promotion pass."
}

/**
 * The four tiers.
 *
 * The central mechanism. A tier is a cost decision, and once that framing is
 * accepted the rest follows: which facts are worth a full body every turn, which
 * are worth an index line, and which are worth nothing until something asks.
 */

const SECTIONS: readonly DocSectionSpec[] = [
  {
    id: "cost",
    title: "A tier is a cost decision",
    body: (
      <>
        <p>
          L0 and L1 are written into the prompt every turn. L2 and L3 cost nothing
          until something promotes or recalls them. That is the whole idea: the
          per-turn budget is a decision you make about a fact, rather than an
          accident of how many facts you happen to have.
        </p>
        <DocTable
          columns={[
            { label: "Tier", width: "3.5rem", mono: true },
            { label: "Name", width: "8rem" },
            { label: "Holds" },
            { label: "Cost", width: "12rem" }
          ]}
          rows={[
            [
              "L0",
              "Pinned",
              "Unresolved contradictions, weak domains, correction notices",
              "Full body, always"
            ],
            ["L1", "Hot cache", "Newly learned and pre-staged facts", "Index line, body on trigger"],
            ["L2", "Warm store", "Candidates scored against each turn", "Nothing until promoted"],
            ["L3", "Cold archive", "Everything else, still recallable", "Nothing until recalled"]
          ]}
        />
        <p>
          The register an agent actually stores is URLs, build ids, ports, paths
          and conventions — short, identifier-shaped, and each one worth a great
          deal if it is the right one. A tier that puts a full body on all of them
          would spend the entire budget being right about the least interesting
          facts held.
        </p>
      </>
    )
  },
  {
    id: "landing",
    title: "New statements land in L1",
    body: (
      <>
        <p>
          Immediately, not after a promotion pass. Waiting for a pass added a turn
          of latency, which meant a fact you taught on one turn was still missing
          from the very next prompt — the most visible possible way for memory to
          look broken.
        </p>
        <p>
          A fact is demoted when it stops earning its place, not on a schedule.
          Promotion and demotion are both explicit, from the{" "}
          <Link href="/docs/api">API</Link> or the{" "}
          <Link href="/dashboard/memory">library</Link>, and the tier is visible
          wherever a memory is listed.
        </p>
        <Callout>
          Promotion is a decision with a cost attached, which is why it is a
          decision. <code>PATCH /v1/memories/:id</code> is not something the
          service does for you on a timer.
        </Callout>
      </>
    )
  },
  {
    id: "cap",
    title: "What happens when L1 fills up",
    body: (
      <>
        <p>
          L1 is capped by the token budget. When the cap bites, the response says{" "}
          <code>truncated: true</code> rather than dropping the tail in silence,
          and the least recently accessed entries are the ones that lose their
          place.
        </p>
        <p>
          A store that is permanently over budget therefore converges on a small
          hot set of frequently-touched facts. That is a legitimate outcome — and
          the one thing to check before treating it as a bug is whether the budget
          is set for the store you have, or the store you had.{" "}
          <Link href="/dashboard/analytics">Analytics</Link> separates index spend
          from body spend, which distinguishes &ldquo;raise the ceiling&rdquo; from
          &ldquo;promote more&rdquo;.
        </p>
        <p>
          The ceiling itself is{" "}
          <code>COGNITIVE_MEMORY_MAX_TOTAL_TOKENS</code>, overridable per
          organisation; see <Link href="/docs/self-hosting">self-hosting</Link>.
        </p>
      </>
    )
  },
  {
    id: "l0",
    title: "What is pinned at L0",
    body: (
      <>
        <p>
          L0 is the only tier whose cost does not depend on the budget. Three
          things land there, and they share a property: the agent is worse off
          without them, in a way that is not proportional to how interesting they
          are.
        </p>
        <ul className="ml-5 list-disc space-y-3">
          <li>
            <b className="text-zinc-200">Unresolved contradictions.</b> The whole
            point is that the agent sees both sides rather than picking one. See{" "}
            <Link href="/docs/tensions">contradictions</Link>.
          </li>
          <li>
            <b className="text-zinc-200">Weak domains.</b> A domain this agent has
            been unreliable in, with its known failure patterns. See{" "}
            <Link href="/docs/self-model">the self-model</Link>.
          </li>
          <li>
            <b className="text-zinc-200">Correction notices.</b> When the incoming
            message pattern-matches an explicit correction, the user is visibly
            changing their mind, which is the single most reliable signal that an
            assumption is stale. See{" "}
            <Link href="/docs/injection">what goes into the prompt</Link>.
          </li>
        </ul>
        <Callout>
          L0 is injected in full regardless of budget, by design. A budget that
          can silently drop a contradiction is a budget that can resolve one
          without anyone deciding to.
        </Callout>
      </>
    )
  }
]

export default function TiersPage() {
  return (
    <DocPage
      href="/docs/tiers"
      title="Four tiers"
      description="A tier is a cost decision. L0 and L1 are written into the prompt every turn; L2 and L3 cost nothing until something promotes or recalls them."
      sections={SECTIONS}
    />
  )
}
