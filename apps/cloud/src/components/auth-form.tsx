"use client"

import { useRouter } from "next/navigation"
import { useState, type FormEvent } from "react"

import { Button } from "@/components/ui/button"
import { authClient } from "@/lib/auth-client"

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

    router.push("/")
    router.refresh()
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      {isSignUp ? (
        <div className="space-y-2">
          <label htmlFor="name" className="text-sm font-medium">
            Name
          </label>
          <input
            id="name"
            name="name"
            type="text"
            required
            autoComplete="name"
            className="flex h-9 w-full rounded-lg border bg-background px-3 py-1 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
          />
        </div>
      ) : null}

      <div className="space-y-2">
        <label htmlFor="email" className="text-sm font-medium">
          Email
        </label>
        <input
          id="email"
          name="email"
          type="email"
          required
          autoComplete="email"
          className="flex h-9 w-full rounded-lg border bg-background px-3 py-1 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
        />
      </div>

      <div className="space-y-2">
        <label htmlFor="password" className="text-sm font-medium">
          Password
        </label>
        <input
          id="password"
          name="password"
          type="password"
          required
          minLength={12}
          autoComplete={isSignUp ? "new-password" : "current-password"}
          className="flex h-9 w-full rounded-lg border bg-background px-3 py-1 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
        />
        {isSignUp ? (
          <p className="text-xs text-muted-foreground">At least 12 characters.</p>
        ) : null}
      </div>

      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}

      <Button type="submit" size="lg" className="w-full" disabled={pending}>
        {pending ? "Working…" : isSignUp ? "Create account" : "Sign in"}
      </Button>
    </form>
  )
}