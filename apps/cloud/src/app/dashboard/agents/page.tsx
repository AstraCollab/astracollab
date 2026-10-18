import Link from "next/link"
import { desc, eq, sql } from "drizzle-orm"

import { createAgentAction } from "@/app/dashboard/actions"
import { RepoSelect } from "@/app/dashboard/agents/repo-select"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { getDb } from "@/server/db/client"
import { agents, runs } from "@/server/db/schema"
import { requireOrganization } from "@/server/session"

export const metadata = {
  title: "Agents — Nah Cloud"
}

/**
 * The agents list, and the form that adds to it.
 *
 * An agent is the unit a user actually owns — a repository, a template, a set of
 * ceilings — so this is the page they will come back to, and it is built around
 * the create form being on the page rather than behind a route. The alternative
 * costs a click on every agent they will ever make.
 *
 * Run counts come from a lateral join rather than N queries. `sql<number>` with a
 * `count` over a subquery, because "how many runs does this agent have" on a
 * list of thirty agents is thirty round trips if it is asked naively.
 */
export default async function AgentsPage() {
  const viewer = await requireOrganization()
  const db = getDb()
  const orgId = viewer.organizationId

  const rows = await db
    .select({
      id: agents.id,
      name: agents.name,
      repository: agents.repository,
      instructions: agents.instructions,
      paused: agents.paused,
      createdAt: agents.createdAt,
      runCount: sql<number>`(
        select count(*)::int from ${runs}
        where ${runs.agentId} = ${agents.id}
      )`
    })
    .from(agents)
    .where(eq(agents.organizationId, orgId))
    .orderBy(desc(agents.createdAt))

  return (
    <div className="space-y-10">
      <header>
        <p className="eyebrow">{viewer.organizationName}</p>
        <h1 className="tracking-display mt-3 text-3xl font-semibold">Agents</h1>
      </header>

      <section className="glass rounded-[0.75rem] p-6">
        <h2 className="text-lg font-medium">New agent</h2>
        <p className="mt-2 text-sm text-[var(--ink-muted)]">
          An agent is a repository and a runtime template. Runs are started against
          it later.
        </p>

        <form action={createAgentAction} className="mt-5 grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <label htmlFor="name" className="eyebrow block">
              Name
            </label>
            <Input id="name" name="name" required placeholder="auth-service" />
          </div>
          <div className="space-y-2">
            <RepoSelect />
          </div>
          {/*
            Full width because it is the one field with something to say. The label
            says what it is *for* rather than what it is — a description of a
            description is not a description.
          */}
          <div className="space-y-2 sm:col-span-2">
            <label htmlFor="instructions" className="eyebrow block">
              What should this agent do?
            </label>
            <Textarea
              id="instructions"
              name="instructions"
              rows={3}
              placeholder="Reviews migrations for lock ordering and deadlocks, and fixes what it finds. Runs when a migration is added."
            />
            <p className="text-xs text-[var(--ink-faint)]">
              In your own words. This is the context the agent carries into every
              conversation, so &ldquo;finds flaky tests and explains why&rdquo; beats
              a list of settings.
            </p>
          </div>
          <div className="sm:col-span-2">
            <Button
              type="submit"
              className="rounded-[0.75rem] border-signal bg-signal text-[#09090b] hover:bg-signal/90"
            >
              Create agent
            </Button>
          </div>
        </form>
      </section>

      {rows.length === 0 ? (
        <div className="rounded-[0.75rem] border border-line p-8 text-center text-sm text-[var(--ink-muted)]">
          No agents yet.
        </div>
      ) : (
        <ul className="flex flex-col gap-2">
          {rows.map((agent) => (
            <li key={agent.id}>
              <Link
                href={`/dashboard/agents/${agent.id}`}
                className="flex items-center gap-4 rounded-[0.75rem] border border-line bg-[var(--surface-raised)] px-4 py-3 transition-colors hover:border-line-strong"
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{agent.name}</p>
                  {/* The description is the reason this list is useful without
                      opening anything, so it gets the second line. Falls back to
                      the repo when an agent predates the field. */}
                  <p className="mt-0.5 truncate text-xs text-[var(--ink-muted)]">
                    {agent.instructions || agent.repository}
                  </p>
                </div>
                {agent.paused ? <Badge tone="warn">paused</Badge> : null}
                <span className="num shrink-0 text-xs text-[var(--ink-muted)]">
                  {agent.runCount} run{agent.runCount === 1 ? "" : "s"}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
