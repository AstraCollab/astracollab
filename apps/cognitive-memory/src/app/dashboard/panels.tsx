"use client"

import { useEffect, useState } from "react"

/**
 * The dashboard panels.
 *
 * Split out of `dashboard.tsx` so each one is a readable unit: the context
 * preview, the memory list, the self-model, the tensions and the key manager are
 * five different concerns that happen to share a page.
 */

export interface Overview {
  organizationId: string
  memories: MemoryRow[]
  stats: {
    total: number
    byTier: Record<string, number>
    sessions: number
    firstStoredAt: number
    lastAccessedAt: number
    activeTensions: number
  }
  selfModel: {
    calibrationFactor: number
    activeDomains: string[]
    domains: Record<
      string,
      {
        reliabilityScore: number
        sampleCount: number
        knownFailurePatterns: string[]
        recommendedStrategies: string[]
      }
    >
    weakDomains: string[]
  }
  tensions: Tension[]
}

export interface MemoryRow {
  id: string
  content: string
  gist?: string
  tier: string
  domains: string[]
  accessCount: number
  source?: string
  sessionId?: string
  createdAt: number
  lastAccessedAt: number
}

export interface Tension {
  id: string
  status: "active" | "latent" | "resolved"
  claimA: { source: string; statement: string; timestamp: number }
  claimB: { source: string; statement: string; timestamp: number }
  impact: "low" | "medium" | "critical"
  actionableQuestion: string
  resolvedBy?: string
  pattern?: string
}

/* -------------------------------------------------------------------------- */
/* Context preview — the centrepiece                                            */
/* -------------------------------------------------------------------------- */

interface PreviewEntry {
  id: string
  tier: string
  reason: string
  gist: string
  body?: string
  tokens: number
}

interface PreviewResponse {
  text: string
  entries: PreviewEntry[]
  totalTokens: number
  truncated: boolean
  identifiers: string[]
}

const REASON_COPY: Record<string, string> = {
  index: "indexed — a gist line, because nothing referred to it",
  trigger: "a concrete identifier you named matched this",
  tension: "an unresolved contradiction",
  guardrail: "a domain this agent has been unreliable in"
}

/**
 * Show the exact block an agent would be given, for any message typed here.
 *
 * The point is falsifiability. A log line saying memory was injected does not
 * let you check whether it was the right memory; the text does, and so does the
 * per-line reason and token cost.
 */
