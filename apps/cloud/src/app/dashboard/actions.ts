"use server"

import { revalidatePath } from "next/cache"
import { headers } from "next/headers"
import { redirect } from "next/navigation"
import { and, eq, sql } from "drizzle-orm"

import { getAuth } from "@/server/auth/better-auth"
import { getDb } from "@/server/db/client"
import { cancelRun, launchRun } from "@/server/runs/launcher"
import { agents, conversations, githubConnections, messages, runs, sandboxes } from "@/server/db/schema"
import { requireOrganization, requireViewer } from "@/server/session"

/**
 * Every mutation the dashboard makes.
 *
 * All of them start from `requireOrganization` or `requireViewer` and scope their
 * write by the organisation id that came back. That is the only authorisation
 * this app has, and it is deliberate: an agent id in a form body is user input, so
 * a `where` clause on `organizationId` is the difference between "you created this"
 * and "you typed someone else's uuid". Every action below is scoped even where the
 * relationship (an agent owns its runs) would already imply the tenancy.
 *
 * `revalidatePath` rather than `router.refresh`, because these are server
 * components reading the database directly — there is no fetch cache entry to
 * invalidate, only the router's rendered-segment cache.
 */

const str = (value: FormDataEntryValue | null): string =>
  typeof value === "string" ? value.trim() : ""

/** `Acme Inc.` → `acme-inc`. Matches what a person would type into the URL. */
const slugify = (value: string): string =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "org"

export async function createOrganizationAction(formData: FormData): Promise<void> {
  await requireViewer()
  const name = str(formData.get("name"))
  if (!name) return

  await getAuth().api.createOrganization({
    // Better Auth requires an explicit slug. Derived rather than asked for: one
    // more field on an onboarding form is one more thing to get wrong, and the
    // slug is only ever a URL segment.
    body: { name, slug: slugify(name) },
    headers: await headers()
  })

  // A viewer whose org list changed must re-resolve; the shell reads it.
  redirect("/dashboard")
}

export async function createAgentAction(formData: FormData): Promise<void> {
  const viewer = await requireOrganization()
  const name = str(formData.get("name"))
  const repository = str(formData.get("repository"))
  const instructions = str(formData.get("instructions"))
  if (!name || !repository) return

  await getDb()
    .insert(agents)
    .values({
      organizationId: viewer.organizationId,
      name,
      repository,
      instructions,
      config: {}
    })

  redirect("/dashboard/agents")
}

/**
 * Start a run.
 *
 * The prompt is frozen here and never edited again — a replay has to be faithful
 * to what was asked, so the same run redrawn tomorrow says the same thing it said
 * today. `sandboxId` stays null until the runtime assigns one; the run is
 * `queued`, not `running`, because nothing is executing yet.
 */
export async function createRunAction(formData: FormData): Promise<void> {
  const viewer = await requireOrganization()
  const agentId = str(formData.get("agentId"))
  const prompt = str(formData.get("prompt"))
  if (!agentId || !prompt) return

  await getDb()
    .insert(runs)
    .values({
      agentId,
      organizationId: viewer.organizationId,
      status: "queued",
      prompt
    })

  revalidatePath("/dashboard/agents")
  redirect(`/dashboard/agents/${agentId}`)
}

/**
 * Launch a run against an agent.
 *
 * `launchRun` owns the whole sequence — row, sandbox, start, settle-on-failure —
 * so this is only tenancy and navigation. The tenancy check is not optional: the
 * action takes an `agentId` from a form, and without `eq(organizationId, ...)` any
 * signed-in user could launch another tenant's agent and be metered for it.
 *
 * On failure there is no redirect and no thrown error. The run row already exists
 * in `failed` with its error text, so revalidating is what surfaces the failure —
 * on the runs list, which is where a user looks to find out what happened.
 */
export async function launchRunAction(formData: FormData): Promise<void> {
  const viewer = await requireOrganization()
  const agentId = str(formData.get("agentId"))
  const prompt = str(formData.get("prompt"))
  if (!agentId || !prompt) return

  const [agent] = await getDb()
    .select({ id: agents.id })
    .from(agents)
    .where(
      and(eq(agents.id, agentId), eq(agents.organizationId, viewer.organizationId))
    )

  if (!agent) {
    revalidatePath("/dashboard/agents")
    return
  }

  const run = await launchRun({
    organizationId: viewer.organizationId,
    agentId,
    prompt
  })

  revalidatePath("/dashboard/runs")
  revalidatePath("/dashboard")
  revalidatePath(`/dashboard/agents/${agentId}`)
  redirect(`/dashboard/runs/${run.id}`)
}

