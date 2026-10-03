/**
 * Page furniture: the grid, the grain, and the reveal.
 *
 * Three small pieces that every marketing page composes. All SVG, no animation
 * library — the site has no framer-motion and adding one for a grid pattern and a
 * draw-on would be a poor trade against a build that stays statically rendered.
 *
 * The two techniques worth stealing came from reading Zep's and Mem0's markup:
 * an SVG `<pattern>` for the lattice (Mem0 has none, which is why their dark
 * pages read as flat), and `pathLength="1"` so a line can be drawn with
 * `stroke-dashoffset` from 1 to 0 without ever measuring it.
 */

/**
 * The lattice.
 *
 * A `<pattern>` of one hairline, tiled, with a radial mask so it fades out
 * towards the edges rather than stopping at a hard rectangle. Masking is what
 * turns "a grid" into "a grid that recedes" — an unmasked grid reads as graph
 * paper and flattens everything behind it.
 *
 * Two densities, because one grid at one size looks like a mistake: a fine
 * lattice at 72px for structure, and a coarser one at 288px that gives the eye
 * something to count.
 */
export function GridBackdrop({
  className = "",
  cell = 72,
  coarse = 288,
  opacity = 0.5
}: {
  className?: string
  cell?: number
  coarse?: number
  opacity?: number
}) {
  return (
    <svg
      aria-hidden
      className={`pointer-events-none absolute inset-0 h-full w-full ${className}`}
      style={{ opacity }}
    >
      <defs>
        <pattern id="cm-grid-fine" width={cell} height={cell} patternUnits="userSpaceOnUse">
          <path
            d={`M ${cell} 0 L 0 0 0 ${cell}`}
            fill="none"
            stroke="rgba(255,255,255,0.055)"
            strokeWidth="1"
          />
        </pattern>
        <pattern id="cm-grid-coarse" width={coarse} height={coarse} patternUnits="userSpaceOnUse">
          <path
            d={`M ${coarse} 0 L 0 0 0 ${coarse}`}
            fill="none"
            stroke="rgba(167,139,250,0.07)"
            strokeWidth="1"
          />
        </pattern>
        <radialGradient id="cm-grid-fade" cx="50%" cy="32%" r="72%">
          <stop offset="0%" stopColor="white" />
          <stop offset="55%" stopColor="white" stopOpacity="0.45" />
          <stop offset="100%" stopColor="black" />
        </radialGradient>
        <mask id="cm-grid-mask">
          {/* White keeps the pattern, black erases it. */}
          <rect width="100%" height="100%" fill="url(#cm-grid-fade)" />
        </mask>
      </defs>
      <g mask="url(#cm-grid-mask)">
        <rect width="100%" height="100%" fill="url(#cm-grid-fine)" />
        <rect width="100%" height="100%" fill="url(#cm-grid-coarse)" />
      </g>
    </svg>
  )
}

/**
 * Film grain.
 *
 * `feTurbulence` is the only way to get real noise without shipping a PNG: one
 * filter, no asset, and it renders identically at any DPR. At 3.5% opacity over a
 * near-black page it is invisible as texture and very visible as depth — the flat
 * digital black that makes dark UIs look like an empty div.
 *
 * `stitchTiles` is there to stop the filter showing seams where the turbulence
 * tiles meet, which is the usual reason this trick looks broken.
 */
export function Grain({ className = "", opacity = 0.035 }: { className?: string; opacity?: number }) {
  return (
    <svg aria-hidden className={`pointer-events-none absolute inset-0 h-full w-full ${className}`}>
      <defs>
        <filter id="cm-grain" x="0" y="0" width="100%" height="100%">
          <feTurbulence type="fractalNoise" baseFrequency="0.85" numOctaves="3" stitchTiles="stitch" />
          <feColorMatrix type="saturate" values="0" />
        </filter>
      </defs>
      <rect width="100%" height="100%" filter="url(#cm-grain)" opacity={opacity} />
    </svg>
  )
}

/**
 * A soft violet bloom.
 *
 * Cheaper and more controllable than a CSS blur on a coloured div, because the
 * falloff is part of the gradient rather than a filter pass over the whole
 * compositing layer.
 */
export function Glow({
  className = "",
  cx = "50%",
  cy = "0%",
  r = "60%",
  from = "rgba(139,92,246,0.20)",
  to = "transparent"
}: {
  className?: string
  cx?: string
  cy?: string
  r?: string
  from?: string
  to?: string
}) {
  return (
    <svg aria-hidden className={`pointer-events-none absolute inset-0 h-full w-full ${className}`}>
      <defs>
        <radialGradient id={`cm-glow-${from.replace(/[^a-z0-9]/gi, "")}`} cx={cx} cy={cy} r={r}>
          <stop offset="0%" stopColor={from} />
          <stop offset="100%" stopColor={to} />
        </radialGradient>
      </defs>
      <rect width="100%" height="100%" fill={`url(#cm-glow-${from.replace(/[^a-z0-9]/gi, "")})`} />
    </svg>
  )
}
