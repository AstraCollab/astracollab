import Link from "next/link"
import { and, desc, eq, ne, sql, type SQL } from "drizzle-orm"

import { Badge } from "@/components/ui/badge"
import { runTone, sandboxTone } from "@/components/dashboard/status"
import { getDb } from "@/server/db/client"
import { agents, runs, sandboxes, usageLedger } from "@/server/db/schema"
import { requireOrganization } from "@/server/session"

/**
 * `count(*)` and its conditional form, cast so they arrive as numbers.
 *
 * Postgres returns a count as `bigint`, and `postgres` has no parser for it, so
 * without the cast these arrive as strings and `String(...)` below would render
 * `"42"` as though it were a number. Drizzle's own `count()` emits the same
 * uncast `count(*)`.
 */
const rowCount = sql<number>`count(*)::int`
const countWhere = (predicate: SQL): SQL<number> =>
  sql<number>`count(*) filter (where ${predicate})::int`

export const metadata = {
  title: "Dashboard — Nah Cloud"
}

/**
 * The overview.
 *
 * Four numbers and the five most recent runs, and that is the whole page. The
 * failure mode this replaces is an authenticated user landing on an empty shell
 * with no idea whether the system is working, so the numbers that answer "is
 * anything running" come first and the rest of the dashboard is one click away.
 *
 * Every query is scoped by `organizationId` from the session. It is the same
 * tenancy seam the actions use, and it is applied here rather than trusted from a
 * parent, because this is the page that would leak across tenants if anything
 * were going to.
 */
