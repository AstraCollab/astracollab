"use client"

import { useEffect, useState } from "react"

import { Mark } from "@/components/site-header"
import { SignIn } from "./sign-in"
import { authClient } from "@/lib/auth-client"
import {
  ContextPanel,
  KeysPanel,
  MemoryPanel,
  SelfModelPanel,
  TensionsPanel,
  type Overview
} from "./panels"

/**
 * The dashboard.
 *
 * Ordered by the order the questions get asked: what is my agent being told
 * (first, because that is the thing you cannot get from a log), what has it
 * learned, what is it bad at, what does it contradict, and only then the
 * credentials. Keys are last because they are a setup step, not a daily one.
 *
 * Everything reads through the session cookie. The agent API is key-only by
 * design, and reaching for a key to look at your own memory would train exactly
 * the habit the service is trying to discourage.
 */

const TABS = [
  { id: "context", label: "Context" },
  { id: "memory", label: "Memory" },
  { id: "self", label: "Self-model" },
  { id: "tensions", label: "Tensions" },
  { id: "keys", label: "Keys" }
] as const

type Tab = (typeof TABS)[number]["id"]

export function Dashboard() {
  const { data: session, isPending } = authClient.useSession()
  const [tab, setTab] = useState<Tab>("context")
  const [overview, setOverview] = useState<Overview | null>(null)
  const [loaded, setLoaded] = useState(false)

  // Fetched in the effect body and applied in the continuations, so no
  // synchronous setState happens during render.
  useEffect(() => {
    if (!session) return
    let cancelled = false
    void fetch("/api/dashboard/overview", { credentials: "include" })
      .then((response) => (response.ok ? response.json() : null))
      .then((body: Overview | null) => {
        if (cancelled || body === null) return
        setOverview(body)
        setLoaded(true)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [session])

  if (isPending) {
    return (
      <main className="mx-auto w-full max-w-5xl flex-1 px-6 py-16 text-sm text-zinc-600">
        Loading…
      </main>
    )
  }

  if (!session) return <SignIn />

  return (
    <div className="flex min-h-full flex-col">
      <header className="border-b border-white/[0.06]">
        <div className="mx-auto flex w-full max-w-5xl flex-wrap items-center justify-between gap-3 px-6 py-3.5">
          <div className="flex items-center gap-2.5">
            <Mark />
            <span className="text-[13px] font-medium">Cognitive Memory</span>
            <span className="text-zinc-700">/</span>
            <span className="font-mono text-[11px] text-zinc-600">
              {session.session.activeOrganizationId ?? "no organisation"}
            </span>
          </div>
          <button
            type="button"
            onClick={() => void authClient.signOut()}
            className="text-[12px] text-zinc-500 transition hover:text-zinc-200"
          >
            Sign out · {session.user.email}
          </button>
        </div>
      </header>

      <nav className="border-b border-white/[0.06]">
        <div className="mx-auto flex w-full max-w-5xl gap-1 px-6">
          {TABS.map((entry) => (
            <button
              key={entry.id}
              type="button"
              onClick={() => setTab(entry.id)}
              className={`-mb-px border-b-2 px-3 py-2.5 text-[13px] transition ${
                tab === entry.id
                  ? "border-violet-400 text-zinc-100"
                  : "border-transparent text-zinc-500 hover:text-zinc-200"
              }`}
            >
              {entry.label}
            </button>
          ))}
        </div>
      </nav>

      <main className="mx-auto w-full max-w-5xl flex-1 px-6 py-10">
        {!loaded ? (
          <p className="text-sm text-zinc-600">Loading your memory…</p>
        ) : overview === null ? (
          <NoOrganisation />
        ) : tab === "context" ? (
          <ContextPanel />
        ) : tab === "memory" ? (
          <MemoryPanel overview={overview} onChanged={() => window.location.reload()} />
        ) : tab === "self" ? (
          <SelfModelPanel overview={overview} />
        ) : tab === "tensions" ? (
          <TensionsPanel overview={overview} onChanged={() => window.location.reload()} />
        ) : (
          <KeysPanel />
        )}
      </main>
    </div>
  )
}

function NoOrganisation() {
  return (
    <div className="rounded-xl border border-white/[0.08] bg-white/[0.02] p-8 text-center">
      <h2 className="text-sm font-medium">No organisation selected</h2>
      <p className="mx-auto mt-2 max-w-md text-[13px] leading-6 text-zinc-500">
        A memory key belongs to an organisation, so there has to be one before
        there is anything to store.
      </p>
      <button
        type="button"
        onClick={async () => {
          await authClient.organization.create({
            name: "My organisation",
            slug: `org-${Date.now().toString(36)}`
          })
          window.location.reload()
        }}
        className="mt-5 rounded-lg bg-violet-500 px-3.5 py-2 text-[13px] font-medium text-white transition hover:bg-violet-400"
      >
        Create one
      </button>
    </div>
  )
}
