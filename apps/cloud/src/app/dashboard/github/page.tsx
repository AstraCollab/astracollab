import { desc, eq } from "drizzle-orm"
import Link from "next/link"
import { notFound } from "next/navigation"

import { deleteGithubConnectionAction } from "@/app/dashboard/actions"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { getDb } from "@/server/db/client"
import { githubConnections } from "@/server/db/schema"
import { requireOrganization } from "@/server/session"

export const metadata = {
  title: "GitHub — Nah Cloud"
}

/**
 * List and manage GitHub connections for this organisation.
 *
 * Each organisation can connect one GitHub account. Connecting links the
 * organisation's agents to specific repositories so the agent runtime can
 * authenticate against them.
 */
export default async function GitHubPage() {
  const viewer = await requireOrganization()
  const db = getDb()
  const orgId = viewer.organizationId

  const [connection] = await db
    .select()
    .from(githubConnections)
    .where(eq(githubConnections.organizationId, orgId))
    .limit(1)

  return (
    <div className="space-y-10">
      <header className="space-y-3">
        <Link
          href="/dashboard"
          className="font-mono-tech text-xs text-[var(--ink-muted)] transition-colors hover:text-[var(--ink)]"
        >
          ← Dashboard
        </Link>
        <h1 className="tracking-display text-3xl font-semibold">GitHub</h1>
        <p className="text-sm text-[var(--ink-muted)]">
          Connect a GitHub account so agents can access repositories.
        </p>
      </header>

      <section className="glass rounded-[0.75rem] p-6">
        <h2 className="text-lg font-medium">Connected account</h2>

        {connection ? (
          <div className="mt-4 space-y-4">
            <div className="flex flex-wrap items-center gap-3">
              <Badge tone="busy">connected</Badge>
              <span className="font-mono-tech text-sm text-[var(--ink-muted)]">
                Installation #{connection.githubInstallationId}
              </span>
            </div>
            <p className="text-sm text-[var(--ink-muted)]">
              Connected on{" "}
              {connection.createdAt.toLocaleDateString(undefined, {
                year: "numeric",
                month: "long",
                day: "numeric"
              })}
            </p>

            <form action={deleteGithubConnectionAction}>
              <input type="hidden" name="organizationId" value={orgId} />
              <Button type="submit" variant="outline" className="rounded-[0.75rem]">
                Disconnect
              </Button>
            </form>
          </div>
        ) : (
          <div className="mt-4">
            <p className="text-sm text-[var(--ink-muted)]">
              No GitHub account connected yet.
            </p>
            <form action="/api/auth/signin/github">
              <Button
                type="submit"
                className="mt-3 rounded-[0.75rem] border-signal bg-signal text-[#09090b] hover:bg-signal/90"
              >
                Connect GitHub account
              </Button>
            </form>
          </div>
        )}
      </section>
    </div>
  )
}