import type { Metadata } from "next"

import { createOrganizationAction } from "@/app/dashboard/actions"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { requireViewer } from "@/server/session"

export const metadata: Metadata = {
  title: "Create an organisation — Nah Cloud"
}

/**
 * Where a new account lands.
 *
 * Signing up creates a person; a person cannot hold an agent, because every row
 * in `agents` and `runs` is scoped to an `organizationId`. Rather than let a
 * first-run dashboard render an empty shell and fail to explain why, the session
 * helper routes here when there is no active organisation, and this page is the
 * one thing that can fix it.
 *
 * It is reached only by someone who genuinely belongs to no organisation. A user
 * who belongs to several but has none active on this session is not sent here —
 * `getViewer` resolves them to the most recent, so onboarding stays the answer to
 * "you have nowhere to put an agent" and not also the answer to "we lost track".
 */
export default async function OnboardingPage() {
  const viewer = await requireViewer()

  return (
    <div className="mx-auto max-w-lg">
      <p className="eyebrow">One more step</p>
      <h1 className="tracking-display mt-3 text-3xl font-semibold text-balance">
        Create an organisation
      </h1>
      <p className="mt-4 text-[var(--ink-muted)] text-pretty">
        Agents, runs and API keys all belong to an organisation rather than to a
        person — that is what lets a teammate leave without taking the machine
        credentials with them, and what makes the bill attributable.
      </p>

      <form action={createOrganizationAction} className="glass mt-8 space-y-4 rounded-[0.75rem] p-6">
        <div className="space-y-2">
          <label htmlFor="name" className="eyebrow block">
            Name
          </label>
          <Input
            id="name"
            name="name"
            required
            autoFocus
            placeholder="acme"
            className="h-10 text-base"
          />
          <p className="font-mono-tech text-xs text-[var(--ink-faint)]">
            Signed in as {viewer.email}
          </p>
        </div>

        <Button
          type="submit"
          size="lg"
          className="w-full rounded-[0.75rem] border-signal bg-signal text-[#09090b] hover:bg-signal/90"
        >
          Create organisation
        </Button>
      </form>
    </div>
  )
}
