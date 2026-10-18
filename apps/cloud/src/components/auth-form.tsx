"use client"

import { useRouter } from "next/navigation"
import { useState, type FormEvent } from "react"

import { Button } from "@/components/ui/button"
import { authClient } from "@/lib/auth-client"
import { GitBranch } from "lucide-react"

/**
 * One form for both sign-in and sign-up.
 *
 * They differ by a single field and a single endpoint, and splitting them would
 * duplicate the error handling — which is the part that actually matters, since
 * Better Auth reports a wrong email and a wrong password identically and the UI
 * must not imply which one it was.
 *
 * The mode is a prop rather than a route, so switching between them cannot lose a
 * half-typed email.
 */
export function AuthForm({ mode }: { readonly mode: "sign-in" | "sign-up" }) {
  const router = useRouter()
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)

  const isSignUp = mode === "sign-up"

  const onSubmit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    setError(null)
    setPending(true)

    const data = new FormData(event.currentTarget)
    const email = String(data.get("email") ?? "")
    const password = String(data.get("password") ?? "")
    const name = String(data.get("name") ?? "")

    const result = isSignUp
      ? await authClient.signUp.email({ email, password, name })
      : await authClient.signIn.email({ email, password })

    setPending(false)

    if (result.error) {
      // The server's message is already safe to show and is deliberately vague
      // about *which* credential was wrong; passing it through keeps this form
      // from inventing a more informative-sounding error than auth actually has.
      setError(result.error.message ?? "Something went wrong. Try again.")
      return
    }

    // `/dashboard`, not `/`: the landing page is the marketing surface and is
    // what a signed-out visitor should see. Someone who has just authenticated
    // wants their workspace. The dashboard layout takes it from here — a viewer
    // with no organisation is routed onward to onboarding from there.
    router.replace("/dashboard")
    router.refresh()
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      {isSignUp ? (
        <div className="space-y-2">
          <label htmlFor="name" className="eyebrow block">
            Name
          </label>
          <input
            id="name"
            name="name"
            type="text"
            required
            autoComplete="name"
            className="flex h-9 w-full rounded-[0.75rem] border border-line bg-[var(--surface-inset)] px-3 py-1 text-sm text-[var(--ink)] shadow-xs outline-none transition-colors placeholder:text-[var(--ink-faint)] focus-visible:border-signal"
          />
        </div>
      ) : null}

      <div className="space-y-2">
        <label htmlFor="email" className="eyebrow block">
          Email
        </label>
        <input
          id="email"
          name="email"
          type="email"
          required
          autoComplete="email"
          className="flex h-9 w-full rounded-[0.75rem] border border-line bg-[var(--surface-inset)] px-3 py-1 text-sm text-[var(--ink)] shadow-xs outline-none transition-colors placeholder:text-[var(--ink-faint)] focus-visible:border-signal"
        />
      </div>

      <div className="space-y-2">
        <label htmlFor="password" className="eyebrow block">
          Password
        </label>
        <input
          id="password"
          name="password"
          type="password"
          required
          minLength={12}
          autoComplete={isSignUp ? "new-password" : "current-password"}
          className="flex h-9 w-full rounded-[0.75rem] border border-line bg-[var(--surface-inset)] px-3 py-1 text-sm text-[var(--ink)] shadow-xs outline-none transition-colors placeholder:text-[var(--ink-faint)] focus-visible:border-signal"
        />
        {isSignUp ? (
          <p className="font-mono-tech text-xs text-[var(--ink-faint)]">
            At least 12 characters.
          </p>
        ) : null}
      </div>

      {error ? (
        <p
          role="alert"
          className="rounded-[0.75rem] border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
        >
          {error}
        </p>
      ) : null}

      <Button
        type="submit"
        size="lg"
        className="w-full rounded-[0.75rem] border-signal bg-signal text-[#09090b] hover:bg-signal/90"
        disabled={pending}
      >
        {pending ? "Working…" : isSignUp ? "Create account" : "Sign in"}
      </Button>

      <div className="relative my-6">
        <div className="absolute inset-0 flex items-center">
          <div className="w-full border-t border-line-strong/50" />
        </div>
        <div className="relative flex justify-center text-xs uppercase">
          <span className="bg-[var(--surface-inset)] px-2 text-[var(--ink-muted)]">
            Or continue with
          </span>
        </div>
      </div>

      <Button
        type="button"
        variant="outline"
        onClick={() => authClient.signIn.social({ provider: "github", callbackURL: "/dashboard" })}
        className="w-full flex items-center justify-center gap-2 rounded-[0.75rem]"
      >
        <GitBranch className="h-4 w-4" />
        Sign in with GitHub
      </Button>
    </form>
  )
}