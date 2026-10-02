"use client"

import { useCallback, useEffect, useMemo, useState } from "react"

import {
  sendJson,
  useResource,
  type LearnResponse,
  type MemoryPageResponse,
  type MemoryRow,
  type RecallResponse
} from "../data"
import {
  Button,
  Empty,
  Failure,
  Field,
  Loading,
  PageHeader,
  Panel,
  Segmented,
  Table,
  Td,
  Th,
  TierBadge,
  inputClass
} from "../ui"

/**
 * The library.
 *
 * Searching, filtering and paging happen on the server, because the whole point
 * of the tiers is that a store can be large — a browser that had to be shipped
 * every memory to show fifty of them would make "a large store is cheap" false in
 * a second, much more visible way than the token savings are worth.
 *
 * Selection is explicit rather than implicit. Bulk actions are the ones that
 * hurt when they are wrong, and "select all on this page" that quietly forgets
 * page two is how a store gets half-deleted by someone in a hurry.
 */

type Sort = "recent" | "created" | "accessed" | "alpha"

const PAGE_SIZE = 50

const SORTS: ReadonlyArray<{ value: Sort; label: string }> = [
  { value: "recent", label: "recently used" },
  { value: "created", label: "newest" },
  { value: "accessed", label: "most used" },
  { value: "alpha", label: "A–Z" }
]

