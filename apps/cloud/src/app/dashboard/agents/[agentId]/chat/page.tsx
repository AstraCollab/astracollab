import Link from "next/link"
import { notFound } from "next/navigation"
import { and, desc, eq } from "drizzle-orm"

import { createConversationAction } from "@/app/dashboard/actions"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { getDb } from "@/server/db/client"
import { agents, conversations } from "@/server/db/schema"
import { requireOrganization } from "@/server/session"

export const metadata = {
  title: "Chat — Nah Cloud"
}

/**
 * An agent's chat threads, and the button that starts one.
 *
 * Threads are listed rather than auto-created, because a chat that silently opens
 * a new conversation every time you visit the page turns into a wall of
 * "New conversation" with no way to tell which was which. You start one
 * deliberately; the title is derived from the first message once it exists.
 */
export default async function ChatIndexPage({
  params
}: {
  readonly params: Promise<{ agentId: string }>
}) {
  const viewer = await requireOrganization()
  const db = getDb()
  const { agentId } = await params

  const [agent] = await db
    .select({ id: agents.id, name: agents.name, instructions: agents.instructions })
    .from(agents)
    .where(and(eq(agents.id, agentId), eq(agents.organizationId, viewer.organizationId)))
    .limit(1)

  if (!agent) notFound()

  const threads = await db
    .select({ id: conversations.id, title: conversations.title, updatedAt: conversations.updatedAt })
    .from(conversations)
    .where(
      and(
        eq(conversations.agentId, agent.id),
        eq(conversations.organizationId, viewer.organizationId)
      )
    )
    .orderBy(desc(conversations.updatedAt))

  return (
    <div className="space-y-10">
      <header className="space-y-3">
        <Link
          href={`/dashboard/agents/${agent.id}`}
          className="font-mono-tech text-xs text-[var(--ink-muted)] transition-colors hover:text-[var(--ink)]"
        >
          ← {agent.name}
        </Link>
        <h1 className="tracking-display text-3xl font-semibold">Chat</h1>
        {/* The agent's own description, restated at the top of every thread. It
            is the context the agent carries, and showing it here means the user
            can see what the agent thinks it is for without going back. */}
        {agent.instructions ? (
          <p className="max-w-2xl text-sm text-[var(--ink-muted)]">{agent.instructions}</p>
        ) : null}
      </header>

      <section className="glass rounded-[0.75rem] p-6">
        <h2 className="text-lg font-medium">New conversation</h2>
        <form action={createConversationAction} className="mt-4">
          <input type="hidden" name="agentId" value={agent.id} />
          <Button
            type="submit"
            className="rounded-[0.75rem] border-signal bg-signal text-[#09090b] hover:bg-signal/90"
          >
            Start chatting
          </Button>
        </form>
      </section>

      <section>
        <h2 className="text-lg font-medium">Threads</h2>
        {threads.length === 0 ? (
          <p className="mt-4 text-sm text-[var(--ink-muted)]">
            No conversations yet.
          </p>
        ) : (
          <ul className="mt-4 flex flex-col gap-2">
            {threads.map((thread) => (
              <li key={thread.id}>
                <Link
                  href={`/dashboard/agents/${agent.id}/chat/${thread.id}`}
                  className="flex items-center gap-4 rounded-[0.75rem] border border-line bg-[var(--surface-raised)] px-4 py-3 transition-colors hover:border-line-strong"
                >
                  <span className="min-w-0 flex-1 truncate text-sm">{thread.title}</span>
                  <Badge tone="neutral">thread</Badge>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}
