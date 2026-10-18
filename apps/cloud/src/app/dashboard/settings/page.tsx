import { eq } from "drizzle-orm"
import Link from "next/link"
import { notFound } from "next/navigation"

import { getDb } from "@/server/db/client"
import { githubConnections } from "@/server/db/schema"
import { organization } from "@/server/db/auth-tables"
import { requireOrganization } from "@/server/session"
import { SettingsClient } from "./SettingsClient"

export const metadata = {
  title: "Settings — Nah Cloud"
}

export default async function SettingsPage() {
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

  return (
    <div className="space-y-10">
      <header className="space-y-3">
        <Link
          href="/dashboard"
          className="font-mono-tech text-xs text-[var(--ink-muted)] transition-colors hover:text-[var(--ink)]"
        >
          ← Dashboard
        </Link>
        <h1 className="tracking-display text-3xl font-semibold">Settings</h1>
        <p className="text-sm text-[var(--ink-muted)]">
          Manage your workspace and integrations.
        </p>
      </header>

      <SettingsClient
        org={org}
        githubConnection={githubConnection}
        orgId={orgId}
      />
    </div>
  )
}