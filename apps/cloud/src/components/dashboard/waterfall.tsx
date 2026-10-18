import { Badge } from "@/components/ui/badge"
import { formatClock, formatDuration, formatUsd } from "@/components/dashboard/metrics"
import { traceTone } from "@/components/dashboard/status"

export interface WaterfallSpan {
  readonly id: string
  readonly parentId: string | null
  readonly name: string
  readonly kind: string
  readonly status: string
  readonly startTime: number
  readonly endTime: number | null
  readonly costUsd: number | null
  readonly attributes: Record<string, unknown>
}

/**
 * A flat, sorted, depth-tagged span ready to render.
 *
 * The `depth` and `parentStart` fields are the whole trick. Rendering a tree of
 * spans means knowing, for each one, how deep it is and where its parent's bar
 * begins — and recomputing that per row from the raw parent chain is work that
 * has to be right for every row rather than for the list as a whole.
 */
interface Row {
  readonly span: WaterfallSpan
  readonly depth: number
  /** The parent's own start, so a child can be drawn inside its parent's extent. */
  readonly parentStart: number | null
  readonly parentEnd: number | null
}

/**
 * Depth-first order, with depth and parent extent filled in.
 *
 * Iterative rather than recursive. A trace is a caller-controlled structure — an
 * agent can nest spans arbitrarily deep — and the depth here is bounded only by
 * whatever the harness sent, so the traversal that walks it should not be the one
 * that can blow the stack on a long trace.
 */
function layout(spans: readonly WaterfallSpan[]): readonly Row[] {
  const byId = new Map(spans.map((span) => [span.id, span]))
  const childrenOf = new Map<string | null, WaterfallSpan[]>()
  for (const span of spans) {
    const parentId = span.parentId !== null && byId.has(span.parentId) ? span.parentId : null
    const siblings = childrenOf.get(parentId)
    if (siblings) siblings.push(span)
    else childrenOf.set(parentId, [span])
  }

  // Siblings by start time; the bar geometry depends on a total order and arrival
  // order is not one.
  for (const siblings of childrenOf.values()) {
    siblings.sort((a, b) => a.startTime - b.startTime)
  }

  const rows: Row[] = []
  const stack: Array<{ span: WaterfallSpan; depth: number }> = []

  // Seed with the roots. A span whose parent is missing from the payload is
  // treated as a root rather than dropped — an orphaned span is a fact about the
  // trace, and silently discarding it would make the detail page disagree with
  // the counts on the list page.
  for (const root of childrenOf.get(null) ?? []) {
    stack.push({ span: root, depth: 0 })
  }
  stack.sort((a, b) => a.span.startTime - b.span.startTime)

  while (stack.length > 0) {
    const current = stack.pop()
    if (current === undefined) break

    const { span, depth } = current
    const parent = span.parentId !== null ? byId.get(span.parentId) : undefined

    rows.push({
      span,
      depth,
      parentStart: parent?.startTime ?? null,
      parentEnd: parent?.endTime ?? null
    })

    const children = childrenOf.get(span.id) ?? []
    // Reversed before push, because the stack pops last-in-first-out and the rows
    // must come out in start order to match the siblings sort above.
    for (let index = children.length - 1; index >= 0; index -= 1) {
      stack.push({ span: children[index]!, depth: depth + 1 })
    }
  }

  return rows
}

/**
 * Pull the human-useful attributes out of a span.
 *
 * Only a fixed allowlist, and only the ones that render as a single short value.
 * A model span carries usage and provider metadata; a tool span carries a status.
 * Everything else in the payload is either machine-only or unbounded, and dumping
 * it into a `<dl>` on every row of a waterfall turns the page into a JSON viewer.
 */
const INTERESTING = [
  { key: "gen_ai.request.model", label: "model" },
  { key: "gen_ai.provider.name", label: "provider" },
  { key: "gen_ai.usage.input_tokens", label: "in" },
  { key: "gen_ai.usage.output_tokens", label: "out" },
  { key: "nah.tool.name", label: "tool" },
  { key: "nah.tool.status", label: "tool status" },
  { key: "nah.sandbox.id", label: "sandbox" },
  { key: "nah.git.branch", label: "branch" },
  { key: "nah.git.commit", label: "commit" },
  { key: "nah.harness.version", label: "harness" }
] as const

function interesting(attributes: Record<string, unknown>): readonly { label: string; value: string }[] {
  const out: { label: string; value: string }[] = []
  for (const { key, label } of INTERESTING) {
    const value = attributes[key]
    if (value === null || value === undefined) continue
    out.push({ label, value: String(value) })
  }
  return out
}

