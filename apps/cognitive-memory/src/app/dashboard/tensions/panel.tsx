"use client"

import { useState } from "react"

import { sendJson, useResource, type Tension } from "../data"
import {
  Badge,
  Button,
  Empty,
  Failure,
  Field,
  Grid,
  Loading,
  Metric,
  PageHeader,
  Segmented,
  inputClass
} from "../ui"

/**
 * Contradictions, active and resolved.
 *
 * Resolved ones are kept on the page because the pattern from a resolution is
 * usually the reusable part — "ask which host before shipping" survives the
 * contradiction it came from, and a list that only shows what is still broken
 * throws that away the moment somebody fixes it.
 *
 * Every active tension is injected into every prompt, whether the current turn
 * has anything to do with it. That is deliberate (a contradiction is a prompt to
 * clarify, not trivia) and it is why `critical` is worth clearing first: it is
 * the most likely thing in the whole index to be wrong in a way that matters.
 */

type Filter = "active" | "latent" | "resolved" | "all"

const FILTERS: ReadonlyArray<{ value: Filter; label: string }> = [
  { value: "active", label: "active" },
  { value: "latent", label: "latent" },
  { value: "resolved", label: "resolved" },
  { value: "all", label: "all" }
]

export function TensionsPanel() {
  const [filter, setFilter] = useState<Filter>("active")
  const [adding, setAdding] = useState(false)
  const url = filter === "all" ? "/api/dashboard/tensions" : `/api/dashboard/tensions?status=${filter}`
  const { data, error, loading, reload } = useResource<{ tensions: Array<Tension> }>(url)

  const tensions = data?.tensions ?? []
  const counts = {
    active: tensions.filter((tension) => tension.status === "active").length,
    critical: tensions.filter((tension) => tension.status === "active" && tension.impact === "critical")
      .length,
    resolved: tensions.filter((tension) => tension.status === "resolved").length
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Tensions"
        description={
          <>
            Two claims that cannot both be true. Each is written into every prompt with
            the question to ask, until somebody resolves it. A flat list of facts has
            nowhere to put this.
          </>
        }
        actions={
          <>
            <Segmented value={filter} options={FILTERS} onChange={setFilter} />
            <Button variant="primary" onClick={() => setAdding((value) => !value)}>
              {adding ? "Cancel" : "Record one"}
            </Button>
          </>
        }
      />

      {adding && <AddTension onDone={() => { setAdding(false); reload() }} />}

      <Grid cols={4}>
        <Metric
          label="active"
          value={counts.active}
          hint="injected into every prompt"
          tone={counts.active > 0 ? "warn" : "plain"}
        />
        <Metric
          label="critical"
          value={counts.critical}
          hint="resolve these first"
          tone={counts.critical > 0 ? "bad" : "plain"}
        />
        <Metric label="resolved" value={counts.resolved} hint="kept as patterns" />
        <Metric
          label="budget cost"
          value={counts.active === 0 ? "0" : `${counts.active} line${counts.active === 1 ? "" : "s"}`}
          hint="always on, full body"
        />
      </Grid>

      {error !== null ? (
        <Failure message={error} onRetry={reload} />
      ) : loading && tensions.length === 0 ? (
        <Loading />
      ) : tensions.length === 0 ? (
        <Empty title={filter === "resolved" ? "Nothing resolved yet" : "Nothing unresolved"}>
          <p>
            Contradictions are recorded by the agent during a turn, or by hand. If a claim
            arrives that cannot be true alongside something already held, it lands here
            instead of quietly overwriting it.
          </p>
        </Empty>
      ) : (
        <ul className="space-y-2">
          {tensions.map((tension) => (
            <TensionRow key={tension.id} tension={tension} onChanged={reload} />
          ))}
        </ul>
      )}
    </div>
  )
}

