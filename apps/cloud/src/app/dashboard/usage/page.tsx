import Link from "next/link"
import { desc, eq } from "drizzle-orm"

import { formatDuration, formatTime, formatTokens } from "@/components/dashboard/metrics"
import { readUsageTotals } from "@/server/billing/meter"
import { getDb } from "@/server/db/client"
import { agents, runs, usageLedger } from "@/server/db/schema"
import { requireOrganization } from "@/server/session"

export const metadata = {
  title: "Usage — Nah Cloud"
}

const PAGE_SIZE = 100

/**
 * The metering ledger.
 *
 * Append-only, so this is an audit view rather than a report: every row is a run
 * that settled, and the totals above are the sum of rows the reader can scroll to
 * and check. There is deliberately no edit or delete here — an entry that is wrong
 * is corrected by appending a correcting row in the billing system, not by
 * quietly rewriting history, and this page exists so the rewrite is visible if it
 * ever happens.
 *
 * Capped rather than paginated, for the same reason the runs list is: this is a
 * reference view, and the totals above are computed over the whole ledger rather
 * than over the visible page, so the cap cannot change the numbers.
 */
export default async function UsagePage() {
  const viewer = await requireOrganization()
  const db = getDb()
  const orgId = viewer.organizationId

  const [totals, entries] = await Promise.all([
    readUsageTotals(orgId),
    db
      .select({
        id: usageLedger.id,
        runId: usageLedger.runId,
        tokens: usageLedger.tokens,
        computeMs: usageLedger.computeMs,
        storageBytes: usageLedger.storageBytes,
        recordedAt: usageLedger.recordedAt,
        runStatus: runs.status,
        prompt: runs.prompt,
        agentName: agents.name
      })
      .from(usageLedger)
      .leftJoin(runs, eq(usageLedger.runId, runs.id))
      .leftJoin(agents, eq(runs.agentId, agents.id))
      .where(eq(usageLedger.organizationId, orgId))
      .orderBy(desc(usageLedger.recordedAt))
      .limit(PAGE_SIZE)
  ])

  return (
    <div className="space-y-10">
      <header>
        <p className="eyebrow">{viewer.organizationName}</p>
        <h1 className="tracking-display mt-3 text-3xl font-semibold">Usage</h1>
        <p className="mt-3 max-w-prose text-sm text-[var(--ink-muted)]">
          What each settled run cost. Every row here is written once and never
          changed, so these totals are the sum of what is listed below them.
        </p>
      </header>

      <dl className="grid grid-cols-2 gap-px overflow-hidden rounded-[0.75rem] border border-line bg-[var(--surface-raised)] lg:grid-cols-4">
        <Stat label="Metered runs" value={totals.entries.toLocaleString("en-US")} />
        <Stat label="Tokens" value={formatTokens(totals.tokens)} />
        <Stat label="Compute" value={formatDuration(totals.computeMs)} />
        <Stat label="Storage peak" value={formatBytes(totals.storageBytes)} />
      </dl>

      {entries.length === 0 ? (
        <div className="rounded-[0.75rem] border border-line p-8 text-center text-sm text-[var(--ink-muted)]">
          Nothing metered yet. A run is metered when it settles.
        </div>
      ) : (
        <div className="overflow-hidden rounded-[0.75rem] border border-line bg-[var(--surface-raised)]">
          <div className="grid grid-cols-[minmax(0,3fr)_repeat(3,minmax(0,1fr))] gap-4 border-b border-line px-4 py-2 font-mono-tech text-[0.6875rem] uppercase tracking-wider text-[var(--ink-faint)]">
            <span>Run</span>
            <span className="text-right">Tokens</span>
            <span className="text-right">Compute</span>
            <span className="text-right">Storage</span>
          </div>

          <ul>
            {entries.map((entry) => (
              <li
                key={entry.id}
                className="grid grid-cols-[minmax(0,3fr)_repeat(3,minmax(0,1fr))] items-center gap-4 border-b border-line px-4 py-3 last:border-b-0"
              >
                <div className="min-w-0">
                  {entry.runId !== null ? (
                    <Link
                      href={`/dashboard/runs/${entry.runId}`}
                      className="block truncate text-sm transition-colors hover:text-signal"
                    >
                      {entry.prompt ?? entry.runId}
                    </Link>
                  ) : (
                    // `runId` is nullable so a row can survive the run it billed
                    // being deleted. An entry that outlives its run is still a real
                    // charge, so it is listed rather than hidden — but there is no
                    // longer anything to link to.
                    <span className="block truncate text-sm text-[var(--ink-muted)]">
                      Run deleted
                    </span>
                  )}
                  <span className="font-mono-tech mt-0.5 block truncate text-[0.6875rem] text-[var(--ink-faint)]">
                    {entry.agentName ?? "—"} · {formatTime(entry.recordedAt.getTime())}
                  </span>
                </div>

                <span className="num text-right text-xs">
                  {formatTokens(entry.tokens)}
                </span>
                <span className="num text-right text-xs text-[var(--ink-faint)]">
                  {formatDuration(entry.computeMs)}
                </span>
                <span className="num text-right text-xs text-[var(--ink-faint)]">
                  {formatBytes(entry.storageBytes)}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {entries.length === PAGE_SIZE ? (
        <p className="font-mono-tech text-xs text-[var(--ink-faint)]">
          Showing the {PAGE_SIZE} most recent. The totals above cover every entry.
        </p>
      ) : null}
    </div>
  )
}

function Stat({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <div className="bg-[var(--surface-raised)] px-4 py-4">
      <dt className="font-mono-tech text-[0.6875rem] uppercase tracking-wider text-[var(--ink-faint)]">
        {label}
      </dt>
      <dd className="num mt-1 text-xl">{value}</dd>
    </div>
  )
}

/**
 * Bytes, in the largest unit that keeps the number readable.
 *
 * Storage peaks are the one figure here that can be three or four orders of
 * magnitude apart between rows, so a fixed unit either shows `0.0 GB` for every
 * sandbox or `20480.0 MB` for a large one.
 */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`
}