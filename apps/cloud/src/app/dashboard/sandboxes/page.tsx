import Link from "next/link"
import { desc, eq } from "drizzle-orm"

import { destroySandboxAction } from "@/app/dashboard/actions"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { sandboxTone } from "@/components/dashboard/status"
import { getDb } from "@/server/db/client"
import { agents, sandboxes } from "@/server/db/schema"
import { requireOrganization } from "@/server/session"

export const metadata = {
  title: "Sandboxes — Nah Cloud"
}

/**
 * The organisation's sandboxes, live and dead.
 *
 * Destroyed ones are listed rather than hidden. That is the opposite of the usual
 * choice, and the reason is auditability: a run that used a sandbox is a billable
 * event, and a usage row pointing at a sandbox nobody can find is a line on an
 * invoice that cannot be explained. Keeping the row costs nothing — the disk is
 * already gone — and it makes the storage number below trustworthy.
 */
export default async function SandboxesPage() {
  const viewer = await requireOrganization()
  const db = getDb()

  const rows = await db
    .select({
      id: sandboxes.id,
      boatSandboxId: sandboxes.boatSandboxId,
      status: sandboxes.status,
      runtimeUrl: sandboxes.runtimeUrl,
      bytesUsed: sandboxes.bytesUsed,
      createdAt: sandboxes.createdAt,
      agentId: sandboxes.agentId,
      agentName: agents.name
    })
    .from(sandboxes)
    .leftJoin(agents, eq(sandboxes.agentId, agents.id))
    .where(eq(sandboxes.organizationId, viewer.organizationId))
    .orderBy(desc(sandboxes.createdAt))

  const totalBytes = rows.reduce((sum, row) => sum + row.bytesUsed, 0)
  const liveCount = rows.filter((row) => row.status === "running").length

  return (
    <div className="space-y-10">
      <header>
        <p className="eyebrow">{viewer.organizationName}</p>
        <h1 className="tracking-display mt-3 text-3xl font-semibold">Sandboxes</h1>
        <p className="font-mono-tech mt-2 text-xs text-[var(--ink-faint)]">
          {liveCount} live · {(totalBytes / 1024 / 1024).toFixed(1)} MB in use
        </p>
      </header>

      {rows.length === 0 ? (
        <div className="rounded-[0.75rem] border border-line p-8 text-center text-sm text-[var(--ink-muted)]">
          No sandboxes yet. One is allocated when a run starts.
        </div>
      ) : (
        <ul className="flex flex-col gap-2">
          {rows.map((sandbox) => (
            <li
              key={sandbox.id}
              className="rounded-[0.75rem] border border-line bg-[var(--surface-raised)] px-4 py-3"
            >
              <div className="flex flex-wrap items-center gap-3">
                <Badge tone={sandboxTone(sandbox.status)}>{sandbox.status}</Badge>

                {sandbox.agentId && sandbox.agentName ? (
                  <Link
                    href={`/dashboard/agents/${sandbox.agentId}`}
                    className="text-sm transition-colors hover:text-signal"
                  >
                    {sandbox.agentName}
                  </Link>
                ) : (
                  <span className="text-sm text-[var(--ink-faint)]">unassigned</span>
                )}

                <span className="num ml-auto shrink-0 text-xs text-[var(--ink-faint)]">
                  {(sandbox.bytesUsed / 1024 / 1024).toFixed(1)} MB
                </span>
              </div>

              <div className="mt-2 flex flex-wrap items-center gap-3">
                {/* The runtime URL is the handle a developer needs to attach the
                    CLI to this box directly, which is the first thing anyone does
                    when a run misbehaves. */}
                {sandbox.runtimeUrl ? (
                  <a
                    href={sandbox.runtimeUrl}
                    className="font-mono-tech min-w-0 flex-1 truncate text-xs text-[var(--ink-muted)] transition-colors hover:text-signal"
                  >
                    {sandbox.runtimeUrl}
                  </a>
                ) : (
                  <span className="font-mono-tech min-w-0 flex-1 truncate text-xs text-[var(--ink-faint)]">
                    {sandbox.boatSandboxId}
                  </span>
                )}

                {sandbox.status === "running" ? (
                  <form action={destroySandboxAction}>
                    <input type="hidden" name="sandboxId" value={sandbox.id} />
                    <Button type="submit" variant="destructive" size="xs">
                      Destroy
                    </Button>
                  </form>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