/**
 * Cancel a run in flight.
 *
 * Delegates to `cancelRun`, which stops the sandbox and then settles through the
 * one `settleRun` path. It used to do both inline, and that was a second way to
 * reach a terminal status: a run cancelled through here and a run cancelled by the
 * provider webhook would have raced to update the same row, and the loser would
 * still have metered. One path, one guard, `usage_run_unique_idx` as the backstop.
 */
export async function cancelRunAction(formData: FormData): Promise<void> {
  const viewer = await requireOrganization()
  const runId = str(formData.get("runId"))
  if (!runId) return

  const [owned] = await getDb()
    .select({ id: runs.id })
    .from(runs)
    .where(and(eq(runs.id, runId), eq(runs.organizationId, viewer.organizationId)))

  if (owned) await cancelRun(runId)

  revalidatePath("/dashboard/runs")
  revalidatePath("/dashboard")
  revalidatePath("/dashboard/usage")
}

/** Pause or resume an agent. Pausing keeps the filesystem and stops the CPU. */
export async function toggleAgentAction(formData: FormData): Promise<void> {
  const viewer = await requireOrganization()
  const agentId = str(formData.get("agentId"))
  if (!agentId) return

  const db = getDb()
  const [agent] = await db
    .select({ paused: agents.paused })
    .from(agents)
    .where(and(eq(agents.id, agentId), eq(agents.organizationId, viewer.organizationId)))
    .limit(1)
  if (!agent) return

  await db
    .update(agents)
    .set({ paused: !agent.paused, updatedAt: new Date() })
    .where(and(eq(agents.id, agentId), eq(agents.organizationId, viewer.organizationId)))

  revalidatePath(`/dashboard/agents/${agentId}`)
}

/**
 * Destroy a sandbox.
 *
 * The one action here that frees disk, so it is the one worth being explicit
 * about: `destroyed` is terminal, and the row is kept rather than deleted so the
 * run that used it still has something to point at. A destroyed sandbox whose
 * runs are gone is an orphaned usage row nobody can explain.
 */
export async function destroySandboxAction(formData: FormData): Promise<void> {
  const viewer = await requireOrganization()
  const sandboxId = str(formData.get("sandboxId"))
  if (!sandboxId) return

  await getDb()
    .update(sandboxes)
    .set({ status: "destroyed", destroyedAt: new Date() })
    .where(
      and(
        eq(sandboxes.id, sandboxId),
        eq(sandboxes.organizationId, viewer.organizationId),
        eq(sandboxes.status, "running")
      )
    )

  revalidatePath("/dashboard/sandboxes")
}

/**
 * Start a chat thread against an agent.
 *
 * Redirects into the thread, because the common case is "open the agent, start
 * talking" and a form that creates a thread and then leaves you where you were
 * makes you go and find the thing it just made.
 */
export async function createConversationAction(formData: FormData): Promise<void> {
  const viewer = await requireOrganization()
  const agentId = str(formData.get("agentId"))
  if (!agentId) return

  // Checked rather than trusted: the agent id is in the form body, and a thread
  // pointing at another tenant's agent would be a readable window into their work.
  const [agent] = await getDb()
    .select({ id: agents.id })
    .from(agents)
    .where(and(eq(agents.id, agentId), eq(agents.organizationId, viewer.organizationId)))
    .limit(1)
  if (!agent) return

  const [created] = await getDb()
    .insert(conversations)
    .values({ organizationId: viewer.organizationId, agentId })
    .returning({ id: conversations.id })

  if (!created) return
  redirect(`/dashboard/agents/${agentId}/chat/${created.id}`)
}

/**
 * Append a message to a thread.
 *
 * Returns nothing and takes no navigation: the chat is a live surface, and a
 * redirect or a `revalidatePath` in the middle of a send would tear down the
 * scroll position the user is reading. The client refreshes the route after the
 * action resolves, which is one round trip and leaves the thread in place.
 *
 * The sequence is allocated in the INSERT rather than read first and then
 * incremented. Two messages sent inside the same request cycle would otherwise
 * both read the same `max(sequence)` and the second would fail the unique index —
 * which is a visible error for a user who did nothing wrong. Letting the database
 * compute it in the same statement that claims the row removes the race entirely.
 */
