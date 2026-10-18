import { eq } from "drizzle-orm"
import Link from "next/link"
import { notFound, redirect } from "next/navigation"

import { getDb } from "@/server/db/client"
import { githubConnections } from "@/server/db/schema"
import { organization } from "@/server/db/auth-tables"
import { requireOrganization } from "@/server/session"
import { WorkspaceSetupClient } from "./WorkspaceSetupClient"

export const metadata = {
  title: "Workspace Setup — Nah Cloud"
}

export default async function WorkspaceSetupPage() {
  const viewer = await requireOrganization()
  const db = getDb()
  const orgId = viewer.organizationId

  const [org] = await db
    .select()
    .from(organization)
    .where(eq(organization.id, orgId))
    .limit(1)

  const [githubConnection] = await db
    .select()
    .from(githubConnections)
    .where(eq(githubConnections.organizationId, orgId))
    .limit(1)

  if (!org) notFound()

  // If no GitHub connection, redirect to GitHub page
  if (!githubConnection) {
    redirect("/dashboard/github")
  }

  // If already has a default repo, redirect to agents page
  if (org.defaultRepository) {
    redirect("/dashboard/agents")
  }

  return (
    <div className="space-y-10">
      <header className="space-y-3">
        <Link
          href="/dashboard"
          className="font-mono-tech text-xs text-[var(--ink-muted)] transition-colors hover:text-[var(--ink)]"
        >
          ← Dashboard
        </Link>
        <h1 className="tracking-display text-3xl font-semibold">Workspace Setup</h1>
        <p className="text-sm text-[var(--ink-muted)]">
          Choose a default repository for new agents. You can change this later in Settings.
        </p>
      </header>

      <WorkspaceSetupClient
        org={org}
        githubConnection={githubConnection}
        orgId={orgId}
      />
    </div>
  )
}