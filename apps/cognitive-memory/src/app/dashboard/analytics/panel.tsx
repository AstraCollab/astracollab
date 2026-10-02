"use client"

import Link from "next/link"
import { useState } from "react"

import { AreaChart, BarList, Bars, PALETTE, SplitBar } from "../charts"
import { useResource, type Analytics } from "../data"
import { Button, Failure, Grid, Loading, Metric, PageHeader, Panel, Segmented } from "../ui"

/**
 * What memory is costing, and what it is buying.
 *
 * The reason mix is the point of this page. "118k tokens this month" is a number
 * with no action attached; "104k of those were index lines and 2k were full
 * bodies" says the store has nothing worth promoting, which is a completely
 * different problem from the budget being too small — and the fix for one makes
 * the other worse.
 *
 * The truncation rate is shown next to utilisation for the same reason. A median
 * turn at 95% of the ceiling is one edit away from silently dropping memories,
 * and the dashboard that only shows the happy average is the one you find out
 * from during an incident.
 */

type Range = "7d" | "30d" | "90d" | "365d"

const RANGES: ReadonlyArray<{ value: Range; label: string }> = [
  { value: "7d", label: "7d" },
  { value: "30d", label: "30d" },
  { value: "90d", label: "90d" },
  { value: "365d", label: "1y" }
]

const REASON_LABEL: Record<string, string> = {
  index: "index lines",
  trigger: "triggered bodies",
  tension: "contradictions",
  guardrail: "guardrails"
}

/** Colours by tier, so the mix chart matches the badges everywhere else. */
const TIER_TONE: Record<string, string> = {
  L0: PALETTE[4],
  L1: PALETTE[2],
  L2: PALETTE[0],
  L3: PALETTE[5]
}

