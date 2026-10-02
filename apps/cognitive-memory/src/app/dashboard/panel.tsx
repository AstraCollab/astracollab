"use client"

import Link from "next/link"

import { AreaChart } from "./charts"
import { useResource, type Overview } from "./data"
import {
  Badge,
  Button,
  Empty,
  Failure,
  Grid,
  Loading,
  Metric,
  PageHeader,
  Panel,
  TierBadge
} from "./ui"

/**
 * The landing screen.
 *
 * Leads with what needs a human rather than with what exists. A dashboard whose
 * first tile is a memory count is reporting on itself; the useful first question
 * is "is anything wrong" — a contradiction nobody has resolved, a domain the
 * agent keeps failing in, a budget that is already truncating. When there is
 * nothing wrong it says so, in as many words, because "0 critical, 0 weak" is a
 * result and not a failure to load.
 */
export function OverviewPanel() {
  const { data, error, loading, reload } = useResource<Overview>("/api/dashboard/overview")

  if (loading && data === null) return <Loading label="Reading your memory…" />
  if (error !== null) return <Failure message={error} onRetry={reload} />
  if (data === null) return <Loading />

  const { stats, selfModel, tensions, spend, budget, problems, usedMost, recent } = data
  const critical = tensions.filter((tension) => tension.impact === "critical")
  const needsYou = [...critical, ...selfModel.weakDomains.slice(0, 3)]
  const fresh = stats.total === 0

  return (
    <div className="space-y-6">
      <PageHeader
        title="Overview"
        description={
          <>
            {needsYou.length === 0 && !fresh ? (
              <>
                Nothing needs you. No unresolved contradictions, no domain the agent
                has been unreliable in, and the injection budget is not truncating.
              </>
            ) : (
              <>
                What your agent is being told, what it has learned, and what that is
                costing. The items below are the ones a human has to resolve.
              </>
            )}
          </>
        }
        actions={
          <>
            <Link href="/dashboard/context">
              <Button>Preview context</Button>
            </Link>
            <Link href="/dashboard/analytics">
              <Button variant="primary">Analytics</Button>
            </Link>
          </>
        }
      />

      {problems.length > 0 && (
        <div className="space-y-1.5 rounded-xl border border-amber-300/20 bg-amber-300/[0.05] px-4 py-3">
          <p className="text-[13px] text-amber-100/90">This deployment is misconfigured</p>
          <ul className="space-y-1">
            {problems.map((problem) => (
              <li key={problem} className="font-mono text-[11px] leading-4 text-amber-200/70">
                {problem}
              </li>
            ))}
          </ul>
          <Link
            href="/dashboard/settings"
            className="inline-block pt-1 text-[11px] text-amber-200/70 underline decoration-amber-200/30 underline-offset-2"
          >
            Fix in settings
          </Link>
        </div>
      )}

      <Grid cols={5}>
        <Metric
          label="memories"
          value={stats.total.toLocaleString()}
          hint={`${stats.sessions} sessions`}
        />
        <Metric
          label="tokens / turn"
          value={spend.totals.builds === 0 ? "—" : spend.totals.medianTokens.toLocaleString()}
          hint={
            spend.totals.builds === 0
              ? "no builds yet"
              : `${Math.round(spend.totals.utilisation * 100)}% of the ${budget.effective.maxTotalTokens} budget`
          }
          tone={spend.totals.utilisation > 0.85 ? "warn" : "plain"}
        />
        <Metric
          label="builds"
          value={spend.totals.builds.toLocaleString()}
          hint="last 14 days"
        />
        <Metric
          label="contradictions"
          value={stats.activeTensions.toLocaleString()}
          hint={critical.length === 0 ? "none critical" : `${critical.length} critical`}
          tone={critical.length > 0 ? "warn" : "plain"}
        />
        <Metric
          label="weak domains"
          value={selfModel.weakDomains.length.toString()}
          hint={selfModel.weakDomains.length === 0 ? "all above 75%" : "guardrails firing"}
          tone={selfModel.weakDomains.length > 0 ? "warn" : "plain"}
        />
      </Grid>

      {fresh ? (
        <Empty title="Nothing stored yet">
          <p>
            Point an agent at the service and it will start learning. The shortest path is{" "}
            <Link href="/dashboard/start" className="text-violet-300 underline underline-offset-2">
              get started
            </Link>
            : mint a key, send one message through <code className="text-zinc-400">runTurn</code>, and come
            back here.
          </p>
        </Empty>
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          <Panel
            title="Needs you"
            hint="Contradictions the agent is holding and domains it keeps failing in."
          >
            {needsYou.length === 0 ? (
              <p className="text-[13px] leading-6 text-zinc-500">
                Nothing unresolved. Every claim held agrees with every other one.
              </p>
            ) : (
              <ul className="space-y-2">
                {critical.slice(0, 4).map((tension) => (
                  <li key={tension.id} className="rounded-lg border border-amber-300/15 bg-amber-300/[0.04] px-3 py-2">
                    <div className="flex flex-wrap items-baseline gap-2">
                      <Badge tone="amber">{tension.impact}</Badge>
                      <span className="text-[13px] text-amber-50/90">“{tension.claimA.statement}”</span>
                      <span className="text-zinc-600">vs</span>
                      <span className="text-[13px] text-amber-50/90">“{tension.claimB.statement}”</span>
                    </div>
                    <p className="mt-1 text-[11px] text-amber-200/60">Ask: {tension.actionableQuestion}</p>
                  </li>
                ))}
                {selfModel.weakDomains.slice(0, 3).map((domain) => {
                  const capability = selfModel.domains[domain]
                  return (
                    <li
                      key={domain}
                      className="flex flex-wrap items-baseline justify-between gap-2 rounded-lg border border-white/[0.06] bg-white/[0.015] px-3 py-2"
                    >
                      <span className="font-mono text-[12px] text-zinc-300">{domain}</span>
                      <span className="font-mono text-[11px] text-amber-300/80">
                        {capability === undefined
                          ? ""
                          : `${Math.round(capability.reliabilityScore * 100)}% over ${capability.sampleCount}`}
                      </span>
                    </li>
                  )
                })}
              </ul>
            )}
            <Link
              href="/dashboard/tensions"
              className="mt-3 inline-block text-[11px] text-zinc-500 underline decoration-white/15 underline-offset-2 transition hover:text-zinc-200"
            >
              Open tensions
            </Link>
          </Panel>

          <Panel title="Tokens injected per day" hint="Last 14 days, UTC. Every context build, whatever it cost.">
            <AreaChart
              points={spend.daily.map((bucket) => ({ day: bucket.day, value: bucket.tokens }))}
              label="tokens"
            />
            <div className="mt-3 flex flex-wrap gap-x-5 gap-y-1 font-mono text-[10px] text-zinc-600">
              <span>{spend.totals.tokens.toLocaleString()} tokens total</span>
              <span>{spend.totals.truncated} truncated</span>
              <span>
                {spend.totals.guardrailBuilds} carried a guardrail
              </span>
            </div>
          </Panel>
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        <Panel
          title="Most used"
          hint="Counted when the memory is actually put in front of a model. Previews are not counted — they cost the service nothing."
          actions={
            <Link href="/dashboard/memory" className="text-[11px] text-zinc-500 hover:text-zinc-200">
              library
            </Link>
          }
        >
          {usedMost.length === 0 ? (
            <p className="text-[12px] text-zinc-600">Nothing has been injected yet.</p>
          ) : (
            <ul className="space-y-1.5">
              {usedMost.map((memory) => (
                <li key={memory.id} className="flex items-baseline gap-2.5">
                  <TierBadge tier={memory.tier} />
                  <span className="min-w-0 flex-1 truncate text-[13px] text-zinc-300">{memory.content}</span>
                  <span className="shrink-0 font-mono text-[10px] text-zinc-600">
                    {memory.accessCount}×
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Panel>

        <Panel
          title="Recent builds"
          hint="Every context build this agent has asked for, newest first."
          actions={
            <Link href="/dashboard/activity" className="text-[11px] text-zinc-500 hover:text-zinc-200">
              full log
            </Link>
          }
        >
          {recent.length === 0 ? (
            <p className="text-[12px] text-zinc-600">
              No context builds yet. One happens the first time an agent asks for memory.
            </p>
          ) : (
            <ul className="space-y-1">
              {recent.slice(0, 6).map((event) => (
                <li
                  key={event.id}
                  className="flex items-baseline justify-between gap-3 font-mono text-[11px]"
                >
                  <span className="shrink-0 text-zinc-700">
                    {new Date(event.createdAt).toLocaleString(undefined, {
                      month: "short",
                      day: "numeric",
                      hour: "2-digit",
                      minute: "2-digit"
                    })}
                  </span>
                  <span className="flex min-w-0 items-baseline gap-2">
                    <span className="truncate text-zinc-600">
                      {event.bodies} bodies · {event.indexLines} index
                    </span>
                    <span className={event.truncated ? "text-amber-300/80" : "text-zinc-400"}>
                      {event.tokens} tok
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>
    </div>
  )
}