export function MemoryPanel() {
  const [query, setQuery] = useState("")
  const [tiers, setTiers] = useState<Array<string>>([])
  const [domain, setDomain] = useState("")
  const [source, setSource] = useState("")
  const [sort, setSort] = useState<Sort>("recent")
  const [offset, setOffset] = useState(0)
  const [selected, setSelected] = useState<Array<string>>([])
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  const [editing, setEditing] = useState<MemoryRow | null>(null)

  const url = useMemo(() => {
    const search = new URLSearchParams()
    if (query.trim() !== "") search.set("q", query.trim())
    for (const tier of tiers) search.append("tier", tier)
    if (domain !== "") search.set("domain", domain)
    if (source !== "") search.set("source", source)
    search.set("sort", sort)
    search.set("limit", String(PAGE_SIZE))
    search.set("offset", String(offset))
    return `/api/dashboard/memories?${search.toString()}`
  }, [query, tiers, domain, source, sort, offset])

  const { data, error, loading, reload } = useResource<MemoryPageResponse>(url)

  // Typing should not fire a query per keystroke, and the offset is meaningless
  // once the result set has changed underneath it.
  useEffect(() => {
    const timer = setTimeout(() => setOffset(0), 250)
    return () => clearTimeout(timer)
  }, [query, tiers, domain, source])

  /**
   * Run a change, then say what it did.
   *
   * The reload lives here so no caller can forget it: a library that says
   * "stored" and still shows the old list is worse than one that says nothing.
   */
  const act = useCallback(
    async (run: () => Promise<string | null>) => {
      setBusy(true)
      setNotice(null)
      try {
        const message = await run()
        reload()
        setNotice(message ?? "Done.")
      } catch (cause) {
        setNotice(cause instanceof Error ? cause.message : "That did not work.")
      } finally {
        setBusy(false)
      }
    },
    [reload]
  )

  const rows = data?.memories ?? []
  const onPage = selected.length > 0 && rows.every((row) => selected.includes(row.id))

  const toggleTier = (tier: string) =>
    setTiers((current) =>
      current.includes(tier) ? current.filter((value) => value !== tier) : [...current, tier]
    )

  const bulk = async (action: "promote" | "demote" | "archive" | "forget") => {
    if (action === "forget" && !window.confirm(`Forget ${selected.length} memories? This cannot be undone.`))
      return
    await act(async () => {
      const body = await sendJson<{ affected: number }>("/api/dashboard/memories/bulk", "POST", {
        ids: selected,
        action
      })
      setSelected([])
      const verb = action === "forget" ? "forgotten" : `moved to ${action}`
      return `${body.affected} ${body.affected === 1 ? "memory" : "memories"} ${verb}.`
    })
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Memory library"
        description={
          <>
            Everything this organisation has been told. L1 is written into every prompt as
            an index line; L2 and L3 cost nothing until something promotes or recalls
            them, so a large store is not an expensive one.
          </>
        }
        actions={
          <Button variant="primary" onClick={() => setAdding((value) => !value)}>
            {adding ? "Cancel" : "Remember something"}
          </Button>
        }
      />

      {adding && (
        <AddMemory
          busy={busy}
          onSubmit={(items, sessionId) =>
            act(async () => {
              const body = await sendJson<LearnResponse>("/api/dashboard/memories", "POST", {
                items,
                ...(sessionId === "" ? {} : { sessionId })
              })
              setAdding(false)
              if (body.rejected.length > 0) {
                return `Stored ${body.counts.stored}. Refused: ${body.rejected[0]?.reason ?? "unknown"}`
              }
              if (body.counts.stored === 0 && body.counts.merged > 0) {
                return `Already known — folded into ${body.counts.merged} existing ${
                  body.counts.merged === 1 ? "memory" : "memories"
                }.`
              }
              return `Stored ${body.counts.stored}.`
            })
          }
        />
      )}

      {notice !== null && (
        <div className="flex items-center justify-between gap-3 rounded-lg border border-white/[0.08] bg-white/[0.02] px-4 py-2.5">
          <p className="text-[12px] text-zinc-400">{notice}</p>
          <button
            type="button"
            onClick={() => setNotice(null)}
            className="text-[11px] text-zinc-600 hover:text-zinc-300"
          >
            dismiss
          </button>
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-[220px_1fr]">
        <aside className="space-y-4">
          <Panel title="Filters">
            <div className="space-y-3">
              <Field label="tier">
                <div className="flex flex-wrap gap-1">
                  {["L0", "L1", "L2", "L3"].map((tier) => (
                    <button
                      key={tier}
                      type="button"
                      onClick={() => toggleTier(tier)}
                      className={`rounded border px-2 py-0.5 font-mono text-[10px] transition ${
                        tiers.includes(tier)
                          ? "border-violet-400/40 bg-violet-400/10 text-violet-200"
                          : "border-white/10 text-zinc-500 hover:border-white/25 hover:text-zinc-200"
                      }`}
                    >
                      {tier}
                    </button>
                  ))}
                </div>
              </Field>

              {data !== null && (
                <>
                  <Field label="domain">
                    <select
                      value={domain}
                      onChange={(event) => setDomain(event.target.value)}
                      className={inputClass}
                    >
                      <option value="">any domain</option>
                      {data.facets.domains.map((entry) => (
                        <option key={entry.name} value={entry.name} className="bg-[#0e0e13]">
                          {entry.name} ({entry.count})
                        </option>
                      ))}
                    </select>
                  </Field>

                  <Field label="source">
                    <select
                      value={source}
                      onChange={(event) => setSource(event.target.value)}
                      className={inputClass}
                    >
                      <option value="">any source</option>
                      {Object.entries(data.facets.sources).map(([name, count]) => (
                        <option key={name} value={name} className="bg-[#0e0e13]">
                          {name} ({count})
                        </option>
                      ))}
                    </select>
                  </Field>
                </>
              )}

              {(tiers.length > 0 || domain !== "" || source !== "" || query !== "") && (
                <Button
                  size="sm"
                  onClick={() => {
                    setTiers([])
                    setDomain("")
                    setSource("")
                    setQuery("")
                  }}
                >
                  clear filters
                </Button>
              )}
            </div>
          </Panel>

          <RecallInspector />
        </aside>

        <div className="min-w-0 space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="search content, gist or domains"
              className="min-w-0 flex-1 rounded-lg border border-white/10 bg-white/[0.03] px-3.5 py-2 text-[13px] outline-none transition placeholder:text-zinc-700 focus:border-violet-400/50"
            />
            <Segmented value={sort} options={SORTS} onChange={setSort} />
          </div>

          {selected.length > 0 && (
            <div className="flex flex-wrap items-center gap-2 rounded-lg border border-violet-400/25 bg-violet-500/[0.06] px-3.5 py-2">
              <span className="text-[12px] text-violet-100">{selected.length} selected</span>
              <span className="flex gap-1.5">
                <Button size="sm" disabled={busy} onClick={() => void bulk("promote")}>
                  promote to L1
                </Button>
                <Button size="sm" disabled={busy} onClick={() => void bulk("demote")}>
                  demote to L2
                </Button>
                <Button size="sm" disabled={busy} onClick={() => void bulk("archive")}>
                  archive
                </Button>
                <Button size="sm" variant="danger" disabled={busy} onClick={() => void bulk("forget")}>
                  forget
                </Button>
              </span>
              <button
                type="button"
                onClick={() => setSelected([])}
                className="ml-auto text-[11px] text-zinc-500 hover:text-zinc-300"
              >
                clear
              </button>
            </div>
          )}

          {error !== null ? (
            <Failure message={error} onRetry={reload} />
          ) : loading && rows.length === 0 ? (
            <Loading />
          ) : rows.length === 0 ? (
            <Empty title="No memory matches">
              <p>
                Either nothing is stored yet, or the filters are narrower than the store.
                Clear them, or{" "}
                <button
                  type="button"
                  onClick={() => {
                    setTiers([])
                    setDomain("")
                    setSource("")
                    setQuery("")
                  }}
                  className="text-violet-300 underline underline-offset-2"
                >
                  reset the filters
                </button>
                .
              </p>
            </Empty>
          ) : (
            <>
              <div className="overflow-hidden rounded-xl border border-white/[0.08]">
                <Table
                  head={
                    <>
                      <Th className="w-8">
                        <input
                          type="checkbox"
                          aria-label="select this page"
                          checked={onPage}
                          onChange={(event) =>
                            setSelected(
                              event.target.checked
                                ? [...new Set([...selected, ...rows.map((row) => row.id)])]
                                : selected.filter((id) => !rows.some((row) => row.id === id))
                            )
                          }
                          className="accent-violet-500"
                        />
                      </Th>
                      <Th>tier</Th>
                      <Th>memory</Th>
                      <Th>domains</Th>
                      <Th className="text-right" title="Times it was put in front of a model">used</Th>
                      <Th className="text-right">last</Th>
                      <Th />
                    </>
                  }
                >
                  {rows.map((memory) => (
                    <tr key={memory.id} className="transition hover:bg-white/[0.02]">
                      <Td>
                        <input
                          type="checkbox"
                          aria-label="select"
                          checked={selected.includes(memory.id)}
                          onChange={(event) =>
                            setSelected(
                              event.target.checked
                                ? [...selected, memory.id]
                                : selected.filter((id) => id !== memory.id)
                            )
                          }
                          className="accent-violet-500"
                        />
                      </Td>
                      <Td>
                        <TierBadge tier={memory.tier} />
                      </Td>
                      <Td className="max-w-md">
                        <span className="block truncate text-zinc-300">{memory.content}</span>
                        {memory.gist !== undefined && memory.gist !== "" && (
                          <span className="block truncate font-mono text-[10px] text-zinc-700">
                            {memory.gist}
                          </span>
                        )}
                      </Td>
                      <Td>
                        <span className="flex flex-wrap gap-1">
                          {memory.domains.slice(0, 2).map((value) => (
                            <span key={value} className="font-mono text-[9px] text-zinc-600">
                              {value}
                            </span>
                          ))}
                        </span>
                      </Td>
                      <Td className="text-right font-mono text-[11px] text-zinc-500">
                        {memory.accessCount}×
                      </Td>
                      <Td className="text-right font-mono text-[10px] text-zinc-700">
                        {relative(memory.lastAccessedAt)}
                      </Td>
                      <Td>
                        <Button size="sm" variant="quiet" onClick={() => setEditing(memory)}>
                          edit
                        </Button>
                      </Td>
                    </tr>
                  ))}
                </Table>
              </div>

              <div className="flex flex-wrap items-center justify-between gap-2 font-mono text-[10px] text-zinc-600">
                <span>
                  {offset + 1}–{Math.min(offset + rows.length, data?.total ?? 0)} of {data?.total ?? 0}
                </span>
                <span className="flex gap-1.5">
                  <Button size="sm" disabled={offset === 0} onClick={() => setOffset(Math.max(offset - PAGE_SIZE, 0))}>
                    previous
                  </Button>
                  <Button
                    size="sm"
                    disabled={offset + rows.length >= (data?.total ?? 0)}
                    onClick={() => setOffset(offset + PAGE_SIZE)}
                  >
                    next
                  </Button>
                </span>
              </div>
            </>
          )}
        </div>
      </div>

      {editing !== null && (
        <EditMemory
          memory={editing}
          onClose={() => setEditing(null)}
          onSaved={(message) => {
            setEditing(null)
            void act(async () => message)
          }}
        />
      )}
    </div>
  )
}

/**
 * Why this matched, for a query you type.
 *
 * Sits beside the library rather than inside it because the two questions are
 * different: "what is stored" and "why did that get retrieved". Ranking is token
 * overlap, so the terms are nameable — a bad hit is usually "it matched on
 * `test`", which is fixable, rather than "the cosine said 0.4", which is not.
 */
function RecallInspector() {
  const [query, setQuery] = useState("")
  const [result, setResult] = useState<RecallResponse | null>(null)
  const [busy, setBusy] = useState(false)

  const run = () => {
    if (query.trim() === "") return
    setBusy(true)
    void sendJson<RecallResponse>("/api/dashboard/recall", "POST", { query, limit: 5 })
      .then(setResult)
      .catch(() => setResult(null))
      .finally(() => setBusy(false))
  }

  return (
    <Panel title="Why did this match?" hint="Rank the store against a query and name the overlapping terms.">
      <div className="flex gap-1.5">
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") run()
          }}
          placeholder="what is the agent about to ask?"
          className={inputClass}
        />
        <Button size="sm" onClick={run} disabled={busy}>
          {busy ? "…" : "run"}
        </Button>
      </div>

      {result !== null && (
        <ul className="mt-3 space-y-2">
          {result.results.length === 0 && (
            <li className="text-[12px] text-zinc-600">Nothing matched. No terms overlapped.</li>
          )}
          {result.results.map((hit) => (
            <li key={hit.memory.id} className="space-y-1">
              <div className="flex items-baseline justify-between gap-2">
                <TierBadge tier={hit.memory.tier} />
                <span className="font-mono text-[10px] text-zinc-600">{hit.score.toFixed(3)}</span>
              </div>
              <p className="text-[12px] leading-4 text-zinc-400">{hit.memory.content}</p>
              <p className="flex flex-wrap gap-1">
                {hit.matched.slice(0, 8).map((token) => (
                  <span key={token} className="font-mono text-[9px] text-emerald-300/70">
                    {token}
                  </span>
                ))}
              </p>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  )
}

function AddMemory({
  onSubmit,
  busy
}: {
  onSubmit: (items: ReadonlyArray<{ content: string; domains: ReadonlyArray<string> }>, sessionId: string) => Promise<void>
  busy: boolean
}) {
  const [content, setContent] = useState("")
  const [domains, setDomains] = useState("")
  const [sessionId, setSessionId] = useState("")

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault()
        void onSubmit(
          [{ content, domains: domains.split(",").map((value) => value.trim()).filter(Boolean) }],
          sessionId.trim()
        )
      }}
      className="grid gap-3 rounded-xl border border-white/[0.08] bg-white/[0.02] p-4 lg:grid-cols-[2fr_1fr_1fr_auto] lg:items-end"
    >
      <Field label="what is true" hint="One self-contained sentence. No pronouns from this conversation.">
        <input
          value={content}
          onChange={(event) => setContent(event.target.value)}
          placeholder="e.g. the staging database is db-stg-01.internal:5432"
          className={inputClass}
          required
        />
      </Field>
      <Field label="domains" hint="Comma separated. Optional.">
        <input
          value={domains}
          onChange={(event) => setDomains(event.target.value)}
          placeholder="database, deploy"
          className={inputClass}
        />
      </Field>
      <Field label="session" hint="Groups memories from one conversation. Optional.">
        <input
          value={sessionId}
          onChange={(event) => setSessionId(event.target.value)}
          className={inputClass}
        />
      </Field>
      <Button type="submit" variant="primary" disabled={busy}>
        Store
      </Button>
    </form>
  )
}

/**
 * Editing a memory in place.
 *
 * A modal because the edit is a correction to something that ends up in every
 * future prompt: it should take a deliberate moment, not be reachable by
 * mis-clicking a row. The tier control is separate from the text because they
 * are different decisions — "this is true" and "this belongs in every prompt".
 */
function EditMemory({
  memory,
  onSaved,
  onClose
}: {
  memory: MemoryRow
  onSaved: (message: string) => void
  onClose: () => void
}) {
  const [content, setContent] = useState(memory.content)
  const [gist, setGist] = useState(memory.gist ?? "")
  const [domains, setDomains] = useState(memory.domains.join(", "))
  const [tier, setTier] = useState(memory.tier)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const save = async () => {
    setBusy(true)
    setError(null)
    try {
      await sendJson(`/api/dashboard/memories/${memory.id}`, "PATCH", {
        content,
        gist,
        domains: domains.split(",").map((value) => value.trim()).filter(Boolean),
        tier
      })
      onSaved("Memory updated.")
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save.")
      setBusy(false)
    }
  }

  return (
    <div className="fixed inset-0 z-40 flex items-start justify-center overflow-y-auto bg-black/60 p-6">
      <div className="mt-16 w-full max-w-2xl space-y-4 rounded-xl border border-white/10 bg-[#0e0e13] p-5">
        <div className="flex items-baseline justify-between gap-3">
          <h2 className="text-[15px] font-medium">Edit memory</h2>
          <span className="font-mono text-[10px] text-zinc-700">
            used {memory.accessCount}× · created {relative(memory.createdAt)}
          </span>
        </div>

        <Field label="content" hint="What the agent will be told. Rewriting does not reset its history.">
          <textarea
            value={content}
            onChange={(event) => setContent(event.target.value)}
            rows={4}
            className={`${inputClass} resize-y leading-5`}
          />
        </Field>

        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="gist" hint="The index line. Falls back to a truncation when empty.">
            <input value={gist} onChange={(event) => setGist(event.target.value)} className={inputClass} />
          </Field>
          <Field label="domains" hint="Comma separated.">
            <input
              value={domains}
              onChange={(event) => setDomains(event.target.value)}
              className={inputClass}
            />
          </Field>
        </div>

        <Field label="tier" hint="L1 is in every prompt; L2 and L3 are not.">
          <Segmented
            value={tier}
            onChange={setTier}
            options={["L0", "L1", "L2", "L3"].map((value) => ({ value, label: value }))}
          />
        </Field>

        {error !== null && <Failure message={error} />}

        <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
          <Button
            variant="danger"
            disabled={busy}
            onClick={async () => {
              if (!window.confirm("Forget this memory? It cannot be recovered.")) return
              setBusy(true)
              try {
                await sendJson(`/api/dashboard/memories/${memory.id}`, "DELETE")
                onSaved("Memory forgotten.")
              } catch (cause) {
                setError(cause instanceof Error ? cause.message : "Could not forget.")
                setBusy(false)
              }
            }}
          >
            Forget
          </Button>
          <span className="flex gap-2">
            <Button onClick={onClose}>Cancel</Button>
            <Button variant="primary" disabled={busy} onClick={() => void save()}>
              {busy ? "Saving…" : "Save"}
            </Button>
          </span>
        </div>
      </div>
    </div>
  )
}

const relative = (ms: number): string => {
  const seconds = Math.max(1, Math.round((Date.now() - ms) / 1000))
  if (seconds < 60) return `${seconds}s ago`
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.round(hours / 24)
  if (days < 30) return `${days}d ago`
  return new Date(ms).toLocaleDateString()
}