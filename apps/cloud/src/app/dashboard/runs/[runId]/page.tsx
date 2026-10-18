import Link from "next/link"
import { notFound } from "next/navigation"
import { and, asc, eq } from "drizzle-orm"

import { cancelRunAction } from "@/app/dashboard/actions"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { runTone } from "@/components/dashboard/status"
import { Transcript } from "@/components/dashboard/transcript"
import { getDb } from "@/server/db/client"
import { agents, runEvents, runs } from "@/server/db/schema"
import { requireOrganization } from "@/server/session"
import { reconcileRun } from "@/server/runs/runner"

export const metadata = {
  title: "Run — Nah Cloud"
}

/**
 * One run, and everything it produced.
 *
 * The page is a read model: it replays `run_events` in `sequence` order.
 * Reconcile-on-read pulls any new events, and a small client refresh keeps
 * active runs live.
 */
export default async function RunPage({ params }: { readonly params: Promise<{ runId: string }> }) {
  const viewer = await requireOrganization()
  const db = getDb()
  const { runId } = await params

  const [row] = await db
    .select({
      id: runs.id,
      status: runs.status,
      commandId: runs.commandId,
      sandboxId: runs.sandboxId,
      prompt: runs.prompt,
      error: runs.error,
      exitCode: runs.exitCode,
      tokensIn: runs.tokensIn,
      tokensOut: runs.tokensOut,
      createdAt: runs.createdAt,
      startedAt: runs.startedAt,
      finishedAt: runs.finishedAt,
      agentId: agents.id,
      agentName: agents.name,
      repository: agents.repository
    })
    .from(runs)
    .innerJoin(agents, eq(runs.agentId, agents.id))
    .where(and(eq(runs.id, runId), eq(runs.organizationId, viewer.organizationId)))
    .limit(1)

  if (!row) notFound()

  await reconcileRun(row.id)

  const events = await db
    .select()
    .from(runEvents)
    .where(eq(runEvents.runId, row.id))
    // `sequence`, not `createdAt`: two events can share a millisecond, and the
    // unique index on (run_id, sequence) is what makes the order total.
    .orderBy(asc(runEvents.sequence))

  const durationMs =
    row.startedAt && row.finishedAt ? row.finishedAt.getTime() - row.startedAt.getTime() : null

  const facts: readonly (readonly [string, string])[] = [
    ["agent", row.agentName],
    ["repository", row.repository],
    ["started", row.startedAt ? row.startedAt.toISOString() : "not started"],
    [
      "duration",
      durationMs === null ? "—" : `${(durationMs / 1000).toFixed(1)}s`
    ],
    ["exit code", row.exitCode === null ? "—" : String(row.exitCode)],
    [
      "tokens",
      row.tokensIn === null && row.tokensOut === null
        ? "—"
        : `${row.tokensIn ?? 0} in / ${row.tokensOut ?? 0} out`
    ]
  ]

  return (
    <div className="space-y-10">
      <header className="space-y-3">
        <Link
          href="/dashboard/runs"
          className="font-mono-tech text-xs text-[var(--ink-muted)] transition-colors hover:text-[var(--ink)]"
        >
          ← Runs
        </Link>
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="tracking-display text-2xl font-semibold">{row.prompt}</h1>
          <Badge tone={runTone(row.status)}>{row.status}</Badge>
        </div>
        {row.status === "running" || row.status === "queued" ? (
          <form action={cancelRunAction}>
            <input type="hidden" name="runId" value={row.id} />
            <Button type="submit" variant="outline" className="rounded-[0.75rem]">
              Cancel run
            </Button>
          </form>
        ) : null}
      </header>

      {/* An error is shown as its own block rather than folded into the facts
          table, because it is the one field here that explains the other ones —
          a failed run's missing exit code and missing duration are consequences
          of it, not independent facts. */}
      {row.error ? (
        <p className="rounded-[0.75rem] border border-amber-500/40 bg-amber-500/5 p-4 text-sm text-amber-300">
          {row.error}
        </p>
      ) : null}

      <section className="elev-1 rounded-[0.75rem] border border-line bg-[var(--surface-raised)] p-5">
        <dl className="grid gap-3 sm:grid-cols-2">
          {facts.map(([label, value]) => (
            <div key={label} className="flex items-baseline justify-between gap-4">
              <dt className="eyebrow">{label}</dt>
              <dd className="font-mono-tech min-w-0 truncate text-xs text-[var(--ink-muted)]">
                {value}
              </dd>
            </div>
          ))}
        </dl>
      </section>

      <section>
        <h2 className="text-lg font-medium">Transcript</h2>
        <p className="font-mono-tech mt-1 text-xs text-[var(--ink-faint)]">
          {events.length} event{events.length === 1 ? "" : "s"}
        </p>
        <div className="mt-4">
          <Transcript events={events} />
        </div>
      </section>
    </div>
  )
}
