import { formatDuration, formatTokens, formatUsd } from "@/components/dashboard/metrics"
import {
  ANALYTICS_WINDOW_DAYS,
  readAgentStats,
  readModelStats,
  readSummary,
  readTimeseries,
  readToolStats,
  type TimeseriesPoint
} from "@/server/analytics/queries"
import { requireOrganization } from "@/server/session"

export const metadata = {
  title: "Analytics — Nah Cloud"
}

/**
 * Spend, throughput and latency over the last thirty days.
 *
 * All five reads run concurrently. They are independent aggregations over the same
 * tables with no ordering between them, and issuing them in sequence would make the
 * page's latency the sum of five queries for no reason a reader could observe.
 */
export default async function AnalyticsPage() {
  const viewer = await requireOrganization()

  const [summary, series, tools, models, agentRows] = await Promise.all([
    readSummary(viewer.organizationId),
    readTimeseries(viewer.organizationId),
    readToolStats(viewer.organizationId),
    readModelStats(viewer.organizationId),
    readAgentStats(viewer.organizationId)
  ])

  const errorRate = summary.traces === 0 ? 0 : (summary.errors / summary.traces) * 100
  const peak = series.reduce((max, point) => Math.max(max, point.traces), 0)

  return (
    <div className="space-y-10">
      <header>
        <p className="eyebrow">{viewer.organizationName}</p>
        <h1 className="tracking-display mt-3 text-3xl font-semibold">Analytics</h1>
        <p className="mt-3 max-w-prose text-sm text-[var(--ink-muted)]">
          The last {ANALYTICS_WINDOW_DAYS} days of harness activity.
        </p>
      </header>

      <dl className="grid grid-cols-2 gap-px overflow-hidden rounded-[0.75rem] border border-line bg-[var(--surface-raised)] lg:grid-cols-4">
        <Stat
          label="Total spend"
          value={formatUsd(summary.costMicros)}
          hint={
            summary.traces === 0
              ? "no traces yet"
              : `${formatUsd(Math.round(summary.costMicros / summary.traces))} per trace`
          }
        />
        <Stat label="Traces" value={summary.traces.toLocaleString("en-US")} hint={`${summary.runs} runs started`} />
        <Stat
          label="Median duration"
          value={formatDuration(summary.medianDurationMs)}
          hint={summary.traces === 0 ? "—" : `${errorRate.toFixed(1)}% error rate`}
        />
        <Stat
          label="Tokens"
          value={formatTokens(summary.inputTokens + summary.outputTokens)}
          hint={`${formatTokens(summary.inputTokens)} in / ${formatTokens(summary.outputTokens)} out`}
        />
      </dl>

      <section className="space-y-3">
        <h2 className="font-mono-tech text-xs uppercase tracking-wider text-[var(--ink-faint)]">
          Traces per day
        </h2>
        <TimeseriesChart points={series} peak={peak} />
      </section>

      <div className="grid gap-8 lg:grid-cols-2">
        <section className="space-y-3">
          <h2 className="font-mono-tech text-xs uppercase tracking-wider text-[var(--ink-faint)]">
            Tools
          </h2>
          <Table
            headers={["Tool", "Calls", "Errors", "p95"]}
            empty="No tool calls recorded."
            rows={tools.map((tool) => [
              <span key="tool" className="font-mono-tech text-xs">{tool.tool}</span>,
              tool.calls.toLocaleString("en-US"),
              <span key="errors" className={tool.errors > 0 ? "text-[var(--signal)]" : undefined}>
                {tool.errors.toLocaleString("en-US")}
              </span>,
              formatDuration(tool.p95Ms)
            ])}
          />
        </section>

        <section className="space-y-3">
          <h2 className="font-mono-tech text-xs uppercase tracking-wider text-[var(--ink-faint)]">
            Models
          </h2>
          <Table
            headers={["Model", "Calls", "Tokens", "Spend"]}
            empty="No model calls recorded."
            rows={models.map((model) => [
              <span key="model" className="font-mono-tech text-xs">{model.model}</span>,
              model.calls.toLocaleString("en-US"),
              formatTokens(model.inputTokens + model.outputTokens),
              formatUsd(model.costMicros)
            ])}
          />
        </section>
      </div>

      <section className="space-y-3">
        <h2 className="font-mono-tech text-xs uppercase tracking-wider text-[var(--ink-faint)]">
          By agent
        </h2>
        <Table
          headers={["Agent", "Traces", "Spend"]}
          empty="No agent activity."
          rows={agentRows.map((agent) => [
            <span key="agent" className="text-sm">{agent.name}</span>,
            agent.traces.toLocaleString("en-US"),
            formatUsd(agent.costMicros)
          ])}
        />
      </section>
    </div>
  )
}