export function ContextPanel() {
  const [message, setMessage] = useState("deploy ZQ7X4M2K to the internal staging host")
  const [preview, setPreview] = useState<PreviewResponse | null>(null)
  const [busy, setBusy] = useState(false)

  // A bare fetch, so both callers can decide when to set state: the mount effect
  // updates only in the continuation, while the form can also flip a busy flag.
  const fetchPreview = (value: string): Promise<PreviewResponse | null> =>
    fetch("/api/dashboard/preview", {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ userMessage: value })
    })
      .then((response) => (response.ok ? response.json() : null))
      .catch(() => null)

  const run = (value: string) => {
    setBusy(true)
    void fetchPreview(value).then((body) => {
      setPreview(body)
      setBusy(false)
    })
  }

  // Run once on mount so the panel is never an empty box waiting for input.
  useEffect(() => {
    let cancelled = false
    void fetchPreview(message).then((body) => {
      if (!cancelled) setPreview(body)
    })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div className="space-y-5">
      <header className="space-y-2">
        <h1 className="text-lg font-medium">What your agent will be told</h1>
        <p className="max-w-2xl text-[13px] leading-6 text-zinc-500">
          The block this service would prepend to a system prompt, for the message
          you type below. Every line is labelled with the rule that earned it and
          what it cost, because an injection you cannot check is an injection you
          cannot tune.
        </p>
      </header>

      <form
        onSubmit={(event) => {
          event.preventDefault()
          run(message)
        }}
        className="flex flex-wrap gap-2"
      >
        <input
          value={message}
          onChange={(event) => setMessage(event.target.value)}
          placeholder="a message your agent is about to answer"
          className="min-w-0 flex-1 rounded-lg border border-white/10 bg-white/[0.03] px-3.5 py-2.5 text-[13px] outline-none transition placeholder:text-zinc-700 focus:border-violet-400/50"
        />
        <button
          type="submit"
          disabled={busy}
          className="rounded-lg border border-white/12 px-3.5 py-2.5 text-[13px] text-zinc-300 transition hover:border-white/25 hover:text-white disabled:opacity-50"
        >
          {busy ? "Building…" : "Preview"}
        </button>
      </form>

      {preview && (
        <>
          <div className="grid gap-2 sm:grid-cols-3">
            <Metric label="tokens" value={preview.totalTokens.toLocaleString()} />
            <Metric label="entries" value={String(preview.entries.length)} />
            <Metric
              label="bodies included"
              value={String(preview.entries.filter((entry) => entry.body !== undefined).length)}
              tone={preview.truncated ? "warn" : "plain"}
            />
          </div>

          <div className="grid gap-4 lg:grid-cols-[1fr_320px]">
            <div className="overflow-hidden rounded-xl border border-white/[0.08]">
              <div className="flex items-center justify-between border-b border-white/[0.06] px-4 py-2">
                <span className="font-mono text-[10px] uppercase tracking-widest text-zinc-600">
                  prompt block
                </span>
                {preview.truncated && (
                  <span className="text-[10px] text-amber-300/80">
                    truncated by the token budget
                  </span>
                )}
              </div>
              {preview.text.trim() === "" ? (
                <p className="px-4 py-6 text-[13px] text-zinc-600">
                  Nothing to inject yet. Store something, or learn from a turn.
                </p>
              ) : (
                <pre className="max-h-[520px] overflow-auto whitespace-pre-wrap px-4 py-4 font-mono text-[11px] leading-5 text-zinc-400">
                  {preview.text}
                </pre>
              )}
            </div>

            <div className="space-y-3">
              <div className="rounded-xl border border-white/[0.08] bg-white/[0.02] p-4">
                <p className="font-mono text-[10px] uppercase tracking-widest text-zinc-600">
                  identifiers found
                </p>
                {preview.identifiers.length === 0 ? (
                  <p className="mt-2 text-xs leading-5 text-zinc-600">
                    None, so nothing earns a full body. Name a build id, a host or
                    a path to see the trigger fire.
                  </p>
                ) : (
                  <ul className="mt-2 space-y-1">
                    {preview.identifiers.map((identifier) => (
                      <li key={identifier} className="font-mono text-[11px] text-violet-200">
                        {identifier}
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              <div className="rounded-xl border border-white/[0.08] bg-white/[0.02] p-4">
                <p className="font-mono text-[10px] uppercase tracking-widest text-zinc-600">
                  why each line
                </p>
                <ul className="mt-2 space-y-2.5">
                  {preview.entries.map((entry) => (
                    <li key={entry.id}>
                      <div className="flex items-baseline gap-2">
                        <code className="rounded bg-white/[0.06] px-1.5 py-0.5 font-mono text-[9px] text-zinc-400">
                          {entry.reason}
                        </code>
                        <span className="font-mono text-[9px] text-zinc-700">{entry.tokens} tok</span>
                      </div>
                      <p className="mt-1 text-[11px] leading-4 text-zinc-500">
                        {entry.gist}
                      </p>
                      <p className="text-[10px] leading-4 text-zinc-700">
                        {REASON_COPY[entry.reason] ?? "included"}
                      </p>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/* Memory                                                                      */
/* -------------------------------------------------------------------------- */

export function MemoryPanel({
  overview,
  onChanged
}: {
  overview: Overview
  onChanged: () => void
}) {
  const [query, setQuery] = useState("")
  const [busy, setBusy] = useState(false)

  const needle = query.trim().toLowerCase()
  const rows = needle === ""
    ? overview.memories
    : overview.memories.filter((memory) =>
        `${memory.content} ${memory.domains.join(" ")}`.toLowerCase().includes(needle)
      )

  const setTier = async (id: string, tier: string) => {
    setBusy(true)
    await fetch(`/api/dashboard/memories/${id}`, {
      method: "PATCH",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tier })
    }).catch(() => undefined)
    setBusy(false)
    onChanged()
  }

  const forget = async (id: string) => {
    if (!window.confirm("Forget this memory? It cannot be recovered.")) return
    setBusy(true)
    await fetch(`/api/dashboard/memories/${id}`, { method: "DELETE", credentials: "include" }).catch(
      () => undefined
    )
    setBusy(false)
    onChanged()
  }

  return (
    <div className="space-y-5">
      <header className="space-y-2">
        <h1 className="text-lg font-medium">What it has learned</h1>
        <p className="max-w-2xl text-[13px] leading-6 text-zinc-500">
          L1 is written into every prompt as an index line. L2 and L3 cost nothing
          until something promotes or recalls them, so a large store is not an
          expensive one.
        </p>
      </header>

      <div className="grid gap-2 sm:grid-cols-4">
        <Metric label="total" value={String(overview.stats.total)} />
        <Metric label="L1 hot" value={String(overview.stats.byTier.L1 ?? 0)} />
        <Metric label="L2 warm" value={String(overview.stats.byTier.L2 ?? 0)} />
        <Metric label="L3 cold" value={String(overview.stats.byTier.L3 ?? 0)} />
      </div>

      <input
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder="filter by text or domain"
        className="w-full rounded-lg border border-white/10 bg-white/[0.03] px-3.5 py-2.5 text-[13px] outline-none transition placeholder:text-zinc-700 focus:border-violet-400/50"
      />

      {rows.length === 0 ? (
        <p className="text-[13px] text-zinc-600">
          {needle === ""
            ? "Nothing stored yet. Point an agent at the service, or POST to /v1/memories."
            : "No memory contains that."}
        </p>
      ) : (
        <ul className="space-y-1.5">
          {rows.map((memory) => (
            <li
              key={memory.id}
              className="group flex flex-wrap items-center gap-3 rounded-lg border border-white/[0.06] bg-white/[0.015] px-3.5 py-2.5"
            >
              <span className="rounded bg-white/[0.06] px-1.5 py-0.5 font-mono text-[9px] text-zinc-400">
                {memory.tier}
              </span>
              <span className="min-w-0 flex-1 text-[13px] text-zinc-300">{memory.content}</span>
              {memory.domains.slice(0, 3).map((domain) => (
                <span key={domain} className="font-mono text-[9px] text-zinc-600">
                  {domain}
                </span>
              ))}
              <span className="font-mono text-[9px] text-zinc-700">
                {memory.source ?? "api"} · used {memory.accessCount}×
              </span>
              <span className="flex gap-1 opacity-0 transition group-hover:opacity-100 focus-within:opacity-100">
                {memory.tier !== "L1" && (
                  <Chip onClick={() => void setTier(memory.id, "L1")} disabled={busy}>
                    promote
                  </Chip>
                )}
                {memory.tier === "L1" && (
                  <Chip onClick={() => void setTier(memory.id, "L2")} disabled={busy}>
                    demote
                  </Chip>
                )}
                <Chip onClick={() => void forget(memory.id)} disabled={busy} tone="danger">
                  forget
                </Chip>
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/* Self-model                                                                  */
/* -------------------------------------------------------------------------- */

export function SelfModelPanel({ overview }: { overview: Overview }) {
  const entries = Object.entries(overview.selfModel.domains).sort(
    (a, b) => a[1].reliabilityScore - b[1].reliabilityScore
  )

  return (
    <div className="space-y-5">
      <header className="space-y-2">
        <h1 className="text-lg font-medium">What it knows about itself</h1>
        <p className="max-w-2xl text-[13px] leading-6 text-zinc-500">
          Reliability per domain, from outcomes you record. Below 75%, a domain is
          written into every prompt as a guardrail listing its known failure
          patterns — so a weak area gets attention instead of a confident guess.
        </p>
      </header>

      {entries.length === 0 ? (
        <div className="rounded-xl border border-white/[0.08] bg-white/[0.02] p-6">
          <p className="text-[13px] text-zinc-500">
            No outcomes recorded, so the model is still at its priors and no
            guardrail will fire.
          </p>
          <pre className="mt-4 overflow-x-auto rounded-lg border border-white/[0.06] bg-black/40 px-4 py-3 font-mono text-[11px] leading-5 text-zinc-400">
            {`curl -X POST localhost:3000/api/v1/self-model/outcome \\
  -H "Authorization: Bearer $COGNITIVE_MEMORY_KEY" \\
  -H "content-type: application/json" \\
  -d '{"domain":"database","success":false,"failurePattern":"migrated without a backup"}'`}
          </pre>
        </div>
      ) : (
        <ul className="space-y-2">
          {entries.map(([domain, capability]) => {
            const weak = capability.reliabilityScore < 0.75
            return (
              <li key={domain} className="rounded-lg border border-white/[0.06] bg-white/[0.015] px-4 py-3">
                <div className="flex items-baseline justify-between">
                  <span className="text-[13px] text-zinc-200">{domain}</span>
                  <span className="font-mono text-[11px] text-zinc-500">
                    {Math.round(capability.reliabilityScore * 100)}% over {capability.sampleCount}{" "}
                    {capability.sampleCount === 1 ? "task" : "tasks"}
                    {weak ? " · guardrail active" : ""}
                  </span>
                </div>
                <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-white/[0.06]">
                  <div
                    className={weak ? "h-full bg-amber-400/70" : "h-full bg-violet-400/60"}
                    style={{ width: `${Math.max(2, capability.reliabilityScore * 100)}%` }}
                  />
                </div>
                {capability.knownFailurePatterns.length > 0 && (
                  <p className="mt-2 text-[11px] leading-5 text-zinc-600">
                    Known pitfalls: {capability.knownFailurePatterns.join("; ")}
                  </p>
                )}
                {capability.recommendedStrategies.length > 0 && (
                  <p className="text-[11px] leading-5 text-zinc-600">
                    What works: {capability.recommendedStrategies.join("; ")}
                  </p>
                )}
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/* Tensions                                                                    */
/* -------------------------------------------------------------------------- */

export function TensionsPanel({
  overview,
  onChanged
}: {
  overview: Overview
  onChanged: () => void
}) {
  const [busy, setBusy] = useState(false)

  const resolve = async (id: string) => {
    const pattern = window.prompt("What is the reusable pattern here?", "")
    if (pattern === null) return
    setBusy(true)
    await fetch(`/api/dashboard/tensions/${encodeURIComponent(id)}`, {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ resolvedBy: "dashboard", pattern })
    }).catch(() => undefined)
    setBusy(false)
    onChanged()
  }

  return (
    <div className="space-y-5">
      <header className="space-y-2">
        <h1 className="text-lg font-medium">Contradictions it is holding</h1>
        <p className="max-w-2xl text-[13px] leading-6 text-zinc-500">
          Two claims that cannot both be true. Each is written into every prompt
          with the question to ask, until somebody resolves it. A flat list of
          facts has nowhere to put this.
        </p>
      </header>

      {overview.tensions.length === 0 ? (
        <div className="rounded-xl border border-white/[0.08] bg-white/[0.02] p-6">
          <p className="text-[13px] text-zinc-500">Nothing unresolved.</p>
          <pre className="mt-4 overflow-x-auto rounded-lg border border-white/[0.06] bg-black/40 px-4 py-3 font-mono text-[11px] leading-5 text-zinc-400">
            {`curl -X POST localhost:3000/api/v1/tensions \\
  -H "Authorization: Bearer $COGNITIVE_MEMORY_KEY" \\
  -H "content-type: application/json" \\
  -d '{"claimA":"We deploy on Fridays","claimB":"We never deploy on Fridays",
       "impact":"critical","actionableQuestion":"Which is it?"}'`}
          </pre>
        </div>
      ) : (
        <ul className="space-y-2">
          {overview.tensions.map((tension) => (
            <li
              key={tension.id}
              className="rounded-lg border border-amber-300/15 bg-amber-300/[0.04] px-4 py-3"
            >
              <div className="flex flex-wrap items-baseline gap-2">
                <span className="rounded bg-amber-300/10 px-1.5 py-0.5 font-mono text-[9px] text-amber-200/80">
                  {tension.impact}
                </span>
                <span className="text-[13px] text-amber-50/90">
                  “{tension.claimA.statement}”
                </span>
                <span className="text-zinc-600">conflicts with</span>
                <span className="text-[13px] text-amber-50/90">“{tension.claimB.statement}”</span>
              </div>
              <p className="mt-2 text-[11px] text-amber-200/60">
                Ask: {tension.actionableQuestion}
              </p>
              <button
                type="button"
                disabled={busy}
                onClick={() => void resolve(tension.id)}
                className="mt-3 rounded-lg border border-amber-300/20 px-3 py-1.5 text-[12px] text-amber-100/80 transition hover:bg-amber-300/10 disabled:opacity-50"
              >
                Resolve
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/* Keys                                                                        */
/* -------------------------------------------------------------------------- */

interface KeyRow {
  id: string
  name: string
  prefix: string
  scopes: string[]
  createdAt: string
  lastUsedAt: string | null
  revokedAt: string | null
  expiresAt: string | null
  status: "active" | "revoked" | "expired"
}

const SCOPES = [
  { id: "memories:read", label: "read", hint: "recall, and build context blocks" },
  { id: "memories:write", label: "write", hint: "store facts and learn from turns" },
  { id: "stats:read", label: "stats", hint: "usage only, no memory contents" }
] as const

export function KeysPanel() {
  const [keys, setKeys] = useState<ReadonlyArray<KeyRow> | null>(null)
  const [issued, setIssued] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const load = () =>
    fetch("/api/v1/keys", { credentials: "include" })
      .then((response) => (response.ok ? response.json() : null))
      .then((body: { keys: KeyRow[] } | null) => setKeys(body?.keys ?? []))

  useEffect(() => {
    void load()
  }, [])

  const issue = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setError(null)
    setBusy(true)
    const form = new FormData(event.currentTarget)
    const scopes = SCOPES.filter((scope) => form.get(scope.id) === "on").map((scope) => scope.id)
    const response = await fetch("/api/v1/keys", {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: String(form.get("name") ?? ""), scopes })
    })
    setBusy(false)
    if (!response.ok) {
      const body = await response.json().catch(() => ({}))
      setError(body.message ?? "Could not issue a key.")
      return
    }
    setIssued((await response.json()).key)
    await load()
  }

  const revoke = async (id: string) => {
    await fetch(`/api/v1/keys/${id}`, { method: "DELETE", credentials: "include" }).catch(
      () => undefined
    )
    await load()
  }

  return (
    <div className="space-y-6">
      <header className="space-y-2">
        <h1 className="text-lg font-medium">Credentials</h1>
        <p className="max-w-2xl text-[13px] leading-6 text-zinc-500">
          A key is what an agent presents. It resolves to this organisation and a
          set of scopes, and it can do nothing else — minting a key needs a
          signed-in session, so a leaked key cannot escalate itself.
        </p>
      </header>

      {issued && <IssuedKey secret={issued} onDismiss={() => setIssued(null)} />}

      <form onSubmit={issue} className="space-y-4 rounded-xl border border-white/[0.08] bg-white/[0.02] p-4">
        <label className="block space-y-1.5">
          <span className="font-mono text-[10px] uppercase tracking-widest text-zinc-600">
            what is this key for
          </span>
          <input
            name="name"
            required
            placeholder="e.g. laptop-cli, ci, staging-agent"
            className="w-full rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2 text-[13px] outline-none transition placeholder:text-zinc-700 focus:border-violet-400/50"
          />
        </label>

        <div className="space-y-2">
          <span className="font-mono text-[10px] uppercase tracking-widest text-zinc-600">scopes</span>
          {SCOPES.map((scope, index) => (
            <label key={scope.id} className="flex items-start gap-2.5 text-[13px]">
              <input
                type="checkbox"
                name={scope.id}
                defaultChecked={index < 2}
                className="mt-1 accent-violet-500"
              />
              <span>
                <code className="font-mono text-[11px] text-zinc-300">{scope.id}</code>{" "}
                <span className="text-zinc-500">— {scope.hint}</span>
              </span>
            </label>
          ))}
        </div>

        {error && <p className="text-[12px] text-red-300">{error}</p>}

        <button
          type="submit"
          disabled={busy}
          className="rounded-lg bg-violet-500 px-3.5 py-2 text-[13px] font-medium text-white transition hover:bg-violet-400 disabled:opacity-50"
        >
          {busy ? "Issuing…" : "Issue key"}
        </button>
      </form>

      {keys === null ? (
        <p className="text-[13px] text-zinc-600">Loading…</p>
      ) : keys.length === 0 ? (
        <p className="text-[13px] text-zinc-600">No keys yet.</p>
      ) : (
        <ul className="space-y-2">
          {keys.map((key) => (
            <li
              key={key.id}
              className="flex flex-wrap items-center gap-3 rounded-lg border border-white/[0.06] bg-white/[0.015] px-4 py-3"
            >
              <span className="text-[13px] text-zinc-200">{key.name}</span>
              <code className="font-mono text-[11px] text-violet-200">{key.prefix}</code>
              <span className="font-mono text-[10px] text-zinc-600">{key.scopes.join(" ")}</span>
              <span className="font-mono text-[10px] text-zinc-700">
                {key.lastUsedAt ? `used ${new Date(key.lastUsedAt).toLocaleDateString()}` : "never used"}
              </span>
              {key.status === "active" ? (
                <button
                  type="button"
                  onClick={() => void revoke(key.id)}
                  className="ml-auto text-[12px] text-zinc-600 transition hover:text-red-300"
                >
                  revoke
                </button>
              ) : (
                <span className="ml-auto font-mono text-[10px] text-zinc-700">{key.status}</span>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function IssuedKey({ secret, onDismiss }: { secret: string; onDismiss: () => void }) {
  const [copied, setCopied] = useState(false)
  return (
    <div className="rounded-xl border border-violet-400/30 bg-violet-500/[0.07] p-4">
      <p className="text-[13px] font-medium text-violet-100">Your key</p>
      <p className="mt-1 text-[12px] text-violet-200/60">
        Only a hash of this is stored. Copy it now — it cannot be shown again.
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <code className="secret min-w-0 flex-1 overflow-x-auto rounded-lg px-3 py-2 font-mono text-[11px] text-violet-100">
          {secret}
        </code>
        <button
          type="button"
          onClick={async () => {
            await navigator.clipboard.writeText(secret)
            setCopied(true)
          }}
          className="rounded-lg border border-violet-400/30 px-3 py-2 text-[12px] text-violet-200 transition hover:bg-violet-400/10"
        >
          {copied ? "copied" : "copy"}
        </button>
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

/* -------------------------------------------------------------------------- */
/* Shared bits                                                                 */
/* -------------------------------------------------------------------------- */

function Metric({
  label,
  value,
  tone = "plain"
}: {
  label: string
  value: string
  tone?: "plain" | "warn"
}) {
  return (
    <div className="rounded-lg border border-white/[0.06] bg-white/[0.015] px-4 py-3">
      <p className="font-mono text-[9px] uppercase tracking-widest text-zinc-600">{label}</p>
      <p className={`mt-1 text-xl ${tone === "warn" ? "text-amber-300" : "text-zinc-200"}`}>{value}</p>
    </div>
  )
}

function Chip({
  children,
  onClick,
  disabled,
  tone = "plain"
}: {
  children: React.ReactNode
  onClick: () => void
  disabled?: boolean
  tone?: "plain" | "danger"
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`rounded border border-white/10 px-2 py-0.5 font-mono text-[10px] transition disabled:opacity-40 ${
        tone === "danger"
          ? "text-zinc-600 hover:border-red-400/40 hover:text-red-300"
          : "text-zinc-500 hover:border-white/25 hover:text-zinc-200"
      }`}
    >
      {children}
    </button>
  )
}
