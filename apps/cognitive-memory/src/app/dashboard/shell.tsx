"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"
import { createContext, useContext, useEffect, useState, type ReactNode } from "react"

import { Mark } from "@/components/site-header"
import { authClient } from "@/lib/auth-client"
import { SignIn } from "./sign-in"

/**
 * The dashboard frame.
 *
 * A session gate, an organisation switcher and a sidebar, wrapping every page.
 * The gate is client-side on purpose: the panels are interactive, so gating the
 * routes on a server-side session would make every keystroke in the context
 * preview a round trip. What the gate protects is still real — every page fetches
 * through `/api/dashboard/*`, which checks the session itself and answers 401.
 *
 * Ordered by the order the questions get asked: what is my agent being told, what
 * has it learned, what does it contradict, what is it bad at, what is that
 * costing, and only then the credentials. Keys are late because they are a setup
 * step, not a daily one.
 */

export interface DashboardSession {
  organizationId: string
  organizationName: string
  email: string
}

const SessionContext = createContext<DashboardSession | null>(null)

/** The signed-in organisation, for the pages that name it in a heading. */
export const useDashboardSession = (): DashboardSession | null => useContext(SessionContext)

const GROUPS: ReadonlyArray<{
  label: string
  entries: ReadonlyArray<{ href: string; label: string; hint: string }>
}> = [
  {
    label: "Watch",
    entries: [
      { href: "/dashboard", label: "Overview", hint: "what needs you" },
      { href: "/dashboard/context", label: "Context", hint: "the exact prompt" },
      { href: "/dashboard/activity", label: "Activity", hint: "what was injected" }
    ]
  },
  {
    label: "Memory",
    entries: [
      { href: "/dashboard/memory", label: "Library", hint: "search, edit, tier" },
      { href: "/dashboard/tensions", label: "Tensions", hint: "contradictions" },
      { href: "/dashboard/self-model", label: "Self-model", hint: "reliability" }
    ]
  },
  {
    label: "Cost",
    entries: [{ href: "/dashboard/analytics", label: "Analytics", hint: "tokens per turn" }]
  },
  {
    label: "Connect",
    entries: [
      { href: "/dashboard/start", label: "Get started", hint: "SDK and curl" },
      { href: "/dashboard/keys", label: "Keys", hint: "credentials" }
    ]
  },
  {
    label: "Account",
    entries: [{ href: "/dashboard/settings", label: "Settings", hint: "budgets, danger zone" }]
  }
]

