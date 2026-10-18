"use client"

import { useRouter } from "next/navigation"

import { authClient } from "@/lib/auth-client"

/**
 * Sign out, from anywhere in the shell.
 *
 * A client component because it is the one control that has to talk to the auth
 * client; everything else in the dashboard is a server component reading the
 * session directly. Signing out and then `router.refresh()` is what drops the
 * server component's cached viewer — without it the shell keeps rendering the
 * signed-in nav for a beat.
 */
export function SignOutButton() {
  const router = useRouter()

  return (
    <button
      type="button"
      onClick={async () => {
        await authClient.signOut()
        router.push("/")
        router.refresh()
      }}
      className="rounded-[0.75rem] border border-line px-3 py-1.5 text-xs text-[var(--ink-muted)] transition-colors hover:border-line-strong hover:text-[var(--ink)]"
    >
      Sign out
    </button>
  )
}
