"use client"

import Link from "next/link"
import { useEffect, useState } from "react"

import { getJson, sendJson, type KeyRow } from "../data"
import {
  Badge,
  Button,
  CopyButton,
  Field,
  Grid,
  Loading,
  Metric,
  PageHeader,
  Panel,
  Table,
  Td,
  Th,
  inputClass
} from "../ui"

/**
 * Credentials.
 *
 * A key is what an agent presents. It resolves to this organisation and a set of
 * scopes, and it can do nothing else: minting another key needs a signed-in
 * session, so a leaked key cannot escalate itself.
 *
 * Keys are listed with everything except the secret, because only a sha256 of
 * the secret half is stored — the list has to be useful, and pretending to show a
 * recoverable key would be worse than showing an honest prefix.
 */

const SCOPES = [
  {
    id: "memories:read",
    label: "read",
    hint: "recall, and build context blocks",
    needed: true
  },
  {
    id: "memories:write",
    label: "write",
    hint: "store facts and learn from turns",
    needed: true
  },
  {
    id: "stats:read",
    label: "stats",
    hint: "usage only, no memory contents",
    needed: false
  },
  {
    id: "keys:manage",
    label: "keys",
    hint: "rotate other keys for this organisation",
    needed: false
  }
] as const

interface IssuedResponse {
  key: string
  prefix: string
  scopes: Array<string>
  expiresAt: string | null
}