/**
 * A bar per day, drawn with grid cells rather than an SVG.
 *
 * Thirty divs in a CSS grid. No charting dependency, and the bars scale off one
 * `grid-template-columns: repeat(30, 1fr)` instead of a computed pixel width per
 * bar — which is what keeps the chart responsive without measuring the container
 * in JavaScript.
 *
 * Bars are scaled against the busiest day, not the total. A chart whose bars are
 * relative to the full window renders a steady week as a flat line along the
 * bottom, because the y-axis is anchored to a peak that happened once.
 */
function TimeseriesChart({
  points,
  peak
}: {
  readonly points: readonly TimeseriesPoint[]
  readonly peak: number
}) {
  if (peak === 0) {
    return (
      <div className="rounded-[0.75rem] border border-line p-8 text-center text-sm text-[var(--ink-muted)]">
        No traces in this window.
      </div>
    )
  }

  return (
    <div className="rounded-[0.75rem] border border-line bg-[var(--surface-raised)] p-4">
      <div className="flex h-40 items-end gap-[3px]">
        {points.map((point) => {
          const height = (point.traces / peak) * 100
          const label = `${point.day}: ${point.traces} traces, ${point.errors} errors, ${formatUsd(point.costMicros)}`
          return (
            <div
              key={point.day}
              title={label}
              className="group relative flex h-full flex-1 flex-col justify-end"
            >
              {/* The error share rides on top of the success bar so a bad day is
                  legible in the same glance as a quiet one. */}
              <div
                className="w-full rounded-t-[2px] bg-[var(--ink-faint)]"
                style={{ height: `${height}%` }}
              >
                {point.errors > 0 ? (
                  <div
                    className="w-full rounded-t-[2px] bg-[var(--signal)]"
                    style={{ height: `${(point.errors / point.traces) * 100}%` }}
                  />
                ) : null}
              </div>
            </div>
          )
        })}
      </div>

      <div className="mt-3 flex justify-between font-mono-tech text-[0.6875rem] text-[var(--ink-faint)]">
        <span>{points[0]?.day}</span>
        <span>peak {peak}/day</span>
        <span>{points[points.length - 1]?.day}</span>
      </div>
    </div>
  )
}

function Stat({
  label,
  value,
  hint
}: {
  readonly label: string
  readonly value: string
  readonly hint: string
}) {
  return (
    <div className="bg-[var(--surface-raised)] px-4 py-4">
      <dt className="font-mono-tech text-[0.6875rem] uppercase tracking-wider text-[var(--ink-faint)]">
        {label}
      </dt>
      <dd className="num mt-1 text-xl">{value}</dd>
      <dd className="font-mono-tech mt-1 text-[0.6875rem] text-[var(--ink-faint)]">{hint}</dd>
    </div>
  )
}

function Table({
  headers,
  rows,
  empty
}: {
  readonly headers: readonly string[]
  readonly rows: readonly (readonly React.ReactNode[])[]
  readonly empty: string
}) {
  if (rows.length === 0) {
    return (
      <div className="rounded-[0.75rem] border border-line p-6 text-center text-sm text-[var(--ink-muted)]">
        {empty}
      </div>
    )
  }

  return (
    <div className="overflow-hidden rounded-[0.75rem] border border-line bg-[var(--surface-raised)]">
      <div className="grid grid-cols-4 gap-4 border-b border-line px-4 py-2 font-mono-tech text-[0.6875rem] uppercase tracking-wider text-[var(--ink-faint)]">
        {headers.map((header, index) => (
          <span key={header} className={index === 0 ? "" : "text-right"}>
            {header}
          </span>
        ))}
      </div>
      <ul>
        {rows.map((cells, rowIndex) => (
          <li
            key={rowIndex}
            className="grid grid-cols-4 items-center gap-4 border-b border-line px-4 py-2 last:border-b-0"
          >
            {cells.map((cell, cellIndex) => (
              <span
                key={cellIndex}
                className={`num min-w-0 truncate text-xs ${cellIndex === 0 ? "" : "text-right"}`}
              >
                {cell}
              </span>
            ))}
          </li>
        ))}
      </ul>
    </div>
  )
}