export function DashboardFrame({ children }: { children: ReactNode }) {
  const { data: session, isPending } = authClient.useSession()
  const { data: organizations, isPending: orgsPending } = authClient.useListOrganizations()
  const pathname = usePathname()

  const activeId = session?.session.activeOrganizationId ?? null
  const hasOrganisation = (organizations?.length ?? 0) > 0

  /**
   * A valid session can still have no *active* organisation.
   *
   * Selecting one is a session flag, so it does not survive a fresh sign-in on a
   * new browser — and every route under here resolves its tenant from that flag.
   * Without this, signing in on a second device lands on a dashboard where every
   * request answers 403 and the pages show error text. Picking the first
   * organisation is the least surprising answer: the account has one, so the
   * dashboard should show it.
   */
  useEffect(() => {
    if (!session || activeId !== null) return
    const first = organizations?.[0]
    if (!first) return
    let cancelled = false
    void authClient.organization
      .setActive({ organizationId: first.id })
      .then(() => {
        if (!cancelled) window.location.reload()
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [session, activeId, organizations])

  if (isPending) {
    return (
      <main className="mx-auto w-full max-w-5xl flex-1 px-6 py-16 text-sm text-zinc-600">
        Loading…
      </main>
    )
  }

  if (!session) return <SignIn />

  const activeName =
    organizations?.find((organization) => organization.id === activeId)?.name ?? activeId ?? null

  return (
    <SessionContext.Provider
      value={{
        organizationId: activeId ?? "",
        organizationName: activeName ?? "",
        email: session.user.email
      }}
    >
      <div className="flex min-h-full flex-col">
        <header className="sticky top-0 z-20 border-b border-white/[0.06] bg-[#08080b]/85 backdrop-blur">
          <div className="mx-auto flex w-full max-w-6xl flex-wrap items-center justify-between gap-3 px-6 py-3">
            <div className="flex min-w-0 items-center gap-2.5">
              <Link href="/" className="flex items-center gap-2.5">
                <Mark />
                <span className="text-[13px] font-medium">Cognitive Memory</span>
              </Link>
              {activeId !== null ? (
                <OrganizationSwitcher
                  activeId={activeId}
                  organizations={(organizations ?? []).map((organization) => ({
                    id: organization.id,
                    name: organization.name
                  }))}
                />
              ) : null}
            </div>
            <button
              type="button"
              onClick={() => void authClient.signOut()}
              className="shrink-0 text-[12px] text-zinc-500 transition hover:text-zinc-200"
            >
              Sign out · {session.user.email}
            </button>
          </div>
        </header>

        <div className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-6 px-6 py-6 lg:flex-row lg:gap-10">
          <nav className="-mx-1 shrink-0 lg:w-44">
            {/* A wrapping row of links on a phone, a sidebar on a desk. Same list. */}
            <ul className="flex gap-1 overflow-x-auto pb-1 lg:flex-col lg:gap-6 lg:overflow-visible lg:pb-0">
              {GROUPS.map((group) => (
                <li key={group.label} className="shrink-0 lg:shrink">
                  <p className={`${"px-3 pt-2"} font-mono text-[9px] uppercase tracking-widest text-zinc-700 lg:px-0 lg:pb-1.5`}>
                    {group.label}
                  </p>
                  <ul className="flex gap-0.5 lg:flex-col lg:gap-0.5">
                    {group.entries.map((entry) => {
                      const current =
                        entry.href === "/dashboard" ? pathname === "/dashboard" : pathname.startsWith(entry.href)
                      return (
                        <li key={entry.href}>
                          <Link
                            href={entry.href}
                            title={entry.hint}
                            className={`block whitespace-nowrap rounded-md px-3 py-1.5 text-[13px] transition ${
                              current
                                ? "bg-white/[0.06] text-zinc-100"
                                : "text-zinc-500 hover:bg-white/[0.03] hover:text-zinc-200"
                            }`}
                          >
                            {entry.label}
                          </Link>
                        </li>
                      )
                    })}
                  </ul>
                </li>
              ))}
            </ul>
          </nav>

          <main className="min-w-0 flex-1 space-y-6 pb-12">
            {/* An account with no organisation has nothing to show, and every
                page below would answer 403. Offering the one missing step beats
                rendering ten pages of error text. */}
            {!orgsPending && activeId === null ? (
              hasOrganisation ? (
                <p className="text-[13px] text-zinc-600">Opening your organisation…</p>
              ) : (
                <NoOrganisation email={session.user.email} />
              )
            ) : (
              children
            )}
          </main>
        </div>
      </div>
    </SessionContext.Provider>
  )
}

/**
 * Which organisation's memory you are looking at.
 *
 * A `<select>` rather than a menu because the list is short, keyboard-accessible
 * for free, and the value matters more than the interaction: switching is a
 * decision made while looking at something that is already open.
 */
function OrganizationSwitcher({
  activeId,
  organizations
}: {
  activeId: string
  organizations: ReadonlyArray<{ id: string; name: string }>
}) {
  return (
    <span className="flex items-center gap-1.5">
      <span className="text-zinc-700">/</span>
      <select
        value={activeId}
        onChange={(event) => {
          void authClient.organization.setActive({ organizationId: event.target.value })
        }}
        className="max-w-[10rem] truncate rounded-md border border-white/[0.08] bg-white/[0.03] px-1.5 py-1 text-[12px] text-zinc-300 outline-none transition hover:border-white/20 focus:border-violet-400/50"
      >
        {organizations.map((organization) => (
          <option key={organization.id} value={organization.id} className="bg-[#0e0e13]">
            {organization.name}
          </option>
        ))}
      </select>
    </span>
  )
}

/** The one thing an account cannot do without: an organisation to own memory. */
function NoOrganisation({ email }: { email: string }) {
  const [busy, setBusy] = useState(false)
  const slug = (email.split("@")[0] ?? "org").replace(/[^a-z0-9]+/gi, "-").toLowerCase()

  return (
    <div className="rounded-xl border border-white/[0.08] bg-white/[0.02] p-8 text-center">
      <h2 className="text-sm font-medium">No organisation yet</h2>
      <p className="mx-auto mt-2 max-w-md text-[13px] leading-6 text-zinc-500">
        A memory key belongs to an organisation, so there has to be one before there is
        anything to store. Create one and the dashboard opens on it.
      </p>
      <button
        type="button"
        disabled={busy}
        onClick={async () => {
          setBusy(true)
          await authClient.organization.create({
            name: "My organisation",
            slug: `${slug}-${Date.now().toString(36)}`
          })
          window.location.reload()
        }}
        className="mt-5 rounded-lg bg-violet-500 px-3.5 py-2 text-[13px] font-medium text-white transition hover:bg-violet-400 disabled:opacity-50"
      >
        {busy ? "Creating…" : "Create one"}
      </button>
    </div>
  )
}