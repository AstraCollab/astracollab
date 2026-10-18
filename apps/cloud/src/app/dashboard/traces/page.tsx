import Link from "next/link"
import { desc, eq } from "drizzle-orm"

import { Badge } from "@/components/ui/badge"
import {
  formatDuration,
  formatTime,
  formatTokens,
  formatUsd
} from "@/components/dashboard/metrics"
import { traceTone } from "@/components/dashboard/status"
import { getDb } from "@/server/db/client"
import { agents, traces } from "@/server/db/schema"
import { requireOrganization } from "@/server/session"

export const metadata = {
  title: "Traces — Nah Cloud"
}

const PAGE_SIZE = 100

/**
 * Every trace this organisation's harness has posted, newest first.
 *
 * Unfiltered on purpose, for the same reason the runs list is: the question
 * someone opens this page with is "what did that run do a minute ago", and a
 * default filter pushes the answer off the top row.
 *
 * The trace id is shown in full-width monospace rather than shortened here,
 * because the one thing a reader does with this page is copy an id into the
 * `nah traces` CLI or a bug report. Shortening it to make the row prettier would
 * take away the only field that is useful elsewhere.
 */
export default async function TracesPage() {
  const viewer = await requireOrganization()
  const db = getDb()

  const rows = await db
    .select({
      id: traces.id,
      name: traces.name,
      status: traces.status,
      startTime: traces.startTime,
      endTime: traces.endTime,
      costUsd: traces.costUsd,
      inputTokens: traces.inputTokens,
      outputTokens: traces.outputTokens,
      tags: traces.tags,
      agentName: agents.name
    })
    .from(traces)
    .leftJoin(agents, eq(traces.agentId, agents.id))
    .where(eq(traces.organizationId, viewer.organizationId))
    .orderBy(desc(traces.startTime))
    .limit(PAGE_SIZE)

  return (
    <div className="space-y-10">
      <header>
        <p className="eyebrow">{viewer.organizationName}</p>
        <h1 className="tracking-display mt-3 text-3xl font-semibold">Traces</h1>
        <p className="mt-3 max-w-prose text-sm text-[var(--ink-muted)]">
          Every run of the agent harness, as it reported itself. Open one to see the
          span waterfall — model calls, tool calls and where the time went.
        </p>
      </header>

      {rows.length === 0 ? (
        <div className="rounded-[0.75rem] border border-line p-8 text-center text-sm text-[var(--ink-muted)]">
          No traces yet. They appear here once a harness with tracing enabled runs.
        </div>
      ) : (
        <ul className="flex flex-col gap-2">
          {rows.map((trace) => (
            <li key={trace.id}>
              <Link
                href={`/dashboard/traces/${trace.id}`}
                className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-[0.75rem] border border-line bg-[var(--surface-raised)] px-4 py-3 transition-colors hover:border-line-strong"
              >
                <Badge tone={traceTone(trace.status)}>{trace.status}</Badge>

                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm">{trace.name}</span>
                  {trace.tags.length > 0 ? (
                    <span className="mt-1 flex flex-wrap gap-1.5">
                      {trace.tags.map((tag) => (
                        <span
                          key={tag}
                          className="font-mono-tech rounded-[0.35rem] border border-line px-1.5 py-0.5 text-[0.6875rem] text-[var(--ink-faint)]"
                        >
                          {tag}
                        </span>
                      ))}
                    </span>
                  ) : null}
                </span>

                <span className="num shrink-0 text-xs text-[var(--ink-faint)]">
                  {formatDuration(
                    trace.endTime === null ? null : trace.endTime - trace.startTime
                  )}
                </span>
                <span className="num shrink-0 text-xs text-[var(--ink-faint)]">
                  {formatTokens(trace.inputTokens)} in /{" "}
                  {formatTokens(trace.outputTokens)} out
                </span>
                <span className="num shrink-0 text-xs text-[var(--ink-faint)]">
                  {formatUsd(trace.costUsd)}
                </span>
                <span className="font-mono-tech hidden shrink-0 text-xs text-[var(--ink-faint)] sm:block">
                  {trace.id}
                </span>
                <time
                  dateTime={new Date(trace.startTime).toISOString()}
                  className="font-mono-tech hidden shrink-0 text-xs text-[var(--ink-faint)] md:block"
                >
                  {formatTime(trace.startTime)}
                </time>
              </Link>
            </li>
          ))}
        </ul>
      )}

      {rows.length === PAGE_SIZE ? (
        <p className="font-mono-tech text-xs text-[var(--ink-faint)]">
          Showing the {PAGE_SIZE} most recent.
        </p>
      ) : null}
    </div>
  )
}