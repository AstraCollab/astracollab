import Link from "next/link"
import type { Metadata } from "next"

import { AuthForm } from "@/components/auth-form"

export const metadata: Metadata = {
  title: "Sign in — Nah Cloud"
}

export default function SignInPage() {
  return (
    <div className="auth grain relative flex min-h-screen items-center justify-center overflow-hidden px-6 py-16">
      <div className="landing-grid pointer-events-none absolute inset-0" aria-hidden="true" />
      {/* One orb, off-centre and high, so the panel is lit from a corner. */}
      <div className="glow -top-32 -left-24 size-[30rem] bg-[#a78bfa]/20" aria-hidden="true" />

      <div className="relative w-full max-w-sm">
        <div className="glass rounded-[0.75rem] p-8">
          <div className="mb-8 text-center">
            <p className="eyebrow">Nah Cloud</p>
            <h1 className="tracking-display mt-3 text-2xl font-semibold">
              Sign in
            </h1>
            <p className="mt-2 text-sm text-muted-foreground">
              Access your hosted agents.
            </p>
          </div>

          <AuthForm mode="sign-in" />

          <p className="mt-6 text-center text-sm text-muted-foreground">
            No account?{" "}
            <Link
              href="/sign-up"
              className="font-medium text-foreground hover:text-signal hover:underline"
            >
              Sign up
            </Link>
          </p>
        </div>
      </div>
    </div>
  )
}