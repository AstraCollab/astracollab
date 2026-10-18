"use client"

import { useActionState } from "react"

import { createKeyAction, type CreatedKey } from "@/app/dashboard/actions"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"

/**
 * Mint a key, and show the secret exactly once.
 *
 * The only client component on the keys page, and it exists for one reason: the
 * secret is available in the response to the create call and nowhere else, so it
 * has to be captured at the moment of creation. A server-rendered form that
 * redirected would drop it on the floor — the redirect would re-read the list,
 * and the list only has hashes.
 *
 * `useActionState` rather than a bare form action because the action returns the
 * secret, and a bare `action={...}` has no way to render a return value.
 */
const initial: CreatedKey = { key: null, error: null }

export function CreateKeyForm({ defaultConfigId = "agent" }: { readonly defaultConfigId?: "agent" | "runner" }) {
  const [state, formAction, pending] = useActionState(createKeyAction, initial)

  return (
    <div className="space-y-4">
      <form action={formAction} className="grid gap-4 sm:grid-cols-[1fr_auto_auto] sm:items-end">
        <div className="space-y-2">
          <label htmlFor="key-name" className="eyebrow block">
            Name
          </label>
          <Input id="key-name" name="name" required placeholder="laptop" />
        </div>

        {/* Agent keys are long-lived and revoked by hand; runner keys are
            short-lived, rate-limited and for the sandbox's own control-plane
            calls. Named as such because "agent" and "runner" mean nothing to
            someone who has not read the auth config. */}
        <div className="space-y-2">
          <label htmlFor="key-config" className="eyebrow block">
            Type
          </label>
          <select
            id="key-config"
            name="configId"
            defaultValue={defaultConfigId}
            className="h-9 rounded-[0.75rem] border border-input bg-[var(--surface-inset)] px-3 text-sm text-[var(--ink)] outline-none focus-visible:border-signal"
          >
            <option value="agent">Agent — long-lived</option>
            <option value="runner">Runner — short-lived</option>
          </select>
        </div>

        <Button
          type="submit"
          disabled={pending}
          className="rounded-[0.75rem] border-signal bg-signal text-[#09090b] hover:bg-signal/90"
        >
          {pending ? "Creating…" : "Create key"}
        </Button>
      </form>

      {state.error ? <p className="text-sm text-amber-300">{state.error}</p> : null}

      {state.key ? (
        <div className="rounded-[0.75rem] border border-signal/40 bg-signal/5 p-4">
          <p className="eyebrow text-signal">Copy this now</p>
          <code className="font-mono-tech mt-2 block break-all text-sm text-[var(--ink)]">
            {state.key}
          </code>
          <p className="mt-3 text-xs text-[var(--ink-muted)]">
            It is not stored in plaintext and cannot be shown again. Revoke it if it
            leaks.
          </p>
        </div>
      ) : null}
    </div>
  )
}
