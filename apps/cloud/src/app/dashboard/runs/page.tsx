import Link from "next/link"
import { desc, eq } from "drizzle-orm"

import { Badge } from "@/components/ui/badge"
import { runTone } from "@/components/dashboard/status"
import { getDb } from "@/server/db/client"
import { agents, runs } from "@/server/db/schema"
import { requireOrganization } from "@/server/session"

export const metadata = {
  title: "Runs — Nah Cloud"
}

/**
 * Every run this organisation has started, newest first.
 *
 * Deliberately unfiltered. The obvious thing to add is a status filter, and the
 * reason it is not here is that the interesting question is never "show me the
 * running ones" — it is "did the run I started five minutes ago finish, and what
 * did it say", and a filter that defaults to hiding settled runs makes that
 * question harder to answer. Newest-first ordering already puts the recent one at
 * the top of the page.
 *
 * Capped rather than paginated. This is a reference view; a hundred rows is past
 * what anyone scrolls, and an unbounded query against a table that grows forever
 * is a page that gets slower the longer the product is used.
 */
export default async function RunsPage() {
  const viewer = await requireOrganization()
  const db = getDb()

  const rows = await db
    .select({
      id: runs.id,
      status: runs.status,
      prompt: runs.prompt,
      createdAt: runs.createdAt,
      finishedAt: runs.finishedAt,
      exitCode: runs.exitCode,
      agentName: agents.name
    })
    .from(runs)
    .innerJoin(agents, eq(runs.agentId, agents.id))
    .where(eq(runs.organizationId, viewer.organizationId))
    .orderBy(desc(runs.createdAt))
    .limit(100)

  return (
    <div className="space-y-10">
      <header>
        <p className="eyebrow">{viewer.organizationName}</p>
        <h1 className="tracking-display mt-3 text-3xl font-semibold">Runs</h1>
      </header>

      {rows.length === 0 ? (
        <div className="rounded-[0.75rem] border border-line p-8 text-center text-sm text-[var(--ink-muted)]">
          No runs yet. Open an agent and start one.
        </div>
      ) : (
        <ul className="flex flex-col gap-2">
          {rows.map((run) => (
            <li key={run.id}>
              <Link
                href={`/dashboard/runs/${run.id}`}
                className="flex items-center gap-4 rounded-[0.75rem] border border-line bg-[var(--surface-raised)] px-4 py-3 transition-colors hover:border-line-strong"
              >
                <Badge tone={runTone(run.status)}>{run.status}</Badge>
                <span className="min-w-0 flex-1 truncate text-sm">{run.prompt}</span>
                <span className="font-mono-tech hidden shrink-0 text-xs text-[var(--ink-faint)] sm:block">
                  {run.agentName}
                </span>
                {/* Exit code only once there is one. A null exit code on a settled
                    run means the sandbox died without reporting, which is a fact
                    worth showing rather than a gap worth hiding. */}
                {run.exitCode !== null ? (
                  <span className="num shrink-0 text-xs text-[var(--ink-faint)]">
                    exit {run.exitCode}
                  </span>
                ) : null}
              </Link>
            </li>
          ))}
        </ul>
      )}

      {rows.length === 100 ? (
        <p className="font-mono-tech text-xs text-[var(--ink-faint)]">
          Showing the 100 most recent.
        </p>
      ) : null}
    </div>
  )
}
