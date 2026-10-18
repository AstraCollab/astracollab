import { redirect } from "next/navigation"

import { DashboardNav } from "@/components/dashboard/nav"
import { getViewer } from "@/server/session"

export const dynamic = "force-dynamic"

/**
 * The dashboard shell.
 *
 * `getViewer`, not `requireOrganization`: the shell has to render for someone who
 * has signed up but not yet made an organisation, and that is the onboarding
 * route's whole reason to exist. Requiring an org here would bounce them into a
 * loop with nowhere to go.
 *
 * `.app` carries the theme token remap, so every shadcn primitive inside the
 * dashboard renders in the shared palette without a per-page override.
 *
 * `force-dynamic` is load-bearing and not a performance setting. The shell reads
 * a session cookie and the database, so its output belongs to one request; if
 * Next prerenders it, it renders with no session and either throws or bakes an
 * empty dashboard into a static artefact. The session read goes through React's
 * `cache` (see `session.ts`), which hides the `headers()` call from static
 * analysis, so without this the routes look prerenderable and get built wrong.
 * Everything under `/dashboard` inherits it.
 */
export default async function DashboardLayout({
  children
}: {
  readonly children: React.ReactNode
}) {
  const viewer = await getViewer()

  // No session: send them to sign in. Redirected from the layout so no individual
  // page has to remember to check.
  if (!viewer) redirect("/sign-in")

  return (
    <div className="app grain relative min-h-screen">
      <div className="landing-grid pointer-events-none absolute inset-0" aria-hidden="true" />
      <div
        className="glow -top-40 left-1/3 size-[36rem] bg-[#a78bfa]/10"
        aria-hidden="true"
      />

      <div className="relative mx-auto flex w-full max-w-6xl flex-col gap-10 px-6 py-10 lg:flex-row">
        <DashboardNav
          viewerEmail={viewer.email}
          organizationName={viewer.organizationName}
        />
        <main className="min-w-0 flex-1">{children}</main>
      </div>
    </div>
  )
}
