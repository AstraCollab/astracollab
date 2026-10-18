import Link from "next/link"
import type { Metadata } from "next"

import { AuthForm } from "@/components/auth-form"

export const metadata: Metadata = {
  title: "Sign up — Nah Cloud"
}

export default function SignUpPage() {
  return (
    <div className="auth grain relative flex min-h-screen items-center justify-center overflow-hidden px-6 py-16">
      <div className="landing-grid pointer-events-none absolute inset-0" aria-hidden="true" />
      {/* Mirrored from the sign-in page — a form you have seen before should
          not also move when you arrive from a different direction. */}
      <div className="glow -right-24 -top-32 size-[30rem] bg-[#a78bfa]/20" aria-hidden="true" />

      <div className="relative w-full max-w-sm">
        <div className="glass rounded-[0.75rem] p-8">
          <div className="mb-8 text-center">
            <p className="eyebrow">Nah Cloud</p>
            <h1 className="tracking-display mt-3 text-2xl font-semibold">
              Create an account
            </h1>
            <p className="mt-2 text-sm text-muted-foreground">
              Then create an organisation to hold your agents.
            </p>
          </div>

          <AuthForm mode="sign-up" />

          <p className="mt-6 text-center text-sm text-muted-foreground">
            Already have an account?{" "}
            <Link
              href="/sign-in"
              className="font-medium text-foreground hover:text-signal hover:underline"
            >
              Sign in
            </Link>
          </p>
        </div>
      </div>
    </div>
  )
}