export function KeysPanel() {
  const [keys, setKeys] = useState<ReadonlyArray<KeyRow> | null>(null)
  const [issued, setIssued] = useState<IssuedResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [expiry, setExpiry] = useState("")

  const load = () =>
    getJson<{ keys: Array<KeyRow> }>("/api/v1/keys")
      .then((body) => setKeys(body.keys))
      .catch((cause: unknown) =>
        setError(cause instanceof Error ? cause.message : "Could not load keys.")
      )

  useEffect(() => {
    void load()
  }, [])

  const issue = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setError(null)
    setBusy(true)
    const form = new FormData(event.currentTarget)
    const scopes = SCOPES.filter((scope) => form.get(scope.id) === "on").map((scope) => scope.id)
    try {
      const body = await sendJson<IssuedResponse>("/api/v1/keys", "POST", {
        name: String(form.get("name") ?? ""),
        scopes,
        ...(expiry === "" ? {} : { expiresInDays: Number(expiry) })
      })
      setIssued(body)
      await load()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not issue a key.")
    } finally {
      setBusy(false)
    }
  }

  const revoke = async (id: string) => {
    if (!window.confirm("Revoke this key? Anything presenting it starts failing immediately."))
      return
    setBusy(true)
    try {
      await sendJson(`/api/v1/keys/${id}`, "DELETE")
      await load()
    } finally {
      setBusy(false)
    }
  }

  const active = keys?.filter((key) => key.status === "active") ?? []
  const unused = active.filter((key) => key.lastUsedAt === null)

  return (
    <div className="space-y-6">
      <PageHeader
        title="Credentials"
        description={
          <>
            Keys are the credentials an agent presents, scoped and individually
            revocable, stored as a sha256 hash and shown exactly once. They are last on
            purpose: they are a setup step, not a daily one.
          </>
        }
        actions={
          <Link href="/dashboard/start">
            <Button>Get started</Button>
          </Link>
        }
      />

      {issued !== null && <IssuedKey issued={issued} onDismiss={() => setIssued(null)} />}

      <Grid cols={4}>
        <Metric label="keys" value={keys?.length ?? 0} />
        <Metric label="active" value={active.length} tone={active.length === 0 ? "warn" : "plain"} />
        <Metric label="never used" value={unused.length} hint="maybe you meant to delete one" />
        <Metric
          label="revoked"
          value={keys?.filter((key) => key.status === "revoked").length ?? 0}
          hint="kept for the audit trail"
        />
      </Grid>

      {unused.length > 1 && (
        <p className="rounded-lg border border-white/[0.08] bg-white/[0.02] px-4 py-2.5 text-[12px] leading-5 text-zinc-500">
          {unused.length} keys have never been presented. An unused key cannot be leaked
          by accident, but it is also not doing anything — worth deleting the ones you
          meant to replace.
        </p>
      )}

      <form
        onSubmit={issue}
        className="grid gap-3 rounded-xl border border-white/[0.08] bg-white/[0.02] p-4 lg:grid-cols-[2fr_1fr_auto] lg:items-end"
      >
        <Field label="what is this key for" hint="Name it after the thing that will present it.">
          <input
            name="name"
            required
            placeholder="e.g. laptop-cli, ci, staging-agent"
            className={inputClass}
          />
        </Field>
        <Field label="expires in" hint="Optional. Blank never expires.">
          <input
            value={expiry}
            onChange={(event) => setExpiry(event.target.value)}
            placeholder="90 (days)"
            inputMode="numeric"
            className={inputClass}
          />
        </Field>
        <Button type="submit" variant="primary" disabled={busy}>
          {busy ? "Issuing…" : "Issue key"}
        </Button>

        <div className="space-y-2 lg:col-span-3">
          <span className="font-mono text-[10px] uppercase tracking-widest text-zinc-600">
            scopes — least privilege wins
          </span>
          <div className="grid gap-2 sm:grid-cols-2">
            {SCOPES.map((scope) => (
              <label key={scope.id} className="flex items-start gap-2.5 text-[13px]">
                <input
                  type="checkbox"
                  name={scope.id}
                  defaultChecked={scope.needed}
                  className="mt-1 accent-violet-500"
                />
                <span>
                  <code className="font-mono text-[11px] text-zinc-300">{scope.id}</code>{" "}
                  <span className="text-zinc-500">— {scope.hint}</span>
                </span>
              </label>
            ))}
          </div>
        </div>

        {error !== null && <p className="text-[12px] text-red-300 lg:col-span-3">{error}</p>}
      </form>

      {keys === null ? (
        <Loading />
      ) : keys.length === 0 ? (
        <p className="text-[13px] text-zinc-600">No keys yet. An agent cannot reach memory until there is one.</p>
      ) : (
        <Panel title="Issued keys" hint="A revoked key stays listed so an audit of who used what survives turning it off.">
          <Table
            head={
              <>
                <Th>name</Th>
                <Th>prefix</Th>
                <Th>scopes</Th>
                <Th>used</Th>
                <Th />
              </>
            }
          >
            {keys.map((key) => (
              <tr key={key.id}>
                <Td className="text-zinc-200">{key.name}</Td>
                <Td className="font-mono text-[11px] text-violet-200">{key.prefix}</Td>
                <Td>
                  <span className="flex flex-wrap gap-1">
                    {key.scopes.map((scope) => (
                      <Badge key={scope} tone="neutral">
                        {scope}
                      </Badge>
                    ))}
                  </span>
                </Td>
                <Td className="whitespace-nowrap font-mono text-[10px] text-zinc-600">
                  {key.lastUsedAt === null
                    ? "never"
                    : new Date(key.lastUsedAt).toLocaleDateString(undefined, {
                        month: "short",
                        day: "numeric"
                      })}
                  {key.expiresAt !== null && key.status === "active" && (
                    <span className="ml-1.5 text-amber-300/70">
                      exp {new Date(key.expiresAt).toLocaleDateString()}
                    </span>
                  )}
                </Td>
                <Td className="text-right">
                  {key.status === "active" ? (
                    <Button size="sm" variant="danger" disabled={busy} onClick={() => void revoke(key.id)}>
                      revoke
                    </Button>
                  ) : (
                    <span className="font-mono text-[10px] text-zinc-700">{key.status}</span>
                  )}
                </Td>
              </tr>
            ))}
          </Table>
        </Panel>
      )}
    </div>
  )
}

function IssuedKey({ issued, onDismiss }: { issued: IssuedResponse; onDismiss: () => void }) {
  return (
    <div className="rounded-xl border border-violet-400/30 bg-violet-500/[0.07] p-4">
      <p className="text-[13px] font-medium text-violet-100">Your key</p>
      <p className="mt-1 text-[12px] text-violet-200/60">
        Only a hash of this is stored. Copy it now — it cannot be shown again.
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <code className="secret min-w-0 flex-1 overflow-x-auto rounded-lg px-3 py-2 font-mono text-[11px] text-violet-100">
          {issued.key}
        </code>
        <CopyButton value={issued.key} className="border-violet-400/30 !text-violet-200" />
      </div>
      <button
        type="button"
        onClick={onDismiss}
        className="mt-3 text-[11px] text-violet-300/50 transition hover:text-violet-200"
      >
        I have saved it — hide
      </button>
    </div>
  )
}