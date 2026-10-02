"use client"

/**
 * Charts, drawn by hand.
 *
 * No charting library, because the three shapes this dashboard needs — a daily
 * area, a labelled bar list, a split bar — are about eighty lines of SVG each, and
 * a dependency that ships a thousand kilobytes to render four lines of violet is
 * a cost the page pays on every load to save an afternoon of axis-tick maths.
 *
 * All of them read the same two things: a value, and how it compares to the
 * others. There are no tooltips, because a chart nobody can hover is still
 * readable when the exact numbers sit next to it — every chart here is paired
 * with the figure it draws.
 */

export const PALETTE = ["#a78bfa", "#818cf8", "#f59e0b", "#34d399", "#f87171", "#64748b"] as const

const nice = (value: number): string =>
  Math.abs(value) >= 1000 ? `${(value / 1000).toFixed(value % 1000 === 0 ? 0 : 1)}k` : `${value}`

/** An area chart over a daily series. */
export function AreaChart({
  points,
  height = 120,
  tone = "#a78bfa",
  label = "value"
}: {
  points: ReadonlyArray<{ day: string; value: number }>
  height?: number
  tone?: string
  label?: string
}) {
  if (points.length === 0) return <p className="text-[12px] text-zinc-600">Nothing in this range yet.</p>

  const total = points.reduce((sum, point) => sum + point.value, 0)
  // A range with no activity in it gets a sentence rather than an empty axis:
  // a flat line pinned to the bottom of a tall box reads as a broken chart.
  if (total === 0) {
    return (
      <p className="text-[12px] text-zinc-600">
        No {label} recorded in this range — {points.length} day{points.length === 1 ? "" : "s"} of
        nothing.
      </p>
    )
  }

  const max = Math.max(...points.map((point) => point.value), 1)
  const width = 100
  // Day spacing is proportional rather than evenly divided, so a gap in the data
  // shows up as a gap instead of being smoothed away.
  const step = points.length === 1 ? width : width / (points.length - 1)
  const coords = points.map((point, index) => ({
    x: index * step,
    y: height - (point.value / max) * (height - 4)
  }))
  const line = coords.map((c) => `${c.x.toFixed(2)},${c.y.toFixed(2)}`).join(" ")
  const area = `0,${height} ${line} ${width},${height}`

  return (
    <div className="space-y-1.5">
      <svg
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="none"
        className="h-32 w-full"
        role="img"
        aria-label={`${label}: ${nice(total)} in total across ${points.length} days`}
      >
        <polygon points={area} fill={tone} fillOpacity={0.14} />
        <polyline
          points={line}
          fill="none"
          stroke={tone}
          strokeWidth={1}
          strokeOpacity={0.85}
          vectorEffect="non-scaling-stroke"
        />
        {coords.map((c, index) => (
          <circle key={points[index].day} cx={c.x} cy={c.y} r={0.9} fill={tone} />
        ))}
      </svg>
      <div className="flex justify-between font-mono text-[9px] text-zinc-700">
        <span>{points[0].day}</span>
        <span className="text-zinc-600">
          peak {nice(max)} {label}
        </span>
        <span>{points[points.length - 1].day}</span>
      </div>
    </div>
  )
}

