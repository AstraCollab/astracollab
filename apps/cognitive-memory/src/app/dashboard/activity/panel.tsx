"use client"

import { useEffect, useState } from "react"

import { getJson, type InjectionEvent } from "../data"
import {
  Badge,
  Button,
  Code,
  Empty,
  Failure,
  Grid,
  Loading,
  Metric,
  PageHeader,
  Panel,
  TierBadge
} from "../ui"

/**
 * The audit trail.
 *
 * Every context build, with the block that was actually sent — not the one the
 * planner would produce today. That distinction is the whole reason this log
 * exists: re-running the planner against current memory answers "what would the
 * agent get now", which is a much better-looking answer than the one that caused
 * the thing you are trying to understand.
 *
 * The triggering message is deliberately absent. That is the conversation, not
 * the memory, and it belongs to whoever sent it. The identifiers inside it are
 * kept, because those are what explain why a full body was spent.
 */

interface ActivityResponse {
  events: Array<InjectionEvent>
  nextCursor: string | null
}

const REASON_COPY: Record<string, string> = {
  index: "index line",
  trigger: "identifier triggered a full body",
  tension: "unresolved contradiction",
  guardrail: "weak-domain guardrail"
}

export function ActivityPanel() {
  const [events, setEvents] = useState<Array<InjectionEvent> | null>(null)
  const [cursor, setCursor] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [nonce, setNonce] = useState(0)

  const FIRST_PAGE = "/api/dashboard/activity?limit=25"

  // The fetch is inline rather than behind a helper so the effect body only ever
  // touches state from a continuation, which is the shape React's own guidance
  // asks for and the lint rule enforces.
  useEffect(() => {
    let cancelled = false
    void getJson<ActivityResponse>(FIRST_PAGE)
      .then((body) => {
        if (cancelled) return
        setEvents(body.events)
        setCursor(body.nextCursor)
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : "Could not load activity.")
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [nonce])

  /** Older builds, paged by the cursor rather than an offset. */
  const loadMore = async (before: string) => {
    setLoadingMore(true)
    try {
      const body = await getJson<ActivityResponse>(
        `/api/dashboard/activity?limit=25&before=${encodeURIComponent(before)}`
      )
      setEvents((current) => [...(current ?? []), ...body.events])
      setCursor(body.nextCursor)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not load older builds.")
    } finally {
      setLoadingMore(false)
    }
  }

  if (error !== null && events === null) {
    return (
      <Failure
        message={error}
        onRetry={() => {
          setError(null)
          setNonce((value) => value + 1)
        }}
      />
    )
  }
  if (loading && events === null) return <Loading label="Reading the log…" />
  if (events === null) return <Loading />

  const tokens = events.reduce((sum, event) => sum + event.tokens, 0)
  const truncated = events.filter((event) => event.truncated).length

  return (
    <div className="space-y-6">
      <PageHeader
        title="Activity"
        description={
          <>
            Every build an agent has asked for, newest first, with the exact block that was
            sent and the reason each line was included. A count of injections tells you
            something happened; the text tells you whether it was the right thing.
          </>
        }
      />

      <Grid cols={4}>
        <Metric label="builds shown" value={events.length} hint={cursor === null ? "the whole log" : "more below"} />
        <Metric label="tokens shown" value={tokens.toLocaleString()} />
        <Metric
          label="truncated"
          value={truncated}
          tone={truncated > 0 ? "warn" : "plain"}
          hint="hit the ceiling"
        />
        <Metric
          label="keys seen"
          value={new Set(events.map((event) => event.apiKeyId ?? "none")).size}
          hint="distinct callers"
        />
      </Grid>

      {events.length === 0 ? (
        <Empty title="No context builds yet">
          <p>
            A build is recorded every time an agent asks for memory with{" "}
            <code className="text-zinc-400">POST /v1/context</code>, which is what{" "}
            <code className="text-zinc-400">runTurn</code> does before the model runs.
          </p>
        </Empty>
      ) : (
        <>
          <ul className="space-y-2">
            {events.map((event) => (
              <EventRow key={event.id} event={event} />
            ))}
          </ul>

          {cursor !== null && (
            <div className="flex justify-center">
              <Button disabled={loadingMore} onClick={() => void loadMore(cursor)}>
                {loadingMore ? "Loading…" : "Older builds"}
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  )
}

function EventRow({ event }: { event: InjectionEvent }) {
  const [open, setOpen] = useState(false)

  return (
    <li className="overflow-hidden rounded-xl border border-white/[0.08] bg-white/[0.02]">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="flex w-full flex-wrap items-center gap-3 px-4 py-3 text-left transition hover:bg-white/[0.02]"
      >
        <span className="font-mono text-[10px] text-zinc-700">
          {new Date(event.createdAt).toLocaleString(undefined, {
            month: "short",
            day: "numeric",
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit"
          })}
        </span>
        <span className="font-mono text-[11px] text-zinc-400">{event.key?.name ?? "no key"}</span>
        <span className="font-mono text-[10px] text-zinc-700">
          {event.bodies} bodies · {event.indexLines} index
        </span>
        {event.truncated && <Badge tone="amber">truncated</Badge>}
        {event.identifiers.length > 0 && (
          <span className="flex flex-wrap gap-1">
            {event.identifiers.slice(0, 3).map((identifier) => (
              <Badge key={identifier} tone="violet">
                {identifier}
              </Badge>
            ))}
          </span>
        )}
        <span className="ml-auto font-mono text-[11px] tabular-nums text-zinc-400">
          {event.tokens} tok
        </span>
        <span className="font-mono text-[10px] text-zinc-700">{open ? "hide" : "open"}</span>
      </button>

      {open && (
        <div className="grid gap-4 border-t border-white/[0.06] p-4 lg:grid-cols-[1fr_300px]">
          <div className="space-y-2">
            <p className="font-mono text-[9px] uppercase tracking-widest text-zinc-600">
              the block that was sent
            </p>
            {event.text.trim() === "" ? (
              <p className="text-[12px] text-zinc-600">This build injected nothing.</p>
            ) : (
              <Code>{event.text}</Code>
            )}
          </div>

          <div className="space-y-3">
            <Panel title="Line by line" hint={`${event.entries.length} entries, ${event.tokens} tokens`}>
              <ul className="space-y-2">
                {event.entries.map((entry, index) => (
                  <li key={`${entry.id}-${index}`} className="space-y-0.5">
                    <div className="flex items-baseline gap-1.5">
                      <TierBadge tier={entry.tier} />
                      <span className="text-[10px] text-zinc-600">
                        {REASON_COPY[entry.reason] ?? entry.reason}
                      </span>
                      <span className="ml-auto font-mono text-[9px] text-zinc-700">
                        {entry.tokens} tok
                      </span>
                    </div>
                    <p className="text-[11px] leading-4 text-zinc-500">{entry.gist}</p>
                  </li>
                ))}
              </ul>
            </Panel>

            <Panel title="Provenance">
              <dl className="space-y-1.5 font-mono text-[10px]">
                <div className="flex justify-between gap-2">
                  <dt className="text-zinc-700">id</dt>
                  <dd className="truncate text-zinc-600">{event.id}</dd>
                </div>
                <div className="flex justify-between gap-2">
                  <dt className="text-zinc-700">key</dt>
                  <dd className="truncate text-zinc-600">{event.key?.prefix ?? "—"}</dd>
                </div>
                <div className="flex justify-between gap-2">
                  <dt className="text-zinc-700">identifiers</dt>
                  <dd className="truncate text-zinc-600">
                    {event.identifiers.length === 0 ? "none" : event.identifiers.join(", ")}
                  </dd>
                </div>
                <div className="flex justify-between gap-2">
                  <dt className="text-zinc-700">reasons</dt>
                  <dd className="truncate text-zinc-600">
                    {Object.entries(event.reasons)
                      .map(([reason, count]) => `${reason}×${count}`)
                      .join(" ") || "—"}
                  </dd>
                </div>
              </dl>
            </Panel>
          </div>
        </div>
      )}
    </li>
  )
}