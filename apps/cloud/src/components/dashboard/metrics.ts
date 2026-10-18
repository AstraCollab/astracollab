/**
 * Formatting for the observability surfaces.
 *
 * Every one of these takes the value as a plain number rather than reaching for a
 * unit library, because the whole surface is four columns of integers and a
 * dependency that renders "1.2k" would need a unit prefix table maintained
 * somewhere.
 */

/**
 * US dollars from a micros integer.
 *
 * Cost is stored as micros — millionths of a dollar — so that the arithmetic that
 * produces it never touches a float. Formatting is where the float finally
 * appears, and only here: divide once, render, done. Rounding to cents is not
 * cosmetic, it is the only precision a dollar amount has.
 */
export function formatUsd(micros: number | null | undefined): string {
  if (micros === null || micros === undefined) return "—"
  const dollars = micros / 1_000_000
  if (dollars === 0) return "$0.00"
  // Under a cent, a fixed 2dp would show "$0.00" for real spend — the trace that
  // burned tokens for a fraction of a penny reads as free. Four decimals keeps it
  // visible.
  if (Math.abs(dollars) < 0.01) return `$${dollars.toFixed(4)}`
  return `$${dollars.toFixed(2)}`
}

/**
 * A duration in ms, at a precision that matches its magnitude.
 *
 * A waterfall reads as a sequence of comparisons, so `1,203ms` and `1.20s` are
 * not cosmetic differences — they are the difference between "this is the slow
 * one" being obvious and having to do the division in your head.
 */
export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return "—"
  if (ms < 1) return "<1ms"
  if (ms < 1000) return `${Math.round(ms)}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(2)}s`
  const minutes = Math.floor(ms / 60_000)
  const seconds = Math.round((ms % 60_000) / 1000)
  return `${minutes}m ${seconds}s`
}

/**
 * Token counts, abbreviated past five digits.
 *
 * Exact below that. A tool call that reads "4,231 tokens" is a fact a reader can
 * act on; "4.2k" is a shape they have to trust.
 */
export function formatTokens(count: number | null | undefined): string {
  if (count === null || count === undefined) return "—"
  if (count < 10_000) return count.toLocaleString("en-US")
  if (count < 1_000_000) return `${(count / 1000).toFixed(1)}k`
  return `${(count / 1_000_000).toFixed(2)}M`
}

/** Epoch ms to a short local clock time. */
export function formatTime(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return "—"
  return new Date(ms).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  })
}

/** A short clock time for a waterfall row, where seconds are all that fit. */
export function formatClock(ms: number): string {
  return new Date(ms).toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  })
}

/**
 * A trace or span id, shortened for display.
 *
 * First eight and last four. Trace ids are hex, so eight characters is 32 bits of
 * a 128-bit id — enough to be unique within any list a human reads, while the
 * full id stays one click away in the detail page. The middle is elided rather
 * than the tail because the tail of a hash is where the entropy actually varies.
 */
export function shortId(id: string): string {
  if (id.length <= 16) return id
  return `${id.slice(0, 8)}…${id.slice(-4)}`
}