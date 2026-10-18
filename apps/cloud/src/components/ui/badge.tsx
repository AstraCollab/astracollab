import type { ReactNode } from "react"

/**
 * A status word.
 *
 * `tone` rather than a variant per status, because the dashboard has exactly four
 * states it recurs between — good, busy, stopped, broken — and every one of them
 * appears on the agents list, the runs list and the sandboxes list. One component
 * that owns the mapping is what stops those three pages from inventing three
 * slightly different greens.
 */
export type BadgeTone = "neutral" | "busy" | "good" | "warn" | "bad"

const TONES: Record<BadgeTone, string> = {
  neutral: "border-line text-[var(--ink-muted)]",
  busy: "border-signal/40 text-signal",
  good: "border-emerald-500/40 text-emerald-300",
  warn: "border-amber-500/40 text-amber-300",
  bad: "border-red-500/40 text-red-300"
}

export function Badge({
  tone = "neutral",
  children,
  className
}: {
  readonly tone?: BadgeTone
  readonly children: ReactNode
  readonly className?: string
}) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 font-mono-tech text-[10px] uppercase tracking-[0.12em] ${TONES[tone]} ${className ?? ""}`}
    >
      {children}
    </span>
  )
}
