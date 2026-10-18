import { asc, desc, eq } from "drizzle-orm"
import { headers } from "next/headers"
import { redirect } from "next/navigation"
import { cache } from "react"

import { getAuth } from "./auth/better-auth"
import { member, organization } from "./db/auth-tables"
import { getDb } from "./db/client"

/**
 * Who is asking.
 *
 * Every page and every server action resolves its tenancy through this one
 * function, and that is the point. A dashboard that read `organizationId` from a
 * query string in one place and from the session in another is a dashboard where
 * "which org owns this agent" has two answers; the tenancy seam has to be one
 * line that cannot be bypassed.
 *
 * `cache`d per request. A dashboard page touches this from its layout, its header
 * and its data queries, and `getSession` verifies a session cookie against the
 * database. Without the memo, one page view is four identical session reads.
 */

/** A signed-in user, and the organisation they are currently acting as. */
export interface Viewer {
  readonly userId: string
  readonly email: string
  readonly name: string
  /**
   * `null` until they belong to one.
   *
   * Not an error case. Signing up creates a person, and a person does not become
   * billable until they have somewhere to hang agents, so the dashboard routes
   * here into onboarding instead of showing an empty shell.
   */
  readonly organizationId: string | null
  readonly organizationName: string | null
  readonly role: string | null
}

/** An organisation, as the org listing reports it. */
export interface OrganizationSummary {
  readonly id: string
  readonly name: string
}

/**
 * The organisations this user belongs to.
 *
 * Better Auth's `getActiveMember` hands back a `organizationId` and a role but
 * not the organisation's name, so the name comes from the listing. Both calls are
 * wrapped: a user who belongs to no organisation makes the plugin throw or return
 * null depending on its version, and neither is worth a 500 on a first dashboard
 * load after sign-up.
 */
const fetchOrganizations = cache(async (): Promise<readonly OrganizationSummary[]> => {
  try {
    const result = (await getAuth().api.listOrganizations({
      headers: await headers()
    })) as unknown as { organizations?: { id: string; name: string }[] }

    return result.organizations ?? []
  } catch {
    return []
  }
})

/**
 * The organisation to act as when this session has none active.
 *
 * A session only carries an `activeOrganizationId` once someone explicitly picks
 * one, and Better Auth sets it on just the session that created the org. Every
 * other session — a second browser, a laptop that already had the account — has
 * it null, which is the common case rather than an edge case. So without this,
 * someone who already owns an organisation is told to create another one.
 *
 * The only org if there is one, otherwise the most recently created. Both are
 * deterministic, and that is what lets two tabs agree without persisting
 * anything: a tie on `createdAt` breaks on `id`, so the same request always
 * resolves the same way.
 *
 * Read from the membership rather than through `getActiveMember` because that
 * endpoint takes no organisation override — it reads `session.activeOrganizationId`
 * and nothing else, which is precisely the value missing here. The join is for the
 * role: `listOrganizations` returns organisation rows with no membership attached,
 * so reusing it would leave the role unknown and the API keys page, which gates on
 * `owner`/`admin`, would hide itself from its own owner.
 *
 * Deliberately not persisted. Making the choice durable means writing the active
 * organisation to the session cookie, and a Server Component cannot set cookies.
 * It becomes durable the moment an organisation switcher calls
 * `setActiveOrganization` from a server action.
 */
const resolveDefaultOrganization = async (
  userId: string
): Promise<{ readonly organizationId: string; readonly role: string } | null> => {
  const [row] = await getDb()
    .select({ organizationId: member.organizationId, role: member.role })
    .from(member)
    .innerJoin(organization, eq(member.organizationId, organization.id))
    .where(eq(member.userId, userId))
    .orderBy(desc(organization.createdAt), asc(organization.id))
    .limit(1)

  return row ?? null
}

/** The session, or `null`. Never throws, never redirects. */
export const getViewer = cache(async (): Promise<Viewer | null> => {
  const auth = getAuth()
  const requestHeaders = await headers()

  const session = await auth.api.getSession({ headers: requestHeaders })
  if (!session) return null

  const user = session.user as { id: string; email: string; name: string }

  let organizationId: string | null = null
  let role: string | null = null

  try {
    // The *active* organisation, not the first one. Better Auth tracks it
    // server-side, so two tabs of the dashboard cannot disagree about which org
    // they are looking at.
    const activeMember = (await auth.api.getActiveMember({
      headers: requestHeaders
    })) as unknown as { organizationId: string; role: string } | null

    if (activeMember) {
      organizationId = activeMember.organizationId
      role = activeMember.role
    }
  } catch {
    organizationId = null
    role = null
  }

  // This session never selected an org, but the user belongs to at least one.
  // Resolving it here is what keeps "I already own an org" from routing to a
  // page offering to create one. `getActiveMember` throws rather than returning
  // null for this case, which is why it is reached from both the catch and the
  // empty-result path.
  if (!organizationId) {
    const fallback = await resolveDefaultOrganization(user.id)
    if (fallback) {
      organizationId = fallback.organizationId
      role = fallback.role
    }
  }

  const organizations = await fetchOrganizations()
  const organizationName =
    organizations.find((organization) => organization.id === organizationId)?.name ?? null

  return {
    userId: user.id,
    email: user.email,
    name: user.name,
    organizationId,
    organizationName,
    role
  }
})

/** The signed-in user, or a redirect to sign-in. */
export const requireViewer = async (): Promise<Viewer> => {
  const viewer = await getViewer()
  if (!viewer) redirect("/sign-in")
  return viewer
}

/**
 * The signed-in user *with* an organisation, or a redirect to onboarding.
 *
 * Every data page in the dashboard goes through this rather than
 * `requireViewer`, because the two failure modes are different and the user
 * should never see "sign in" when what they need is "make an organisation".
 */
export const requireOrganization = async (): Promise<Viewer & { organizationId: string }> => {
  const viewer = await requireViewer()
  if (!viewer.organizationId) redirect("/dashboard/onboarding")
  return viewer as Viewer & { organizationId: string }
}

/** Every organisation this user belongs to, for the switcher. */
export const listViewerOrganizations = fetchOrganizations
