import { headers } from "next/headers"

import { revokeKeyAction } from "@/app/dashboard/actions"
import { CreateKeyForm } from "@/components/dashboard/create-key-form"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { getAuth } from "@/server/auth/better-auth"
import { requireOrganization } from "@/server/session"

export const metadata = {
  title: "Keys — Nah Cloud"
}

/**
 * Whether a key's own expiry has passed.
 *
 * `enabled` and "not expired" are separate: a self-expiring runner key is still
 * `enabled` in the database long after it stopped working, so a page that only
 * read the flag would show a dead key as active. Comparing against the clock here
 * rather than in the component body also keeps the render pure — the answer is
 * produced once per request, in a function that is allowed to read the time.
 */
function isExpired(expiresAt: Date | null): boolean {
  return expiresAt !== null && expiresAt.getTime() < Date.now()
}

/**
 * The organisation's machine credentials.
 *
 * Listed through Better Auth's `listApiKeys` scoped to `organizationId`, not
 * through a query of our own — the keys are stored in its tables under its
 * schema, so reading them anywhere else means keeping a second copy of a
 * security-relevant table in sync. The tenancy seam is still ours: the org id
 * comes from the session and is passed as a filter, never from the URL.
 *
 * Note what is *not* here: the key itself. `listApiKeys` strips the plaintext on
 * the way out, which is why the create flow has to capture the secret at
 * creation time instead of this page reading it back.
 */
export default async function KeysPage({ searchParams }: { readonly searchParams?: Promise<Record<string, string | string[] | undefined>> }) {
  const viewer = await requireOrganization()
  const sp = searchParams ? await searchParams : {}
  const show = typeof sp.show === "string" ? sp.show : undefined

  let keys: readonly {
    id: string
    name: string | null
    prefix: string | null
    enabled: boolean
    expiresAt: Date | null
    createdAt: Date
    configId: string
  }[] = []

  try {
    const result = await getAuth().api.listApiKeys({
      query: { organizationId: viewer.organizationId, sortBy: "createdAt", sortDirection: "desc" },
      headers: await headers()
    })

    // Cast at the boundary rather than trusting the plugin's inferred tuple. The
    // plugin's type is `string[]` for the array element in some versions, which
    // is not usable, and the fields read below are all present in the response.
    keys = (result.apiKeys as unknown as typeof keys) ?? []
  } catch {
    // A member role has no `apiKey:read`. The page still renders — they can
    // still use a key someone else made — it just says why the list is empty
    // instead of 500ing the whole dashboard.
    keys = []
  }

  const canRead = keys.length > 0 || viewer.role === "owner" || viewer.role === "admin"

  return (
    <div className="space-y-10">
      <header>
        <p className="eyebrow">{viewer.organizationName}</p>
        <h1 className="tracking-display mt-3 text-3xl font-semibold">Keys</h1>
        <p className="mt-2 text-sm text-[var(--ink-muted)]">
          Point <code className="font-mono-tech">nah</code> at the cloud with an agent key.
        </p>
      </header>

      <section className="glass rounded-[0.75rem] p-6">
        <h2 className="text-lg font-medium">New key</h2>
        <div className="mt-4">
          <CreateKeyForm defaultConfigId={show === "runner" ? "runner" : "agent"} />
        </div>
      </section>

      <section>
        <h2 className="text-lg font-medium">Existing keys</h2>

        {!canRead ? (
          <p className="mt-4 rounded-[0.75rem] border border-line p-6 text-sm text-[var(--ink-muted)]">
            Your role cannot list this organisation&apos;s keys. Ask an owner or admin if you
            need one.
          </p>
        ) : keys.length === 0 ? (
          <p className="mt-4 text-sm text-[var(--ink-muted)]">No keys yet.</p>
        ) : (
          <ul className="mt-4 flex flex-col gap-2">
            {keys.map((key) => {
              const expired = isExpired(key.expiresAt)
              const active = key.enabled && !expired

              return (
                <li
                  key={key.id}
                  className="flex flex-wrap items-center gap-3 rounded-[0.75rem] border border-line bg-[var(--surface-raised)] px-4 py-3"
                >
                  <Badge tone={active ? "good" : "neutral"}>
                    {key.enabled ? (expired ? "expired" : "active") : "revoked"}
                  </Badge>
                  <span className="min-w-0 flex-1 truncate text-sm">{key.name ?? "unnamed"}</span>
                  {/* The prefix is public by construction — it is the visible
                      half of the token, kept so a person can tell two keys apart
                      without either being shown the other. */}
                  <span className="font-mono-tech shrink-0 text-xs text-[var(--ink-faint)]">
                    {key.prefix ?? ""}…
                  </span>
                  <span className="font-mono-tech shrink-0 text-[10px] uppercase tracking-[0.12em] text-[var(--ink-faint)]">
                    {key.configId}
                  </span>

                  {key.enabled ? (
                    <form action={revokeKeyAction}>
                      <input type="hidden" name="keyId" value={key.id} />
                      <Button type="submit" variant="destructive" size="xs">
                        Revoke
                      </Button>
                    </form>
                  ) : null}
                </li>
              )
            })}
          </ul>
        )}
      </section>
    </div>
  )
}
