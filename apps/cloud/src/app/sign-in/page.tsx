import Link from "next/link"
import type { Metadata } from "next"

import { AuthForm } from "@/components/auth-form"

export const metadata: Metadata = {
  title: "Sign in — Nah Cloud"
}

export default function SignInPage() {
  return (
    <div className="flex min-h-full items-center justify-center px-6 py-16">
      <div className="w-full max-w-sm">
        <div className="mb-8 text-center">
          <h1 className="text-2xl font-semibold tracking-tight">Sign in</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Access your hosted agents.
          </p>
        </div>
        <AuthForm mode="sign-in" />
        <p className="mt-6 text-center text-sm text-muted-foreground">
          No account?{" "}
          <Link href="/sign-up" className="font-medium text-foreground hover:underline">
            Sign up
          </Link>
        </p>
      </div>
    </div>
  )
}