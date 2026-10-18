import Link from "next/link"
import { notFound } from "next/navigation"
import { and, asc, eq } from "drizzle-orm"

import { ChatThread } from "@/components/dashboard/chat-thread"
import { getDb } from "@/server/db/client"
import { agents, conversations, messages } from "@/server/db/schema"
import { requireOrganization } from "@/server/session"

export const metadata = {
  title: "Thread — Nah Cloud"
}

/**
 * One thread.
 *
 * The message list is read here and handed to the client component, which is the
 * mirror image of nah-studio's decision to hydrate from the store: the server
 * knows what was said, so the server renders it. That is what makes a refresh,
 * a second tab, or a shared URL show the same conversation.
 *
 * Scoped by `organizationId` on both the thread and the agent. Checking one
 * without the other is the gap a cross-tenant read would come through — a
 * conversation id is a uuid, and uuids from other tenants are guessable by
 * anyone who has ever seen one.
 */
export default async function ConversationPage({
  params
}: {
  readonly params: Promise<{ agentId: string; conversationId: string }>
}) {
  const viewer = await requireOrganization()
  const db = getDb()
  const { agentId, conversationId } = await params

  const [thread] = await db
    .select({
      id: conversations.id,
      title: conversations.title,
      agentId: agents.id,
      agentName: agents.name
    })
    .from(conversations)
    .innerJoin(agents, eq(conversations.agentId, agents.id))
    .where(
      and(
        eq(conversations.id, conversationId),
        eq(conversations.agentId, agentId),
        eq(conversations.organizationId, viewer.organizationId),
        eq(agents.organizationId, viewer.organizationId)
      )
    )
    .limit(1)

  if (!thread) notFound()

  // `sequence`, not `createdAt` — see the schema comment. A thread whose turns
  // render out of order is worse than one that fails to render.
  const rows = await db
    .select({
      id: messages.id,
      role: messages.role,
      content: messages.content,
      runId: messages.runId
    })
    .from(messages)
    .where(
      and(
        eq(messages.conversationId, thread.id),
        eq(messages.organizationId, viewer.organizationId)
      )
    )
    .orderBy(asc(messages.sequence))

  return (
    <div className="space-y-8">
      <header className="space-y-3">
        <Link
          href={`/dashboard/agents/${thread.agentId}/chat`}
          className="font-mono-tech text-xs text-[var(--ink-muted)] transition-colors hover:text-[var(--ink)]"
        >
          ← {thread.agentName} · chat
        </Link>
        <h1 className="tracking-display text-2xl font-semibold">{thread.title}</h1>
      </header>

      <ChatThread conversationId={thread.id} turns={rows} />
    </div>
  )
}
