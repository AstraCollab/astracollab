import type { RunEvent } from "@/server/db/schema"

/**
 * The run transcript, replayed from `run_events`.
 *
 * The TUI is a pure function of that table (see the schema comment), so this is
 * the same idea with fewer affordances: order by `sequence`, render, done.
 * The renderer is tolerant: known event kinds render nicely, unknown kinds
 * fall back to kind + payload.
 */
export function Transcript({ events }: { readonly events: readonly RunEvent[] }) {
  if (events.length === 0) {
    return (
      <p className="rounded-[0.75rem] border border-line p-8 text-center text-sm text-[var(--ink-muted)]">
        No events recorded yet. Events appear as the agent runs.
      </p>
    )
  }

  return (
    <div
      className="space-y-1.5 rounded-[0.75rem] border border-line bg-[var(--surface-inset)] p-5 font-mono-tech text-[13px] leading-relaxed"
    >
      {events.map((event) => (
        <EventLine key={event.id} event={event} />
      ))}
    </div>
  )
}

function EventLine({ event }: { readonly event: RunEvent }) {
  // `payload` is jsonb and the writer's shape is not yet fixed, so every read is
  // a narrowing attempt rather than a cast. A malformed payload renders as the
  // raw JSON instead of throwing mid-transcript.
  const payload = (event.payload ?? {}) as Record<string, unknown>
  const text = typeof payload.text === "string" ? payload.text : null

  switch (event.kind) {
    case "prompt":
    case "text":
    case "say":
      return (
        <p className="text-[var(--ink-muted)]">
          {text ?? (typeof payload.text === "string" ? payload.text : compact(payload))}
        </p>
      )
    case "input":
      return (
        <p>
          <span className="text-signal" aria-hidden="true">
            ❯{" "}
          </span>
          {text ?? compact(payload)}
        </p>
      )

    case "tool_call":
    case "tool-call":
      return (
        <p style={{ paddingLeft: "1rem" }}>
          <span className="text-[var(--ink-faint)]">
            {String(payload.tool ?? payload.toolName ?? "tool")}{" "}
          </span>
          <span className="text-[var(--ink-muted)]">{compact(payload.input)}</span>
        </p>
      )

    case "tool_result":
    case "tool.result":
      return (
        <p className="text-[var(--ink-faint)]" style={{ paddingLeft: "1rem" }}>
          {compact(typeof payload.output === "string" ? payload.output : typeof payload.result === "string" ? payload.result : payload)}
        </p>
      )

    case "error":
    case "run.failed":
      const err = typeof payload.text === "string" ? payload.text : typeof payload.error === "string" ? payload.error : text ?? compact(payload)
      return <p className="text-[var(--warn)]">{err}</p>
    case "run.queued":
    case "run.started":
    case "run.settled":
    case "sandbox.provisioned":
    case "sandbox.ready":
      return <p className="text-[var(--ink-faint)]">{event.kind} {compact(payload)}</p>

    default:
      return (
        <p className="text-[var(--ink-faint)]">
          {event.kind} {compact(payload)}
        </p>
      )
  }
}

/**
 * One-line summary of a JSON value.
 *
 * Long output is a real case — a test suite printing two hundred lines — and
 * dumping all of it inline would make the transcript unreadable. Capped with an
 * explicit "truncated" rather than a CSS ellipsis, so what was cut is stated
 * rather than implied.
 */
function compact(value: unknown, limit = 160): string {
  if (value === undefined) return ""
  if (typeof value === "string") {
    return value.length > limit ? `${value.slice(0, limit)}…` : value
  }

  let text: string
  try {
    text = JSON.stringify(value)
  } catch {
    return "[unserializable]"
  }
  if (text === undefined) return ""
  return text.length > limit ? `${text.slice(0, limit)}…` : text
}