/** Vertical bars, for counts per day where each day is its own fact. */
export function Bars({
  points,
  height = 96,
  tone = "#a78bfa",
  label = "events"
}: {
  points: ReadonlyArray<{ day: string; value: number }>
  height?: number
  tone?: string
  label?: string
}) {
  if (points.length === 0) return <p className="text-[12px] text-zinc-600">Nothing in this range yet.</p>

  const total = points.reduce((sum, point) => sum + point.value, 0)
  if (total === 0) {
    return <p className="text-[12px] text-zinc-600">No {label} in this range.</p>
  }

  const max = Math.max(...points.map((point) => point.value), 1)
  // Beyond about forty bars the day labels stop being readable anyway, so they
  // are thinned out rather than overlapped.
  const every = Math.ceil(points.length / 8)

  return (
    <div className="space-y-1.5">
      <div className="flex items-end gap-[2px]" style={{ height }} role="img" aria-label={`${label} per day`}>
        {points.map((point) => (
          <div
            key={point.day}
            title={`${point.day}: ${point.value} ${label}`}
            className="min-w-[2px] flex-1 rounded-t-[2px]"
            style={{
              height: `${Math.max((point.value / max) * height, point.value > 0 ? 2 : 1)}px`,
              backgroundColor: point.value > 0 ? tone : "rgba(255,255,255,0.06)"
            }}
          />
        ))}
      </div>
      <div className="flex justify-between font-mono text-[9px] text-zinc-700">
        <span>{points[0].day}</span>
        <span className="text-zinc-600">
          {nice(total)} {label}
        </span>
        <span>{points[points.length - 1].day}</span>
      </div>
      {points.length <= 40 && (
        <div className="flex gap-[2px] font-mono text-[8px] text-zinc-700">
          {points.map((point, index) => (
            <span key={point.day} className="min-w-[2px] flex-1 truncate text-center">
              {index % every === 0 ? point.day.slice(8) : ""}
            </span>
          ))}
        </div>
      )}
    </div>
  )
}

/** A split bar: proportions of one whole, with a legend underneath. */
export function SplitBar({
  segments,
  total
}: {
  segments: ReadonlyArray<{ label: string; value: number; tone?: string }>
  total?: number
}) {
  const sum = total ?? segments.reduce((accumulator, segment) => accumulator + segment.value, 0)
  if (sum <= 0) return <p className="text-[12px] text-zinc-600">Nothing recorded yet.</p>

  return (
    <div className="space-y-2.5">
      <div className="flex h-2.5 gap-[2px] overflow-hidden rounded-full bg-white/[0.04]">
        {segments.map((segment, index) => (
          <div
            key={segment.label}
            title={`${segment.label}: ${segment.value}`}
            style={{
              width: `${(segment.value / sum) * 100}%`,
              backgroundColor: segment.tone ?? PALETTE[index % PALETTE.length]
            }}
          />
        ))}
      </div>
      <ul className="flex flex-wrap gap-x-4 gap-y-1">
        {segments.map((segment, index) => (
          <li key={segment.label} className="flex items-center gap-1.5 text-[11px] text-zinc-500">
            <span
              className="h-2 w-2 rounded-[2px]"
              style={{ backgroundColor: segment.tone ?? PALETTE[index % PALETTE.length] }}
            />
            {segment.label}
            <span className="font-mono text-zinc-600">{nice(segment.value)}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

/**
 * A ranked list with proportional bars.
 *
 * Used wherever the question is "which of these is big" — domains, routes, keys.
 * A pie chart cannot answer that past about six slices; a sorted bar list can,
 * and it carries the exact number with it.
 */
export function BarList({
  rows,
  empty = "Nothing recorded yet."
}: {
  rows: ReadonlyArray<{ label: string; value: number; detail?: string }>
  empty?: string
}) {
  if (rows.length === 0) return <p className="text-[12px] text-zinc-600">{empty}</p>
  const max = Math.max(...rows.map((row) => row.value), 1)

  return (
    <ul className="space-y-1.5">
      {rows.map((row) => (
        <li key={row.label} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3">
          <div className="min-w-0">
            <div className="flex items-baseline justify-between gap-2">
              <span className="truncate font-mono text-[11px] text-zinc-300">{row.label}</span>
              {row.detail && <span className="shrink-0 text-[10px] text-zinc-600">{row.detail}</span>}
            </div>
            <div className="mt-1 h-1 overflow-hidden rounded-full bg-white/[0.05]">
              <div
                className="h-full rounded-full bg-violet-400/50"
                style={{ width: `${Math.max((row.value / max) * 100, row.value > 0 ? 1.5 : 0)}%` }}
              />
            </div>
          </div>
          <span className="font-mono text-[11px] tabular-nums text-zinc-400">{nice(row.value)}</span>
        </li>
      ))}
    </ul>
  )
}