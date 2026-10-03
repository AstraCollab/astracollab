import Link from "next/link"
import type { Metadata } from "next"

import { AuthForm } from "@/components/auth-form"

export const metadata: Metadata = {
  title: "Sign up — Nah Cloud"
}

export default function SignUpPage() {
  return (
    <div className="flex min-h-full items-center justify-center px-6 py-16">
      <div className="w-full max-w-sm">
        <div className="mb-8 text-center">
          <h1 className="text-2xl font-semibold tracking-tight">Create an account</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Then create an organisation to hold your agents.
          </p>
        </div>
        <AuthForm mode="sign-up" />
        <p className="mt-6 text-center text-sm text-muted-foreground">
          Already have an account?{" "}
          <Link href="/sign-in" className="font-medium text-foreground hover:underline">
            Sign in
          </Link>
        </p>
      </div>
    </div>
  )
}