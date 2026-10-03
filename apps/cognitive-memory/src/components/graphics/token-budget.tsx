import { Reveal } from "./reveal"

/**
 * The token budget.
 *
 * One turn's block, drawn to scale, against the ceiling it has to fit inside. The
 * argument this page is making is entirely about proportion — what a tier costs
 * next to what you did not pay for — so a bar chart *is* the content rather than
 * an illustration of it. The first version of this graphic was a field of
 * scattered dots per tier, which turned out to communicate nothing: random dots
 * read as noise, and the difference between nine and five of them is invisible
 * when they are spread across the width.
 *
 * The numbers are from `measure` on 200 stored memories. The ceiling is the
 * deployment default, so the headroom is what the window keeps for the actual
 * task rather than for the memory.
 */

const CEILING = 2000

const SEGMENTS = [
  { key: "L0", name: "Pinned", detail: "contradictions, weak domains, corrections", tokens: 79, fill: "#a78bfa" },
  { key: "L1", name: "Index lines", detail: "one gist line per held memory", tokens: 1180, fill: "#8b6ff0" },
  { key: "body", name: "Triggered bodies", detail: "full text, only where an identifier earned it", tokens: 141, fill: "#6d55c4" },
  { key: "free", name: "Headroom", detail: "left for the task, not the memory", tokens: 600, fill: "none" }
] as const

const W = 1000
const BAR_X = 0
const BAR_Y = 44
const BAR_H = 24

/**
 * Segment geometry, computed up front.
 *
 * Deriving the x offsets with a running counter inside the render body mutates a
 * variable mid-render, which React's compiler rules rightly refuse — and it is
 * also just untidy. A reduce over the segment list is the same answer with no
 * mutable state, and it puts the arithmetic in one readable place.
 */
const PLACED = SEGMENTS.reduce<{ segment: (typeof SEGMENTS)[number]; x: number; width: number }[]>(
  (placed, segment) => {
    const previous = placed.at(-1)
    const x = previous === undefined ? BAR_X : previous.x + previous.width
    return [...placed, { segment, x, width: (segment.tokens / CEILING) * W }]
  },
  []
)

