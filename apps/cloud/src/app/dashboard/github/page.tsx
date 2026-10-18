import { eq } from "drizzle-orm"
import Link from "next/link"
import { notFound } from "next/navigation"

import { getDb } from "@/server/db/client"
import { githubConnections } from "@/server/db/schema"
import { requireOrganization } from "@/server/session"
import { GitHubClient } from "./GitHubClient"

export const metadata = {
  title: "GitHub — Nah Cloud"
}

/**
 * List and manage GitHub App installations for this organisation.
 *
 * Each organisation connects one GitHub installation (user account or org).
 * The installation ID scopes repository access and is used to mint
 * short-lived installation tokens for agent runs.
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
          Connect a GitHub App installation so agents can access repositories.
        </p>
      </header>

      <section className="glass rounded-[0.75rem] p-6">
        <h2 className="text-lg font-medium">Connected installation</h2>

        <GitHubClient
          connection={connection}
          orgId={orgId}
        />
      </section>
    </div>
  )
}