function TensionRow({ tension, onChanged }: { tension: Tension; onChanged: () => void }) {
  const [busy, setBusy] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const resolved = tension.status === "resolved"

  const send = async (request: () => Promise<unknown>) => {
    setBusy(true)
    try {
      await request()
      onChanged()
    } finally {
      setBusy(false)
    }
  }

  const resolve = () => {
    const pattern = window.prompt(
      "Which claim won, and what is the reusable part of this?",
      ""
    )
    if (pattern === null) return
    void send(() =>
      sendJson(`/api/dashboard/tensions/${tension.id}`, "POST", {
        resolvedBy: "dashboard",
        pattern
      })
    )
  }

  return (
    <li
      className={`rounded-lg border px-4 py-3 ${
        resolved
          ? "border-white/[0.06] bg-white/[0.015]"
          : tension.impact === "critical"
            ? "border-red-300/20 bg-red-300/[0.05]"
            : "border-amber-300/15 bg-amber-300/[0.04]"
      }`}
    >
      <div className="flex flex-wrap items-baseline gap-2">
        <Badge tone={resolved ? "neutral" : tension.impact === "critical" ? "red" : "amber"}>
          {resolved ? "resolved" : tension.impact}
        </Badge>
        <span className={resolved ? "text-[13px] text-zinc-500 line-through" : "text-[13px] text-amber-50/90"}>
          “{tension.claimA.statement}”
        </span>
        <span className="text-zinc-600">conflicts with</span>
        <span className={resolved ? "text-[13px] text-zinc-500 line-through" : "text-[13px] text-amber-50/90"}>
          “{tension.claimB.statement}”
        </span>
      </div>

      <p className="mt-2 text-[11px] text-amber-200/60">Ask: {tension.actionableQuestion}</p>

      {resolved && (tension.pattern !== undefined || tension.resolvedBy !== undefined) && (
        <div className="mt-2 rounded-md border border-white/[0.06] bg-black/20 px-3 py-2">
          <p className="font-mono text-[9px] uppercase tracking-widest text-zinc-700">pattern</p>
          <p className="mt-0.5 text-[12px] leading-5 text-zinc-400">
            {tension.pattern === undefined || tension.pattern === "" ? "—" : tension.pattern}
          </p>
          <p className="mt-1 font-mono text-[9px] text-zinc-700">resolved by {tension.resolvedBy ?? "unknown"}</p>
        </div>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-1.5">
        {!resolved && (
          <Button size="sm" disabled={busy} onClick={resolve}>
            Resolve
          </Button>
        )}
        <Button size="sm" variant="quiet" disabled={busy} onClick={() => setExpanded((value) => !value)}>
          {expanded ? "less" : "more"}
        </Button>
        {resolved && (
          <Button
            size="sm"
            variant="quiet"
            disabled={busy}
            onClick={() => void send(() => sendJson(`/api/dashboard/tensions/${tension.id}`, "PATCH", { status: "active" }))}
          >
            reopen
          </Button>
        )}
        <span className="ml-auto flex gap-1.5">
          <Button
            size="sm"
            variant="danger"
            disabled={busy}
            onClick={() => {
              if (!window.confirm("Discard this contradiction entirely? Both claims stay as memories."))
                return
              void send(() => sendJson(`/api/dashboard/tensions/${tension.id}`, "DELETE"))
            }}
          >
            discard
          </Button>
        </span>
      </div>

      {expanded && (
        <dl className="mt-3 space-y-1 border-t border-white/[0.06] pt-3 font-mono text-[10px] text-zinc-600">
          <div className="flex gap-2">
            <dt className="w-20 shrink-0 text-zinc-700">claim a</dt>
            <dd>
              {tension.claimA.source} · {new Date(tension.claimA.timestamp).toLocaleString()}
            </dd>
          </div>
          <div className="flex gap-2">
            <dt className="w-20 shrink-0 text-zinc-700">claim b</dt>
            <dd>
              {tension.claimB.source} · {new Date(tension.claimB.timestamp).toLocaleString()}
            </dd>
          </div>
          <div className="flex gap-2">
            <dt className="w-20 shrink-0 text-zinc-700">id</dt>
            <dd className="truncate">{tension.id}</dd>
          </div>
        </dl>
      )}
    </li>
  )
}

function AddTension({ onDone }: { onDone: () => void }) {
  const [claimA, setClaimA] = useState("")
  const [claimB, setClaimB] = useState("")
  const [impact, setImpact] = useState<"low" | "medium" | "critical">("medium")
  const [question, setQuestion] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  return (
    <form
      onSubmit={async (event) => {
        event.preventDefault()
        setBusy(true)
        setError(null)
        try {
          await sendJson("/api/dashboard/tensions", "POST", {
            claimA,
            claimB,
            impact,
            actionableQuestion: question
          })
          onDone()
        } catch (cause) {
          setError(cause instanceof Error ? cause.message : "Could not record that.")
          setBusy(false)
        }
      }}
      className="grid gap-3 rounded-xl border border-white/[0.08] bg-white/[0.02] p-4 lg:grid-cols-2"
    >
      <Field label="claim a" hint="What is asserted.">
        <input
          value={claimA}
          onChange={(event) => setClaimA(event.target.value)}
          placeholder="We deploy on Fridays"
          className={inputClass}
          required
        />
      </Field>
      <Field label="claim b" hint="What cannot be true alongside it.">
        <input
          value={claimB}
          onChange={(event) => setClaimB(event.target.value)}
          placeholder="We never deploy on Fridays"
          className={inputClass}
          required
        />
      </Field>
      <Field label="impact" hint="Critical means injected everywhere and worth clearing first.">
        <Segmented
          value={impact}
          onChange={setImpact}
          options={[
            { value: "low", label: "low" },
            { value: "medium", label: "medium" },
            { value: "critical", label: "critical" }
          ]}
        />
      </Field>
      <Field label="question to ask" hint="The line that goes into the prompt. Make it answerable.">
        <input
          value={question}
          onChange={(event) => setQuestion(event.target.value)}
          placeholder="Which day do we actually deploy?"
          className={inputClass}
          required
        />
      </Field>
      <div className="flex items-center gap-3 lg:col-span-2">
        <Button type="submit" variant="primary" disabled={busy}>
          {busy ? "Recording…" : "Record"}
        </Button>
        {error !== null && <span className="text-[12px] text-red-300">{error}</span>}
      </div>
    </form>
  )
}