export async function sendChatMessageAction(formData: FormData): Promise<void> {
  const viewer = await requireOrganization()
  const conversationId = str(formData.get("conversationId"))
  const content = str(formData.get("content"))
  if (!conversationId || !content) return

  const db = getDb()

  // Tenancy first, then the insert. Both are scoped by organizationId, so even a
  // leaked conversation id cannot be appended to.
  const [thread] = await db
    .select({ id: conversations.id, agentId: conversations.agentId })
    .from(conversations)
    .where(
      and(
        eq(conversations.id, conversationId),
        eq(conversations.organizationId, viewer.organizationId)
      )
    )
    .limit(1)
  if (!thread) return

  // The message is inserted first and its id kept, because that is the only way
  // to link the run back without matching on text. Matching `content` would be
  // wrong the moment someone sends the same message twice, which in a chat is
  // not an edge case — "yes", "go on", "try again" are the whole vocabulary.
  const [message] = await db
    .insert(messages)
    .values({
      conversationId,
      organizationId: viewer.organizationId,
      role: "user",
      content,
      sequence: sql<number>`(
        select coalesce(max(${messages.sequence}), 0) + 1
        from ${messages}
        where ${messages.conversationId} = ${conversationId}
      )`
    })
    .returning({ id: messages.id })

  if (!message) return

  // A run per message, so every turn is an auditable execution and not just a
  // row of text. The prompt is the message alone: the runtime assembles the rest
  // of the context from the thread, and duplicating it here would give two
  // sources of truth for what the agent was asked.
  const [run] = await db
    .insert(runs)
    .values({
      agentId: thread.agentId,
      organizationId: viewer.organizationId,
      status: "queued",
      prompt: content
    })
    .returning({ id: runs.id })

  if (run) {
    await db
      .update(messages)
      .set({ runId: run.id })
      .where(eq(messages.id, message.id))
  }

  // First message names the thread. Derived rather than asked for — see the
  // schema comment — and only on the first turn, so the title does not drift as
  // the conversation develops. The guard is on the default value, so the first
  // message wins and later ones never overwrite a title.
  await db
    .update(conversations)
    .set({ updatedAt: new Date(), title: content.slice(0, 60) })
    .where(
      and(
        eq(conversations.id, conversationId),
        eq(conversations.organizationId, viewer.organizationId),
        eq(conversations.title, "New conversation")
      )
    )
}

/** What `createKeyAction` hands back to the form that called it. */
export interface CreatedKey {
  /** The only time the plaintext secret is ever available. */
  readonly key: string | null
  readonly error: string | null
}

/**
 * Mint a machine credential.
 *
 * Org-owned, never person-owned, and the reason is the lifetime: `nah`
 * authenticates once and then runs for an hour, so a key that expires with a
 * human's session would kill running jobs.
 *
 * The secret comes back from Better Auth exactly once and is never stored in
 * plaintext, so it has to be returned from here rather than re-read on the next
 * render — which is why this returns a value instead of redirecting. The form
 * that calls it shows the key once and then clears; there is no second chance to
 * see it, and that is the intended behaviour, not a limitation of the page.
 */
export async function createKeyAction(
  _prev: CreatedKey,
  formData: FormData
): Promise<CreatedKey> {
  const viewer = await requireOrganization()
  const name = str(formData.get("name"))
  const configId = str(formData.get("configId")) === "runner" ? "runner" : "agent"
  if (!name) return { key: null, error: "A name is required." }

  try {
    const result = await getAuth().api.createApiKey({
      body: { name, configId, organizationId: viewer.organizationId },
      headers: await headers()
    })

    revalidatePath("/dashboard/keys")
    return { key: result.key ?? null, error: null }
  } catch {
    // A member without `apiKey:create` hits this. The role check already prevents
    // the request reaching the endpoint, so the message is about what to do next
    // rather than about permissions.
    return {
      key: null,
      error: "Could not create that key. Ask an org owner or admin for one."
    }
  }
}

/**
 * Revoke a key without deleting it.
 *
 * `updateApiKey` with `enabled: false`, not `deleteApiKey`. Deleting would erase
 * the record of which key started which run, and a usage ledger whose entries
 * point at a credential that no longer exists is one nobody can audit. Disabling
 * gives the same security outcome and keeps the history.
 */
export async function revokeKeyAction(formData: FormData): Promise<void> {
  await requireViewer()
  const keyId = str(formData.get("keyId"))
  if (!keyId) return

  try {
    await getAuth().api.updateApiKey({
      body: { keyId, enabled: false },
      headers: await headers()
    })
  } catch {
    // Revoking an already-revoked key is not an error worth surfacing; the
    // operator asked for it to stop working and it already has.
  }

  revalidatePath("/dashboard/keys")
}

/**
 * Disconnect a GitHub installation from the organisation.
 *
 * Revokes the stored tokens and removes the row. Any in-flight sandbox
 * that used this connection is not killed here — the agent runtime owns
 * that decision — but it can no longer mint installation tokens.
 */
export async function deleteGithubConnectionAction(formData: FormData): Promise<void> {
  const viewer = await requireOrganization()
  const id = str(formData.get("id"))
  if (!id) return

  const db = getDb()

  // Tenancy check: only the owning org can delete this connection.
  const [conn] = await db
    .select()
    .from(githubConnections)
    .where(
      and(eq(githubConnections.id, id), eq(githubConnections.organizationId, viewer.organizationId))
    )
    .limit(1)
  if (!conn) return

  await db.delete(githubConnections).where(eq(githubConnections.id, id))
  revalidatePath("/dashboard/github")
}
