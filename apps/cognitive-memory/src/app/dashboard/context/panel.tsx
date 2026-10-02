"use client"

import Link from "next/link"
import { useEffect, useState } from "react"

import { sendJson, useResource, type Overview, type PreviewResponse } from "../data"
import {
  Badge,
  Button,
  Code,
  Failure,
  Grid,
  Metric,
  PageHeader,
  Panel,
  TierBadge
} from "../ui"

/**
 * Show the exact block an agent would be given, for any message typed here.
 *
 * The point is falsifiability. A log line saying memory was injected does not let
 * you check whether it was the *right* memory; the text does, and so does the
 * per-line reason and token cost. It is also the fastest way to see the effect of
 * a budget change: raise the ceiling on the settings page, come back here, and
 * watch which bodies stop being dropped.
 *
 * Nothing is recorded by a preview. It costs nothing and stores nothing, which is
 * why it is worth having in the dashboard rather than behind a key.
 */

const REASON_COPY: Record<string, string> = {
  index: "indexed — a gist line, because nothing referred to it",
  trigger: "a concrete identifier you named matched this",
  tension: "an unresolved contradiction",
  guardrail: "a domain this agent has been unreliable in"
}

const EXAMPLES: ReadonlyArray<{ label: string; message: string }> = [
  { label: "an identifier", message: "deploy ZQ7X4M2K to the internal staging host" },
  { label: "a correction", message: "actually we do run migrations on Fridays, that changed" },
  { label: "a weak domain", message: "write the migration for the billing table" }
]

export function ContextPanel() {
  const [message, setMessage] = useState(EXAMPLES[0]?.message ?? "")
  const [preview, setPreview] = useState<PreviewResponse | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const { data: overview } = useResource<Overview>("/api/dashboard/overview")

  // A bare fetch, so both callers can decide when to set state: the mount effect
  // updates only in the continuation, while the form can also flip a busy flag.
  const fetchPreview = (value: string): Promise<PreviewResponse | null> =>
    sendJson<PreviewResponse>("/api/dashboard/preview", "POST", { userMessage: value }).catch(() => null)

  const run = (value: string) => {
    setBusy(true)
    setError(null)
    void fetchPreview(value).then((body) => {
      setPreview(body)
      if (body === null) setError("Could not build a preview. Is the session still valid?")
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

  const budget = overview?.budget.effective.maxTotalTokens
  const overBudget = preview !== null && budget !== undefined && preview.totalTokens >= budget * 0.9

  return (
    <div className="space-y-6">
      <PageHeader
        title="Context"
        description={
          <>
            The block this service prepends to a system prompt, for the message you
            type below. Every line is labelled with the rule that earned it and what it
            cost, because an injection you cannot check is an injection you cannot tune.
          </>
        }
      />

      <form
        onSubmit={(event) => {
          event.preventDefault()
          run(message)
        }}
        className="space-y-2"
      >
        <div className="flex flex-wrap gap-2">
          <input
            value={message}
            onChange={(event) => setMessage(event.target.value)}
            placeholder="a message your agent is about to answer"
            className="min-w-0 flex-1 rounded-lg border border-white/10 bg-white/[0.03] px-3.5 py-2.5 text-[13px] outline-none transition placeholder:text-zinc-700 focus:border-violet-400/50"
          />
          <Button type="submit" variant="primary" disabled={busy}>
            {busy ? "Building…" : "Preview"}
          </Button>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="font-mono text-[9px] uppercase tracking-widest text-zinc-700">try</span>
          {EXAMPLES.map((example) => (
            <button
              key={example.label}
              type="button"
              onClick={() => {
                setMessage(example.message)
                run(example.message)
              }}
              className="rounded border border-white/10 px-2 py-0.5 font-mono text-[10px] text-zinc-500 transition hover:border-white/25 hover:text-zinc-200"
            >
              {example.label}
            </button>
          ))}
        </div>
      </form>

      {error !== null && <Failure message={error} />}

      {preview && (
        <>
          <Grid cols={4}>
            <Metric
              label="tokens"
              value={preview.totalTokens.toLocaleString()}
              hint={budget === undefined ? undefined : `of ${budget} allowed`}
              tone={overBudget ? "warn" : "plain"}
            />
            <Metric label="entries" value={String(preview.entries.length)} />
            <Metric
              label="bodies included"
              value={String(preview.entries.filter((entry) => entry.body !== undefined).length)}
              hint="promoted by a trigger"
            />
            <Metric
              label="index lines"
              value={String(
                preview.entries.filter((entry) => entry.body === undefined).length
              )}
              hint="gist only, cheap"
            />
          </Grid>

          {preview.truncated && (
            <p className="rounded-lg border border-amber-300/20 bg-amber-300/[0.05] px-4 py-2.5 text-[12px] leading-5 text-amber-100/90">
              The budget cut this block short. That is reported rather than hidden
              because a truncated index is the difference between a useful prompt and a
              misleading one.{" "}
              <Link
                href="/dashboard/settings"
                className="underline decoration-amber-200/30 underline-offset-2"
              >
                Raise the ceiling
              </Link>{" "}
              if the dropped lines are the ones that matter.
            </p>
          )}

          <div className="grid gap-4 lg:grid-cols-[1fr_320px]">
            <div className={`overflow-hidden rounded-xl border border-white/[0.08]`}>
              <div className="flex items-center justify-between border-b border-white/[0.06] px-4 py-2">
                <span className="font-mono text-[10px] uppercase tracking-widest text-zinc-600">
                  prompt block
                </span>
                {preview.truncated && (
                  <span className="text-[10px] text-amber-300/80">truncated by the token budget</span>
                )}
              </div>
              {preview.text.trim() === "" ? (
                <p className="px-4 py-6 text-[13px] text-zinc-600">
                  Nothing to inject yet. Store something, or learn from a turn.
                </p>
              ) : (
                <Code className="!border-0 !bg-transparent">{preview.text}</Code>
              )}
            </div>

            <div className="space-y-4">
              <Panel title="Identifiers found" hint="What the message named, and therefore what could earn a full body.">
                {preview.identifiers.length === 0 ? (
                  <p className="text-xs leading-5 text-zinc-600">
                    None, so nothing earns a full body. Name a build id, a host or a path
                    to see the trigger fire.
                  </p>
                ) : (
                  <ul className="flex flex-wrap gap-1.5">
                    {preview.identifiers.map((identifier) => (
                      <li key={identifier}>
                        <Badge tone="violet">{identifier}</Badge>
                      </li>
                    ))}
                  </ul>
                )}
              </Panel>

              <Panel title="Why each line" hint="The rule that put it there, and what it cost.">
                <ul className="space-y-2.5">
                  {preview.entries.map((entry) => (
                    <li key={entry.id}>
                      <div className="flex items-baseline gap-2">
                        <TierBadge tier={entry.tier} />
                        <code className="rounded bg-white/[0.06] px-1.5 py-0.5 font-mono text-[9px] text-zinc-400">
                          {entry.reason}
                        </code>
                        <span className="ml-auto font-mono text-[9px] text-zinc-700">
                          {entry.tokens} tok
                        </span>
                      </div>
                      <p className="mt-1 text-[11px] leading-4 text-zinc-400">{entry.gist}</p>
                      <p className="text-[10px] leading-4 text-zinc-700">
                        {REASON_COPY[entry.reason] ?? "included"}
                      </p>
                    </li>
                  ))}
                </ul>
              </Panel>
            </div>
          </div>
        </>
      )}
    </div>
  )
}