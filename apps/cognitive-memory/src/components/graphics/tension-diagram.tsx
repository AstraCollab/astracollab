import { Reveal } from "./reveal"

/**
 * A held contradiction.
 *
 * Two claims that cannot both be true, the question that settles them, and the
 * fact that the pair stays in every prompt until somebody answers.
 *
 * The first version of this was hand-authored SVG, and it was wrong in a way
 * worth recording: the two strike marks were positioned with literal coordinates,
 * so both landed on the first claim and the second one was left unmarked. Text
 * inside a scaled viewBox is laid out by guessing — a 1000-unit viewBox rendered
 * at 1400px multiplies every font size by 1.4, and there is no reflow.
 *
 * So this is HTML and CSS. `text-decoration-style: wavy` gives the second claim a
 * different mark from the first for free, correctly positioned by the browser, and
 * the only SVG left is the connector, which is pure geometry with no text on it
 * and therefore cannot drift.
 *
 * Two different marks, deliberately: one of the claims is wrong, and the service
 * does not know which. A single strike style would imply it had picked a winner.
 */

interface Claim {
  readonly id: string
  readonly text: string
  readonly style: "solid" | "wavy"
}

const CLAIMS: readonly Claim[] = [
  { id: "mem_7f2a", text: "We deploy on Fridays", style: "solid" },
  { id: "ten_44e1", text: "We never deploy on Fridays", style: "wavy" }
]

export function TensionDiagram() {
  return (
    <Reveal>
      <figure className="overflow-hidden rounded-xl border border-white/[0.08] bg-white/[0.015]">
        <figcaption className="flex items-center justify-between gap-4 border-b border-white/[0.06] px-5 py-2.5">
          <span className="font-mono text-[9px] uppercase tracking-[0.18em] text-zinc-600">
            Unresolved · pinned into every context build
          </span>
          <span className="font-mono text-[10px] text-amber-300/80">impact: critical</span>
        </figcaption>

        <div className="space-y-6 px-5 py-6 sm:grid sm:grid-cols-[1fr_auto] sm:items-center sm:gap-x-6 sm:space-y-0">
          {/* The two claims. */}
          <ol className="space-y-5">
            {CLAIMS.map((claim, index) => (
              <li key={claim.id} className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
                <code className="font-mono text-[10px] text-zinc-700">{claim.id}</code>
                <span
                  className="font-mono text-[15px] leading-6 text-zinc-200"
                  style={{
                    textDecorationLine: "line-through",
                    textDecorationColor: "rgba(167,139,250,0.85)",
                    textDecorationThickness: "1.5px",
                    textDecorationStyle: claim.style,
                    // The mark sits on the text's own centre line, and its colour
                    // has to be set separately from the text colour or it inherits
                    // zinc-200 and reads as a mistake.
                    textDecorationSkipInk: "none"
                  }}
                >
                  {claim.text}
                </span>
                {index === 1 ? (
                  <span className="w-full font-mono text-[10px] text-zinc-700 sm:w-auto">
                    ← neither is marked stale
                  </span>
                ) : null}
              </li>
            ))}
          </ol>

          {/*
            The connector sits immediately beside the claims rather than pushed to
            the far edge of the card, because a bracket marooned at the end of a
            wide row does not read as joining anything. Pure geometry, no text on
            it, so the SVG viewBox cannot drift — the leaders land on the two
            claims by construction.
          */}
          <div className="flex items-center gap-4">
            <svg
              viewBox="0 0 48 96"
              className="hidden h-[88px] w-12 shrink-0 sm:block"
              aria-hidden
              preserveAspectRatio="xMidYMid meet"
            >
              <path
                d="M 0 16 H 26 V 48 H 26 V 80 H 0"
                fill="none"
                stroke="rgba(167,139,250,0.35)"
                strokeWidth="1"
                vectorEffect="non-scaling-stroke"
                pathLength={1}
                data-draw=""
                style={{ ["--draw-delay" as string]: "0.5s" }}
              />
              <path
                d="M 26 48 H 42"
                fill="none"
                stroke="rgba(167,139,250,0.7)"
                strokeWidth="1"
                vectorEffect="non-scaling-stroke"
                pathLength={1}
                data-draw=""
                style={{ ["--draw-delay" as string]: "0.72s" }}
              />
              <path
                d="M 42 44 L 48 48 L 42 52 Z"
                fill="rgba(167,139,250,0.7)"
                data-pop=""
                style={{ ["--pop-delay" as string]: "0.86s" }}
              />
            </svg>

            <div className="min-w-0">
              <p className="font-mono text-[9px] uppercase tracking-[0.18em] text-zinc-700">
                Ask, do not resolve
              </p>
              <p className="mt-1.5 font-mono text-lg text-violet-200">Which is it?</p>
            </div>
          </div>
        </div>

        {/* What holding it open costs, which is the actual trade. */}
        <div className="border-t border-white/[0.06] px-5 py-5">
          <p className="max-w-2xl text-xs leading-5 text-zinc-500">
            One of these is wrong and nothing in the store says which. The pair is
            pinned into every prompt at full body — exempt from the budget, because a
            budget that can silently drop a contradiction is a budget that can resolve
            one without anyone deciding to.
          </p>
          <p className="mt-3 font-mono text-[10px] text-zinc-700">
            Resolving it keeps the resolution, and the reusable pattern it revealed.
          </p>
        </div>
      </figure>
    </Reveal>
  )
}
