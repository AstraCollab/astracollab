import { eq } from "drizzle-orm"
import { getDb } from "@/server/db/client"
import { organization } from "@/server/db/auth-tables"
import { githubConnections } from "@/server/db/schema"
import { requireOrganization } from "@/server/session"

export async function POST(request: Request) {
  const viewer = await requireOrganization()
  const orgId = viewer.organizationId

  const body = await request.json()
  const { defaultRepository } = body as { defaultRepository?: string }

  if (!defaultRepository) {
    return new Response(JSON.stringify({ error: "defaultRepository is required" }), {
      status: 400,
      headers: { "content-type": "application/json" },
    })
  }

  const db = getDb()

  // Verify the repo is in the organization's accessible repos
  // This is a security check to ensure they're not setting an arbitrary repo
  const [conn] = await db
    .select()
    .from(githubConnections)
    .where(eq(githubConnections.organizationId, orgId))
    .limit(1)

  if (conn?.selectedRepositories) {
    const repos = JSON.parse(conn.selectedRepositories) as Array<{ full_name: string }>
    const isValid = repos.some(r => r.full_name === defaultRepository)
    if (!isValid) {
      return new Response(JSON.stringify({ error: "Repository not accessible" }), {
        status: 400,
        headers: { "content-type": "application/json" },
      })
    }
  }

  await db
    .update(organization)
    .set({ defaultRepository })
    .where(eq(organization.id, orgId))

  return new Response(JSON.stringify({ success: true }), {
    status: 200,
    headers: { "content-type": "application/json" },
  })
}