export default async function DashboardPage() {
  const viewer = await requireOrganization()
  const db = getDb()
  const orgId = viewer.organizationId

  // Counted and summed in Postgres, not selected and reduced here.
  //
  // These four figures used to be `select({id})` plus `.length`, which reads every
  // row of a table that only ever grows and throws all but the count away. On an
  // organization with a few thousand runs that is a few thousand rows over the
  // wire to produce the number `4`, on the page a user hits first. Each of these
  // is now a single aggregate row.
  const [agentCount] = await db
    .select({ value: rowCount })
    .from(agents)
    .where(eq(agents.organizationId, orgId))

  const [runCount] = await db
    .select({ value: rowCount })
    .from(runs)
    .where(eq(runs.organizationId, orgId))

  const [sandboxTotals] = await db
    .select({
      live: countWhere(eq(sandboxes.status, "running")),
      bytes: sql<string>`coalesce(sum(${sandboxes.bytesUsed}), 0)::bigint`
    })
    .from(sandboxes)
    .where(eq(sandboxes.organizationId, orgId))

  const [usageTotals] = await db
    .select({
      tokens: sql<string>`coalesce(sum(${usageLedger.tokens}), 0)::bigint`
    })
    .from(usageLedger)
    .where(eq(usageLedger.organizationId, orgId))

  const recent = await db
    .select({
      id: runs.id,
      status: runs.status,
      prompt: runs.prompt,
      createdAt: runs.createdAt,
      agentName: agents.name
    })
    .from(runs)
    .innerJoin(agents, eq(runs.agentId, agents.id))
    .where(eq(runs.organizationId, orgId))
    .orderBy(desc(runs.createdAt))
    .limit(5)

  const totalTokens = Number(usageTotals?.tokens ?? 0)
  const totalBytes = Number(sandboxTotals?.bytes ?? 0)

  // A short, bounded list of the sandboxes that are actually costing something.
  // Every sandbox regardless of status used to be listed here, which made a
  // long-dead sandbox look as live as the one running a job right now.
  const activeSandboxes = await db
    .select({
      id: sandboxes.id,
      boatSandboxId: sandboxes.boatSandboxId,
      status: sandboxes.status,
      bytesUsed: sandboxes.bytesUsed
    })
    .from(sandboxes)
    .where(
      and(
        eq(sandboxes.organizationId, orgId),
        ne(sandboxes.status, "destroyed")
      )
    )
    .orderBy(desc(sandboxes.createdAt))
    .limit(5)

  const stats = [
    { label: "Agents", value: String(agentCount?.value ?? 0), href: "/dashboard/agents" },
    { label: "Runs", value: String(runCount?.value ?? 0), href: "/dashboard/runs" },
    {
      label: "Live sandboxes",
      value: String(sandboxTotals?.live ?? 0),
      href: "/dashboard/sandboxes"
    },
    {
      label: "Tokens used",
      value: totalTokens.toLocaleString("en-US"),
      href: "/dashboard/usage"
    }
  ] as const

  return (
    <div className="space-y-10">
      <header>
        <p className="eyebrow">{viewer.organizationName}</p>
        <h1 className="tracking-display mt-3 text-3xl font-semibold">Overview</h1>
      </header>

      <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {stats.map((stat) => (
          <Link
            key={stat.label}
            href={stat.href}
            className="elev-1 rounded-[0.75rem] border border-line bg-[var(--surface-raised)] p-5 transition-colors hover:border-line-strong"
          >
            <p className="eyebrow">{stat.label}</p>
            {/* `num` is the shared tabular-figure class, so the four values line
                up on the digit rather than each centring in its own box. */}
            <p className="num mt-2 text-2xl font-medium">{stat.value}</p>
          </Link>
        ))}
      </section>

      <section>
        <div className="flex items-baseline justify-between">
          <h2 className="text-lg font-medium">Recent runs</h2>
          <Link
            href="/dashboard/runs"
            className="font-mono-tech text-xs text-[var(--ink-muted)] transition-colors hover:text-[var(--ink)]"
          >
            All runs →
          </Link>
        </div>

        {recent.length === 0 ? (
          <div className="mt-4 rounded-[0.75rem] border border-line p-8 text-center">
            <p className="text-sm text-[var(--ink-muted)]">
              No runs yet. Create an agent, then start one against it.
            </p>
            <Link
              href="/dashboard/agents"
              className="font-mono-tech mt-3 inline-block text-xs text-signal"
            >
              Go to agents →
            </Link>
          </div>
        ) : (
          <ul className="mt-4 flex flex-col gap-2">
            {recent.map((run) => (
              <li key={run.id}>
                <Link
                  href={`/dashboard/runs/${run.id}`}
                  className="flex items-center gap-4 rounded-[0.75rem] border border-line bg-[var(--surface-raised)] px-4 py-3 transition-colors hover:border-line-strong"
                >
                  <Badge tone={runTone(run.status)}>{run.status}</Badge>
                  <span className="min-w-0 flex-1 truncate text-sm">
                    {run.prompt}
                  </span>
                  <span className="font-mono-tech hidden shrink-0 text-xs text-[var(--ink-faint)] sm:block">
                    {run.agentName}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      {activeSandboxes.length > 0 ? (
        <section>
          <div className="flex items-baseline justify-between">
            <h2 className="text-lg font-medium">Active sandboxes</h2>
            <Link
              href="/dashboard/sandboxes"
              className="font-mono-tech text-xs text-[var(--ink-muted)] transition-colors hover:text-[var(--ink)]"
            >
              All sandboxes →
            </Link>
          </div>
          <ul className="mt-4 flex flex-col gap-2">
            {activeSandboxes.map((sandbox) => (
              <li
                key={sandbox.id}
                className="flex items-center gap-4 rounded-[0.75rem] border border-line px-4 py-3"
              >
                <Badge tone={sandboxTone(sandbox.status)}>{sandbox.status}</Badge>
                <span className="font-mono-tech min-w-0 flex-1 truncate text-xs text-[var(--ink-muted)]">
                  {sandbox.boatSandboxId}
                </span>
                <span className="num shrink-0 text-xs text-[var(--ink-faint)]">
                  {(sandbox.bytesUsed / 1024 / 1024).toFixed(0)} MB
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <p className="font-mono-tech text-xs text-[var(--ink-faint)]">
        {totalBytes === 0
          ? "No storage in use."
          : `${(totalBytes / 1024 / 1024).toFixed(1)} MB of sandbox storage in use.`}
      </p>
    </div>
  )
}
