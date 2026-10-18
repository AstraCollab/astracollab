import Link from "next/link"
import { notFound } from "next/navigation"
import { asc, eq } from "drizzle-orm"

import { Badge } from "@/components/ui/badge"
import {
  formatDuration,
  formatTime,
  formatTokens,
  formatUsd
} from "@/components/dashboard/metrics"
import { traceTone } from "@/components/dashboard/status"
import { TraceWaterfall, type WaterfallSpan } from "@/components/dashboard/waterfall"
import { getDb } from "@/server/db/client"
import { agents, spans, traces } from "@/server/db/schema"
import { requireOrganization } from "@/server/session"

export const metadata = {
  title: "Trace — Nah Cloud"
}

/**
 * One trace, as a span waterfall.
 *
 * The trace and its spans are fetched as two independent queries rather than a
 * join, because a join would multiply the trace row by the span count and the
 * trace's own metadata is needed exactly once to lay the bars out. The spans come
 * back sorted by start time and the component derives the tree from `parentId`, so
 * the ordering this query guarantees is the ordering the waterfall needs.
 *
 * No cap on the span query, unlike the list pages. The argument for capping those
 * was "a person will not scroll past a hundred rows"; the argument here is the
 * opposite — a truncated waterfall is not a shorter waterfall, it is a wrong one,
 * because the missing spans are missing from the middle of the timeline and the
 * bars that remain no longer line up against the total duration shown above them.
 */
export default async function TraceDetailPage({
  params
}: {
  readonly params: Promise<{ traceId: string }>
}) {
  const viewer = await requireOrganization()
  const { traceId } = await params
  const db = getDb()

  const [trace] = await db
    .select({
      id: traces.id,
      organizationId: traces.organizationId,
      name: traces.name,
      status: traces.status,
      startTime: traces.startTime,
      endTime: traces.endTime,
      rootSpanId: traces.rootSpanId,
      tags: traces.tags,
      metadata: traces.metadata,
      error: traces.error,
      costUsd: traces.costUsd,
      inputTokens: traces.inputTokens,
      outputTokens: traces.outputTokens,
      runId: traces.runId,
      agentName: agents.name
    })
    .from(traces)
    .leftJoin(agents, eq(traces.agentId, agents.id))
    .where(eq(traces.id, traceId))
    .limit(1)

  // Scoped by id AND organisation together rather than id alone. A trace id from
  // another tenant must read as "not found", not as "forbidden" — a 403 here would
  // confirm the id exists, which is the one thing the response should not do.
  if (trace === undefined || trace.organizationId !== viewer.organizationId) {
    notFound()
  }

  const spanRows = await db
    .select({
      id: spans.id,
      parentId: spans.parentId,
      name: spans.name,
      kind: spans.kind,
      status: spans.status,
      startTime: spans.startTime,
      endTime: spans.endTime,
      costUsdMicros: spans.costUsdMicros,
      attributes: spans.attributes
    })
    .from(spans)
    .where(eq(spans.traceId, trace.id))
    .orderBy(asc(spans.startTime))

  return (
    <div className="space-y-8">
      <header className="space-y-4">
        <Link
          href="/dashboard/traces"
          className="font-mono-tech text-xs text-[var(--ink-faint)] transition-colors hover:text-[var(--ink)]"
        >
          ← All traces
        </Link>

        <div className="flex flex-wrap items-center gap-3">
          <h1 className="tracking-display text-2xl font-semibold">{trace.name}</h1>
          <Badge tone={traceTone(trace.status)}>{trace.status}</Badge>
        </div>

        <p className="font-mono-tech text-xs text-[var(--ink-faint)]">{trace.id}</p>
      </header>

      <dl className="grid grid-cols-2 gap-px overflow-hidden rounded-[0.75rem] border border-line bg-[var(--surface-raised)] sm:grid-cols-3 lg:grid-cols-6">
        <Stat label="Duration" value={formatDuration(trace.endTime === null ? null : trace.endTime - trace.startTime)} />
        <Stat label="Cost" value={formatUsd(trace.costUsd)} />
        <Stat label="Input tokens" value={formatTokens(trace.inputTokens)} />
        <Stat label="Output tokens" value={formatTokens(trace.outputTokens)} />
        <Stat label="Spans" value={String(spanRows.length)} />
        <Stat label="Started" value={formatTime(trace.startTime)} />
      </dl>

      {trace.error !== null ? (
        <div className="rounded-[0.75rem] border border-line bg-[var(--surface-raised)] p-4">
          <h2 className="text-sm font-medium">Error</h2>
          <p className="font-mono-tech mt-2 whitespace-pre-wrap text-xs text-[var(--ink-muted)]">
            {trace.error.message}
            {trace.error.stack !== undefined ? `\n\n${trace.error.stack}` : ""}
          </p>
        </div>
      ) : null}

      <section className="space-y-3">
        <h2 className="font-mono-tech text-xs uppercase tracking-wider text-[var(--ink-faint)]">
          Spans
        </h2>
        <TraceWaterfall
          spans={spanRows.map((row) => ({
            ...row,
            costUsd: row.costUsdMicros
          })) satisfies readonly WaterfallSpan[]}
          traceStart={trace.startTime}
          traceEnd={trace.endTime}
        />
      </section>

      <section className="space-y-3">
        <h2 className="font-mono-tech text-xs uppercase tracking-wider text-[var(--ink-faint)]">
          Context
        </h2>
        <dl className="flex flex-col gap-2 rounded-[0.75rem] border border-line bg-[var(--surface-raised)] p-4 text-sm">
          <Row label="Agent">{trace.agentName ?? "— not a cloud agent"}</Row>
          {trace.runId !== null ? (
            <Row label="Run">
              <Link
                href={`/dashboard/runs/${trace.runId}`}
                className="font-mono-tech text-xs underline underline-offset-2"
              >
                {trace.runId}
              </Link>
            </Row>
          ) : null}
          <Row label="Root span">
            <span className="font-mono-tech text-xs">{trace.rootSpanId}</span>
          </Row>
          {trace.tags.map((tag) => (
            <Row key={tag} label="Tag">
              <span className="font-mono-tech text-xs">{tag}</span>
            </Row>
          ))}
          {Object.entries(trace.metadata).map(([key, value]) => (
            <Row key={key} label={key}>
              <span className="font-mono-tech break-all text-xs">{String(value)}</span>
            </Row>
          ))}
        </dl>
      </section>
    </div>
  )
}

function Stat({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <div className="bg-[var(--surface-raised)] px-4 py-3">
      <dt className="font-mono-tech text-[0.6875rem] uppercase tracking-wider text-[var(--ink-faint)]">
        {label}
      </dt>
      <dd className="num mt-1 text-sm">{value}</dd>
    </div>
  )
}

function Row({ label, children }: { readonly label: string; readonly children: React.ReactNode }) {
  return (
    <div className="flex gap-4">
      <dt className="w-32 shrink-0 font-mono-tech text-xs text-[var(--ink-faint)]">{label}</dt>
      <dd className="min-w-0 flex-1">{children}</dd>
    </div>
  )
}