export function TokenBudget() {
  return (
    <Reveal>
      {/*
        Scrolls rather than shrinks below `sm`.

        A 1000-unit viewBox squeezed into a 350px phone makes the 7.5-unit type
        render at about 2.6px — technically present, practically invisible. Every
        other solution (a second layout, a stacked bar, dropping the legend)
        trades a correct chart for a smaller one, so the chart keeps its aspect
        ratio and the reader swipes, which is what a wide table does everywhere
        else. A scrollbar cue on the right edge, because a chart that has been
        cut off looks like a chart that ends there.
      */}
      <div className="-mx-1 overflow-x-auto px-1 pb-1 sm:overflow-visible">
      <svg
        viewBox={`0 0 ${W} 202`}
        className="h-auto w-full min-w-[640px] sm:min-w-0"
        role="img"
        aria-label="One turn's prompt block, to scale against a 2,000 token ceiling. 79 tokens of pinned contradictions and weak domains, 1,180 tokens of index lines, 141 tokens of triggered full bodies: 1,320 tokens used, 680 left as headroom."
      >
        <defs>
          <pattern id="cm-hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
            <line x1="0" y1="0" x2="0" y2="6" stroke="rgba(255,255,255,0.07)" strokeWidth="1.2" />
          </pattern>
        </defs>

        {/* Caption. */}
        <text x={0} y={12} className="fill-zinc-600 font-mono text-[7.5px] uppercase tracking-[0.16em]">
          tokens per turn · 200 stored memories · measured
        </text>
        <text x={W} y={12} textAnchor="end" className="fill-zinc-700 font-mono text-[7.5px]">
          ceiling 2,000
        </text>

        {/* The bar. Each segment is its real width, so the proportions are the
            claim — nothing here is decorative scaling. */}
        {PLACED.map(({ segment, x, width }, index) => {
          const delay = 0.1 + index * 0.16

          return (
            <g key={segment.key}>
              <rect
                x={x}
                y={BAR_Y}
                width={width}
                height={BAR_H}
                fill={segment.fill === "none" ? "url(#cm-hatch)" : segment.fill}
                fillOpacity={segment.fill === "none" ? undefined : 0.88}
                pathLength={1}
                data-wipe=""
                style={{ ["--wipe-delay" as string]: `${delay}s` }}
              />
              {/* A hairline between segments, so adjacent violets stay legible
                  as separate amounts rather than blurring into one block. */}
              {index > 0 ? (
                <line
                  x1={x}
                  y1={BAR_Y}
                  x2={x}
                  y2={BAR_Y + BAR_H}
                  stroke="#08080b"
                  strokeWidth="1.5"
                  vectorEffect="non-scaling-stroke"
                />
              ) : null}
            </g>
          )
        })}

        {/* Total, called out on the boundary where the money stops. */}
        <g>
          <line
            x1={(1320 / CEILING) * W}
            y1={BAR_Y - 10}
            x2={(1320 / CEILING) * W}
            y2={BAR_Y + BAR_H + 10}
            stroke="rgba(237,233,254,0.5)"
            strokeWidth="1"
            strokeDasharray="2 3"
            vectorEffect="non-scaling-stroke"
            pathLength={1}
            data-draw=""
            style={{ ["--wipe-delay" as string]: "0.7s" }}
          />
          <text
            x={(1320 / CEILING) * W + 8}
            y={BAR_Y - 14}
            className="fill-zinc-300 font-mono text-[8.5px]"
            data-pop=""
            style={{ ["--pop-delay" as string]: "0.8s" }}
          >
            1,320 used
          </text>
        </g>

        {/* Axis. Ticks only — a full frame of numbers would out-weigh the bar. */}
        <line
          x1={0}
          y1={BAR_Y + BAR_H + 18}
          x2={W}
          y2={BAR_Y + BAR_H + 18}
          stroke="rgba(255,255,255,0.10)"
          strokeWidth="1"
          vectorEffect="non-scaling-stroke"
        />
        {[0, 500, 1000, 1500, 2000].map((tick, index) => (
          <g key={tick}>
            <line
              x1={(tick / CEILING) * W}
              y1={BAR_Y + BAR_H + 18}
              x2={(tick / CEILING) * W}
              y2={BAR_Y + BAR_H + 23}
              stroke="rgba(255,255,255,0.14)"
              strokeWidth="1"
              vectorEffect="non-scaling-stroke"
            />
            <text
              x={(tick / CEILING) * W}
              y={BAR_Y + BAR_H + 38}
              textAnchor={index === 0 ? "start" : index === 4 ? "end" : "middle"}
              className="fill-zinc-700 font-mono text-[7.5px]"
            >
              {tick.toLocaleString()}
            </text>
          </g>
        ))}

        {/* Legend. The bar cannot carry these labels itself — the pinned segment
            is 4% of the width — so they go below, with the swatch doing the
            identifying rather than the text. */}
        {SEGMENTS.map((segment, index) => (
          <g
            key={segment.key}
            data-pop=""
            style={{ ["--pop-delay" as string]: `${0.5 + index * 0.1}s` }}
          >
            <rect
              x={0}
              y={140 + index * 15}
              width={9}
              height={9}
              rx={1.5}
              fill={segment.fill === "none" ? "none" : segment.fill}
              stroke={segment.fill === "none" ? "rgba(255,255,255,0.18)" : "none"}
              strokeWidth="1"
            />
            <text x={18} y={147 + index * 15} className="fill-zinc-400 font-mono text-[7.5px]">
              {segment.name}
            </text>
            <text x={132} y={147 + index * 15} className="fill-zinc-600 font-mono text-[7.5px]">
              {segment.detail}
            </text>
            <text
              x={W}
              y={147 + index * 15}
              textAnchor="end"
              className="fill-zinc-500 font-mono text-[7.5px]"
            >
              {segment.tokens.toLocaleString()}
            </text>
          </g>
        ))}
      </svg>
      </div>
    </Reveal>
  )
}
