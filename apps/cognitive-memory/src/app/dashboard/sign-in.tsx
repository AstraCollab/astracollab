"use client"

import { useState } from "react"

import { authClient } from "@/lib/auth-client"

/**
 * Sign in or sign up.
 *
 * One form rather than two screens: a returning user types a password, a new one
 * types a name, and the same button does the right thing either way. Passwords
 * are 12 characters minimum server-side, which is why the hint is on the form.
 */
export function SignIn() {
  const { data: session } = authClient.useSession()
  const [mode, setMode] = useState<"sign-in" | "sign-up">("sign-in")
  const [name, setName] = useState("")
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  if (session) {
    return (
      <main className="mx-auto flex w-full max-w-sm flex-1 flex-col justify-center gap-6 px-6 py-16">
        <div className="space-y-4 text-center">
          <p className="text-sm text-zinc-400">
            Signed in as <span className="text-zinc-200">{session.user.email}</span>.
          </p>
          <button
            type="button"
            onClick={() => void authClient.signOut()}
            className="rounded-lg border border-white/10 px-3.5 py-2 text-xs text-zinc-400 transition hover:border-white/20 hover:text-zinc-200"
          >
            Sign out
          </button>
        </div>
      </main>
    )
  }

  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    setError(null)
    setBusy(true)
    const result =
      mode === "sign-up"
        ? await authClient.signUp.email({ name, email, password })
        : await authClient.signIn.email({ email, password })
    setBusy(false)
    if (result.error) {
      setError(result.error.message ?? "That did not work.")
      return
    }
    // A new account has no organisation yet, so make one and select it. Without
    // this the dashboard would land on an empty screen with no way forward.
    if (mode === "sign-up") {
      const slug = email.split("@")[0]?.replace(/[^a-z0-9]+/gi, "-").toLowerCase() ?? "org"
      await authClient.organization.create({ name: name || slug, slug: `${slug}-${Date.now().toString(36)}` })
    }
    window.location.reload()
  }

  return (
    <main className="mx-auto flex w-full max-w-sm flex-1 flex-col justify-center gap-6 px-6 py-16">
      <header className="space-y-2">
        <h1 className="text-lg font-medium">
          {mode === "sign-up" ? "Create an account" : "Sign in"}
        </h1>
        <p className="text-xs leading-5 text-zinc-500">
          An account owns organisations. A memory key belongs to one organisation,
          and is what your agent presents.
        </p>
      </header>

      <form onSubmit={submit} className="space-y-3">
        {mode === "sign-up" && (
          <Field label="Name" value={name} onChange={setName} placeholder="Ada Lovelace" autoComplete="name" />
        )}
        <Field
          label="Email"
          type="email"
          value={email}
          onChange={setEmail}
          placeholder="you@example.com"
          autoComplete="email"
        />
        <Field
          label="Password"
          type="password"
          value={password}
          onChange={setPassword}
          placeholder="at least 12 characters"
          autoComplete={mode === "sign-up" ? "new-password" : "current-password"}
        />

        {error && <p className="text-xs text-red-300">{error}</p>}

        <button
          type="submit"
          disabled={busy}
          className="w-full rounded-lg bg-violet-500 px-3.5 py-2 text-xs font-medium text-white transition hover:bg-violet-400 disabled:opacity-50"
        >
          {busy ? "Working…" : mode === "sign-up" ? "Create account" : "Sign in"}
        </button>
      </form>

      <button
        type="button"
        onClick={() => setMode(mode === "sign-in" ? "sign-up" : "sign-in")}
        className="text-xs text-zinc-500 transition hover:text-zinc-300"
      >
        {mode === "sign-in" ? "No account? Sign up" : "Have an account? Sign in"}
      </button>
    </main>
  )
}

function Field({
  label,
  value,
  onChange,
  ...rest
}: {
  label: string
  value: string
  onChange: (value: string) => void
  placeholder?: string
  type?: string
  autoComplete?: string
}) {
  return (
    <label className="block space-y-1.5">
      <span className="font-mono text-[10px] uppercase tracking-widest text-zinc-600">{label}</span>
      <input
        {...rest}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        required
        className="w-full rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2 text-sm text-zinc-100 outline-none transition placeholder:text-zinc-600 focus:border-violet-400/50"
      />
    </label>
  )
}