export function AnalyticsPanel() {
  const [range, setRange] = useState<Range>("30d")
  const { data, error, loading, reload } = useResource<Analytics>(
    `/api/dashboard/analytics?range=${range}`
  )

  if (error !== null) return <Failure message={error} onRetry={reload} />
  if (data === null) return <Loading label="Adding up the tokens…" />

  const { totals, daily, routes, keys, reasons, tiers, domains, sources, largest, budget } = data
  const noData = totals.builds === 0

  return (
    <div className="space-y-6">
      <PageHeader
        title="Analytics"
        description={
          <>
            Tokens are the budget this service exists to protect, so they are counted
            per build and kept with the reason each line was included. Buckets are UTC
            days.
          </>
        }
        actions={
          <>
            <Segmented value={range} options={RANGES} onChange={setRange} />
            <Button onClick={() => download(data)}>Export JSON</Button>
          </>
        }
      />

      {noData && (
        <p className="rounded-xl border border-white/[0.08] bg-white/[0.02] px-4 py-3 text-[13px] leading-6 text-zinc-500">
          No context builds in this range, so there is nothing to add up. An agent makes
          one every turn once{" "}
          <Link href="/dashboard/start" className="text-violet-300 underline underline-offset-2">
            it is pointed at the service
          </Link>
          .
        </p>
      )}

      <Grid cols={5}>
        <Metric label="tokens injected" value={totals.tokens.toLocaleString()} hint={`${totals.builds} builds`} />
        <Metric
          label="median / turn"
          value={totals.medianTokens.toLocaleString()}
          hint={`p95 ${totals.p95Tokens.toLocaleString()}`}
        />
        <Metric
          label="budget used"
          value={`${Math.round(totals.utilisation * 100)}%`}
          hint={`ceiling ${budget.maxTotalTokens.toLocaleString()}`}
          tone={totals.utilisation > 0.85 ? "warn" : "plain"}
        />
        <Metric
          label="truncated"
          value={`${totals.truncated}`}
          hint={`${Math.round(totals.truncatedShare * 100)}% of builds`}
          tone={totals.truncatedShare > 0.1 ? "warn" : "plain"}
        />
        <Metric
          label="memories added"
          value={totals.memoriesAdded.toLocaleString()}
          hint={`${totals.memories} held`}
        />
      </Grid>

      <div className="grid gap-4 lg:grid-cols-2">
        <Panel title="Tokens injected per day" hint="What memory cost, day by day. UTC days.">
          <AreaChart
            points={daily.map((bucket) => ({ day: bucket.day, value: bucket.tokens }))}
            label="tokens"
          />
        </Panel>

        <Panel
          title="Why each line was included"
          hint="The whole point of the count. Index lines are cheap; triggered bodies are what a budget protects."
        >
          <SplitBar
            segments={reasons.map((entry) => ({
              label: REASON_LABEL[entry.label] ?? entry.label,
              value: entry.count
            }))}
          />
          <p className="mt-3 text-[11px] leading-5 text-zinc-600">
            {totals.guardrailBuilds} of {totals.builds} builds carried at least one guardrail
            line, because a domain the agent has been unreliable in was active.
          </p>
        </Panel>

        <Panel title="Builds per day" hint="How often the agent asked for memory.">
          <Bars points={daily.map((bucket) => ({ day: bucket.day, value: bucket.builds }))} label="builds" />
        </Panel>

        <Panel title="Memories added per day" hint="Learning rate. A flat line means nothing new is arriving.">
          <Bars
            points={daily.map((bucket) => ({ day: bucket.day, value: bucket.added }))}
            label="memories"
            tone="#34d399"
          />
        </Panel>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Panel title="By tier" hint="Where the store actually sits, and therefore what every prompt pays for.">
          <SplitBar
            segments={tiers.map((entry) => ({
              label: entry.label,
              value: entry.count,
              tone: TIER_TONE[entry.label]
            }))}
          />
          <p className="mt-3 text-[11px] leading-5 text-zinc-600">
            L1 is an index line in every prompt. Everything below it costs nothing until
            something recalls it.
          </p>
        </Panel>

        <Panel title="By endpoint" hint="Every key-authenticated call in the range.">
          <BarList
            rows={routes.map((row) => ({
              label: row.route,
              value: row.calls,
              detail: row.tokens > 0 ? `${row.tokens.toLocaleString()} tok` : undefined
            }))}
            empty="No calls recorded in this range."
          />
        </Panel>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Panel title="By key" hint="Which agent is spending. Revoke anything you do not recognise.">
          <BarList
            rows={keys.map((key) => ({
              label: `${key.name} · ${key.prefix}`,
              value: key.tokens,
              detail: `${key.calls} calls${key.revoked ? " · revoked" : ""}`
            }))}
            empty="No keys have called this organisation yet."
          />
        </Panel>

        <Panel title="Top domains" hint="Where the knowledge is concentrated. Weak domains get guardrails.">
          <BarList
            rows={domains.map((entry) => ({ label: entry.label, value: entry.count }))}
            empty="No domains tagged yet."
          />
        </Panel>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Panel title="Where memories came from" hint="Rules and model extraction, or a person typing into the dashboard.">
          <BarList
            rows={sources.map((entry) => ({ label: entry.label, value: entry.count }))}
            empty="Nothing stored yet."
          />
        </Panel>

        <Panel title="Most expensive builds" hint="The prompts to go and read in the activity log.">
          {largest.length === 0 ? (
            <p className="text-[12px] text-zinc-600">No builds in this range.</p>
          ) : (
            <ul className="space-y-2">
              {largest.map((row) => (
                <li key={row.id} className="flex items-baseline justify-between gap-3">
                  <span className="min-w-0 truncate font-mono text-[11px] text-zinc-500">
                    {row.preview === "" ? "(empty block)" : row.preview}
                  </span>
                  <span className="flex shrink-0 items-baseline gap-2">
                    <span className="font-mono text-[10px] text-zinc-700">{row.bodies} bodies</span>
                    <span className={row.truncated ? "text-amber-300/80" : "text-zinc-400"}>
                      {row.tokens.toLocaleString()} tok
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          )}
          {loading && <p className="pt-2 text-[11px] text-zinc-700">updating…</p>}
        </Panel>
      </div>
    </div>
  )
}

/**
 * The numbers, as a file.
 *
 * Worth having because "my agent's memory cost doubled last week" is usually
 * settled by exporting both weeks and diffing them, and asking somebody to read
 * seven chart axes to establish that is a slow way to be right.
 */
const download = (data: Analytics): void => {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" })
  const url = URL.createObjectURL(blob)
  const link = document.createElement("a")
  link.href = url
  link.download = `cognitive-memory-${new Date(data.to).toISOString().slice(0, 10)}.json`
  link.click()
  URL.revokeObjectURL(url)
}