/**
 * Bar geometry as percentages of the trace's total extent.
 *
 * Returns `null` for both when the span cannot be placed — a zero-length trace, or
 * one whose end is unknown. A zero-width bar is the signal to render the row with
 * no bar at all: drawing a hairline at the origin would claim a position for a
 * span we cannot actually place.
 */
function geometry(
  start: number,
  end: number | null,
  traceStart: number,
  traceEnd: number
): { left: number; width: number } | null {
  if (end === null) return null
  const total = traceEnd - traceStart
  if (total <= 0) return null

  const left = ((start - traceStart) / total) * 100
  const width = ((end - start) / total) * 100

  // Clamp rather than reject. A clock skew between the machine that reported the
  // trace root and the one that reported a span can push a child a few
  // milliseconds outside its parent, and the correct response is to pin it to the
  // edge rather than drop the bar — the span happened, we just place it at the
  // boundary.
  return {
    left: Math.min(100, Math.max(0, left)),
    width: Math.min(100 - Math.min(100, Math.max(0, left)), Math.max(0.5, width))
  }
}

const BAR_TONE: Record<string, string> = {
  error: "bg-[var(--signal)]",
  ok: "bg-[var(--ink-faint)]",
  interrupted: "bg-[var(--warn)]",
  unset: "bg-[var(--ink-faint)]"
}

/**
 * The span waterfall.
 *
 * The point of the view is proportional comparison, so every bar is sized against
 * the trace's own total extent and nothing is scaled to its parent. That means a
 * fast tool call nested inside a slow one is visibly a sliver, which is the
 * information a reader came for. Indentation carries the hierarchy instead, and
 * the depth is capped at six levels — past that the nesting is structural noise
 * rather than something a reader navigates by eye.
 */
export function TraceWaterfall({
  spans,
  traceStart,
  traceEnd
}: {
  readonly spans: readonly WaterfallSpan[]
  readonly traceStart: number
  readonly traceEnd: number | null
}) {
  if (spans.length === 0) {
    return (
      <p className="rounded-[0.75rem] border border-line p-8 text-center text-sm text-[var(--ink-muted)]">
        This trace posted no spans.
      </p>
    )
  }

  const rows = layout(spans)
  // The extent is taken from the rows, not from the trace's own end: a trace that
  // was never closed still has spans with real extents, and using the null end
  // would flatten every bar to zero width on exactly the interrupted traces where
  // the waterfall is most wanted.
  const end =
    traceEnd ??
    spans.reduce((max, span) => Math.max(max, span.endTime ?? span.startTime), traceStart)

  return (
    <div className="overflow-hidden rounded-[0.75rem] border border-line bg-[var(--surface-raised)]">
      <div className="grid grid-cols-[minmax(0,3fr)_minmax(0,1fr)_auto] gap-4 border-b border-line px-4 py-2 font-mono-tech text-[0.6875rem] uppercase tracking-wider text-[var(--ink-faint)]">
        <span>Span</span>
        <span>Timeline</span>
        <span className="text-right">Duration</span>
      </div>

      <ul>
        {rows.map((row) => {
          const { span, depth } = row
          const bar = geometry(span.startTime, span.endTime, traceStart, end)
          const details = interesting(span.attributes)

          return (
            <li
              key={span.id}
              className="grid grid-cols-[minmax(0,3fr)_minmax(0,1fr)_auto] items-center gap-4 border-b border-line px-4 py-2.5 last:border-b-0"
              style={{ paddingLeft: `${16 + Math.min(depth, 6) * 14}px` }}
            >
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="truncate text-sm">{span.name}</span>
                  <Badge tone={traceTone(span.status as never)}>{span.kind}</Badge>
                </div>
                {details.length > 0 ? (
                  <p className="font-mono-tech mt-1 truncate text-[0.6875rem] text-[var(--ink-faint)]">
                    {details.map((detail) => `${detail.label}: ${detail.value}`).join("  ·  ")}
                  </p>
                ) : null}
              </div>

              <div className="relative h-4">
                {bar !== null ? (
                  <div
                    className={`absolute top-1/2 h-1.5 -translate-y-1/2 rounded-full ${BAR_TONE[span.status] ?? BAR_TONE.unset}`}
                    style={{ left: `${bar.left}%`, width: `${bar.width}%` }}
                    title={`${formatDuration(span.endTime! - span.startTime)} starting ${formatClock(span.startTime)}`}
                  />
                ) : null}
              </div>

              <span className="num text-right text-xs text-[var(--ink-faint)]">
                {formatDuration(span.endTime === null ? null : span.endTime - span.startTime)}
                {span.costUsd !== null && span.costUsd > 0 ? (
                  <span className="ml-2">{formatUsd(span.costUsd)}</span>
                ) : null}
              </span>
            </li>
          )
        })}
      </ul>
    </div>
  )
}