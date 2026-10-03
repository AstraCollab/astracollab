import { TIERS } from "@/lib/marketing"
import { Reveal } from "./reveal"

/**
 * The four tiers, as a ladder of what they cost.
 *
 * The two graphics that were here before both drew one number — 1,320 of a
 * 2,000 ceiling — and a reader who has seen either has seen the budget story
 * twice. Neither of them ever drew the thing the budget exists to serve: the
 * four tiers, and the fact that the cost of holding something falls off a cliff
 * as you go down them.
 *
 * So the organising variable here is per-turn cost, and the form is the argument.
 * L0 is a full body every turn, so it is a thick rung. L1 is one index line, so
 * it is thin. L2 and L3 cost nothing until something reaches for them, so they
 * are hairlines. The descent is the picture and no axis is needed to carry it.
 *
 * Which is also why nothing here is scaled to a common measure. "Full body",
 * "one line" and "nothing" are an ordinal progression, not three amounts, and
 * drawing them against a token axis would invent a precision the numbers do not
 * have. L0's rung is simply the thickest, and everything below it is read
 * against it — there is a second attempt's worth of explaining a reference line
 * here in the history of this file, and it read as a stray dotted rule rather
 * than as a scale.
 *
 * Fill carries the second half of the same idea. L0 and L1 are filled because
 * they are in the prompt every turn; L2 and L3 are hollow outlines because they
 * are silent until a promotion or a question reaches them. Two tiers of four
 * spend anything at all, which is what makes the store affordable as it grows —
 * and that is legible before a single word is read.
 *
 * The rungs share a spine rather than floating in four rows, because the first
 * attempt at this drew them as independent bars and the descent disappeared:
 * evenly spaced and unconnected, four decreasing rectangles read as a table.
 *
 * The copy is imported rather than retyped. `TIERS` already holds the cost rule
 * for each tier and the tiers page quotes it too; a second copy here is exactly
 * the drift `marketing.ts` was written to prevent.
 */

const CODE_X = 68
const NAME_X = 84
const SPINE_X = 164
const BAND_W = 80
const BRACKET_X = 262
const GROUP_X = 272
const RULE_X = 400

const EYE_Y = 26
const NOTE_Y = 320
const CY = [100, 156, 212, 268] as const

/**
 * Rung thickness, and whether the tier is in the prompt every turn.
 *
 * L0 and L1 speak; L2 and L3 wait. Ordered to the cost rules in `TIERS` and
 * carrying no measured ratio between them.
 */
const RUNGS = [
  { height: 44, spoken: true },
  { height: 15, spoken: true },
  { height: 3.5, spoken: false },
  { height: 3.5, spoken: false }
] as const

const GROUPS = [
  { from: 0, to: 1, label: "in the prompt every turn" },
  { from: 2, to: 3, label: "silent until asked" }
] as const

const topOf = (index: number) => CY[index] - RUNGS[index].height / 2
const bottomOf = (index: number) => CY[index] + RUNGS[index].height / 2

export function TierLadder() {
  const stackTop = topOf(0)
  const stackBottom = bottomOf(RUNGS.length - 1)

  return (
    <Reveal>
      {/* Scrolls below `sm`, like the other two wide graphics. */}
      <div className="-mx-1 overflow-x-auto px-1 pb-1 sm:overflow-visible">
        <svg
          viewBox="0 0 640 360"
          className="h-auto w-full min-w-[560px] sm:min-w-0"
          role="img"
          aria-label="The four memory tiers as a ladder of per-turn cost. L0 Pinned puts a full body in every prompt. L1 Hot cache puts one index line per memory in every prompt. L2 Warm store and L3 Cold archive cost nothing until a promotion or a question reaches them, so two tiers of four spend anything at all."
        >
          <text
            x={48}
            y={EYE_Y}
            className="fill-zinc-600 font-mono text-[8px] uppercase tracking-[0.16em]"
            data-pop=""
            style={{ ["--pop-delay" as string]: "0.1s" }}
          >
            four tiers · what each one costs per turn
          </text>

          {/* The spine the rungs hang off. Without it the four rungs read as a
              table of independent bars rather than one descent. */}
          <line
            x1={SPINE_X}
            y1={stackTop}
            x2={SPINE_X}
            y2={stackBottom}
            stroke="rgba(255,255,255,0.14)"
            strokeWidth="1"
            vectorEffect="non-scaling-stroke"
            pathLength={1}
            data-draw=""
            style={{ ["--draw-delay" as string]: "0.15s" }}
          />

          {TIERS.map((tier, index) => {
            const rung = RUNGS[index]
            const delay = 0.3 + index * 0.16

            return (
              <g key={tier.tier}>
                <rect
                  x={SPINE_X}
                  y={topOf(index)}
                  width={BAND_W}
                  height={rung.height}
                  rx={Math.min(rung.height / 2, 2)}
                  fill={rung.spoken ? "rgba(167,139,250,0.8)" : "none"}
                  stroke={rung.spoken ? "none" : "rgba(255,255,255,0.22)"}
                  strokeWidth="1"
                  vectorEffect="non-scaling-stroke"
                  data-wipe=""
                  style={{ ["--wipe-delay" as string]: `${delay}s` }}
                />

                <text
                  x={CODE_X}
                  y={CY[index] + 3.5}
                  textAnchor="end"
                  className={`font-mono text-[10px] ${
                    rung.spoken ? "fill-violet-200" : "fill-zinc-600"
                  }`}
                  data-pop=""
                  style={{ ["--pop-delay" as string]: `${delay + 0.05}s` }}
                >
                  {tier.tier}
                </text>
                <text
                  x={NAME_X}
                  y={CY[index] + 3.5}
                  className={`font-mono text-[8.5px] ${
                    rung.spoken ? "fill-zinc-200" : "fill-zinc-500"
                  }`}
                  data-pop=""
                  style={{ ["--pop-delay" as string]: `${delay + 0.08}s` }}
                >
                  {tier.name}
                </text>
                {/* The rule, quoted from TIERS rather than retyped. */}
                <text
                  x={RULE_X}
                  y={CY[index] + 3}
                  className="font-mono text-[7.5px] fill-zinc-600"
                  data-pop=""
                  style={{ ["--pop-delay" as string]: `${delay + 0.12}s` }}
                >
                  {tier.cost}
                </text>
              </g>
            )
          })}

          {/* Which rungs are actually spending anything. A bracket per group
              rather than a legend, because the grouping is the claim. */}
          {GROUPS.map((group, index) => {
            const top = topOf(group.from)
            const bottom = bottomOf(group.to)
            const delay = 1.1 + index * 0.2
            const accent = group.from === 0

            return (
              <g key={group.label}>
                <path
                  d={`M ${BRACKET_X - 5} ${top} H ${BRACKET_X + 5} M ${BRACKET_X} ${top} V ${bottom} M ${BRACKET_X - 5} ${bottom} H ${BRACKET_X + 5}`}
                  stroke={accent ? "rgba(167,139,250,0.45)" : "rgba(255,255,255,0.18)"}
                  strokeWidth="1"
                  vectorEffect="non-scaling-stroke"
                  pathLength={1}
                  data-draw=""
                  style={{ ["--draw-delay" as string]: `${delay}s` }}
                />
                <text
                  x={GROUP_X}
                  y={(top + bottom) / 2 + 3}
                  className={`font-mono text-[7.5px] uppercase tracking-[0.12em] ${
                    accent ? "fill-violet-300/60" : "fill-zinc-600"
                  }`}
                  data-pop=""
                  style={{ ["--pop-delay" as string]: `${delay + 0.1}s` }}
                >
                  {group.label}
                </text>
              </g>
            )
          })}

          <text
            x={48}
            y={NOTE_Y}
            className="fill-zinc-700 font-mono text-[7.5px]"
            data-pop=""
            style={{ ["--pop-delay" as string]: "1.5s" }}
          >
            a fact moves between tiers as it earns it
          </text>
        </svg>
      </div>
    </Reveal>
  )
}
