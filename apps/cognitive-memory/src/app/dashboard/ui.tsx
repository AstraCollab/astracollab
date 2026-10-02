"use client"

import { useState, type ReactNode } from "react"

/**
 * The dashboard's shared pieces.
 *
 * Extracted because ten pages need the same twenty things — a metric tile, a
 * panel, a tier badge, an empty state — and a dashboard where each page invents
 * its own border radius is a dashboard that reads as nine products. Every class
 * string here matches the language the first version of these panels established:
 * low chrome, thin borders, monospace for anything countable.
 */

export const panelClass = "rounded-xl border border-white/[0.08] bg-white/[0.02]"
export const inputClass =
  "w-full rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2 text-[13px] text-zinc-200 outline-none transition placeholder:text-zinc-700 focus:border-violet-400/50"
export const labelClass = "font-mono text-[10px] uppercase tracking-widest text-zinc-600"

/* -------------------------------------------------------------------------- */
/* Layout                                                                      */
/* -------------------------------------------------------------------------- */

export function PageHeader({
  title,
  description,
  actions
}: {
  title: string
  description: ReactNode
  actions?: ReactNode
}) {
  return (
    <header className="flex flex-wrap items-start justify-between gap-4">
      <div className="space-y-2">
        <h1 className="text-lg font-medium">{title}</h1>
        <div className="max-w-2xl space-y-2 text-[13px] leading-6 text-zinc-500">{description}</div>
      </div>
      {actions && <div className="flex shrink-0 gap-2">{actions}</div>}
    </header>
  )
}

export function Panel({
  title,
  hint,
  actions,
  children,
  className = ""
}: {
  title: string
  hint?: ReactNode
  actions?: ReactNode
  children: ReactNode
  className?: string
}) {
  return (
    <section className={`${panelClass} ${className}`}>
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-white/[0.06] px-4 py-3">
        <div className="min-w-0 space-y-1">
          <h2 className="text-[13px] font-medium text-zinc-200">{title}</h2>
          {hint && <p className="text-[11px] leading-4 text-zinc-600">{hint}</p>}
        </div>
        {actions && <div className="flex shrink-0 items-center gap-1.5">{actions}</div>}
      </div>
      <div className="p-4">{children}</div>
    </section>
  )
}

export function Grid({ children, cols = 4 }: { children: ReactNode; cols?: 2 | 3 | 4 | 5 }) {
  const span: Record<2 | 3 | 4 | 5, string> = {
    2: "grid-cols-2",
    3: "grid-cols-2 sm:grid-cols-3",
    4: "grid-cols-2 sm:grid-cols-4",
    5: "grid-cols-2 sm:grid-cols-3 lg:grid-cols-5"
  }
  return <div className={`grid gap-2 ${span[cols]}`}>{children}</div>
}

/* -------------------------------------------------------------------------- */
/* Countables                                                                  */
/* -------------------------------------------------------------------------- */

export function Metric({
  label,
  value,
  hint,
  tone = "plain"
}: {
  label: string
  value: ReactNode
  hint?: ReactNode
  tone?: "plain" | "warn" | "good" | "bad"
}) {
  const colour = {
    plain: "text-zinc-200",
    warn: "text-amber-300",
    good: "text-emerald-300",
    bad: "text-red-300"
  }[tone]
  return (
    <div className="rounded-lg border border-white/[0.06] bg-white/[0.015] px-4 py-3">
      <p className={`${labelClass} truncate`}>{label}</p>
      <p className={`mt-1 text-xl tabular-nums ${colour}`}>{value}</p>
      {hint && <p className="mt-0.5 text-[10px] leading-4 text-zinc-600">{hint}</p>}
    </div>
  )
}

export function Bar({
  value,
  tone = "violet"
}: {
  /** 0 to 1. Values above 1 are clamped rather than trusted. */
  value: number
  tone?: "violet" | "amber" | "emerald" | "red"
}) {
  const colour = {
    violet: "bg-violet-400/60",
    amber: "bg-amber-400/70",
    emerald: "bg-emerald-400/60",
    red: "bg-red-400/60"
  }[tone]
  return (
    <div className="h-1.5 overflow-hidden rounded-full bg-white/[0.06]">
      <div
        className={`h-full ${colour}`}
        style={{ width: `${Math.min(100, Math.max(value * 100, value > 0 ? 2 : 0))}%` }}
      />
    </div>
  )
}

export function Badge({
  children,
  tone = "neutral",
  title
}: {
  children: ReactNode
  tone?: "neutral" | "violet" | "amber" | "emerald" | "red"
  title?: string
}) {
  const colour = {
    neutral: "bg-white/[0.06] text-zinc-400",
    violet: "bg-violet-400/10 text-violet-200/90",
    amber: "bg-amber-300/10 text-amber-200/80",
    emerald: "bg-emerald-400/10 text-emerald-200/80",
    red: "bg-red-400/10 text-red-300/80"
  }[tone]
  return (
    <span
      title={title}
      className={`inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 font-mono text-[9px] ${colour}`}
    >
      {children}
    </span>
  )
}

/**
 * A tier, coloured by what it costs.
 *
 * L0 and L1 are in every prompt; L2 and L3 cost nothing until something asks. The
 * colours are deliberately ordered by brightness so the list of memories reads as
 * a spending profile from top to bottom.
 */
export function TierBadge({ tier }: { tier: string }) {
  const tone = tier === "L0" ? "red" : tier === "L1" ? "amber" : tier === "L2" ? "violet" : "neutral"
  return <Badge tone={tone} title={TIER_HINT[tier] ?? tier}>{tier}</Badge>
}

export const TIER_HINT: Record<string, string> = {
  L0: "always injected in full",
  L1: "indexed every prompt, body on trigger",
  L2: "scored against each turn",
  L3: "cold, recallable"
}

/* -------------------------------------------------------------------------- */
/* Controls                                                                    */
/* -------------------------------------------------------------------------- */

export function Button({
  children,
  onClick,
  type = "button",
  variant = "ghost",
  disabled,
  title,
  size = "md",
  className = ""
}: {
  children: ReactNode
  onClick?: () => void
  type?: "button" | "submit"
  variant?: "primary" | "ghost" | "danger" | "quiet"
  disabled?: boolean
  title?: string
  size?: "sm" | "md"
  /** For the rare case where a button has to sit somewhere this component cannot reach. */
  className?: string
}) {
  const base =
    size === "sm" ? "rounded-md px-2 py-1 text-[11px]" : "rounded-lg px-3.5 py-2 text-[13px]"
  const colour = {
    primary: "bg-violet-500 font-medium text-white hover:bg-violet-400",
    ghost: "border border-white/12 text-zinc-300 hover:border-white/25 hover:text-white",
    danger: "border border-red-400/25 text-red-300/80 hover:bg-red-400/10 hover:text-red-200",
    quiet: "text-zinc-500 hover:text-zinc-200"
  }[variant]
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={`${base} transition disabled:opacity-40 ${colour} ${className}`}
    >
      {children}
    </button>
  )
}

export function Field({
  label,
  hint,
  children
}: {
  label: string
  hint?: ReactNode
  children: ReactNode
}) {
  return (
    <label className="block space-y-1.5">
      <span className={labelClass}>{label}</span>
      {children}
      {hint && <span className="block text-[11px] leading-4 text-zinc-600">{hint}</span>}
    </label>
  )
}

export function Segmented<T extends string>({
  value,
  options,
  onChange
}: {
  value: T
  options: ReadonlyArray<{ value: T; label: string; title?: string }>
  onChange: (value: T) => void
}) {
  return (
    <div className="flex gap-0.5 rounded-lg border border-white/[0.08] bg-white/[0.02] p-0.5">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          title={option.title}
          onClick={() => onChange(option.value)}
          className={`rounded-md px-2.5 py-1 text-[11px] transition ${
            value === option.value
              ? "bg-white/[0.08] text-zinc-100"
              : "text-zinc-500 hover:text-zinc-200"
          }`}
        >
          {option.label}
        </button>
      ))}
    </div>
  )
}

export function Toggle({
  checked,
  onChange,
  label,
  hint
}: {
  checked: boolean
  onChange: (checked: boolean) => void
  label: string
  hint?: ReactNode
}) {
  return (
    <label className="flex cursor-pointer items-start gap-2.5">
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
        className="mt-0.5 accent-violet-500"
      />
      <span className="space-y-0.5">
        <span className="block text-[13px] text-zinc-300">{label}</span>
        {hint && <span className="block text-[11px] leading-4 text-zinc-600">{hint}</span>}
      </span>
    </label>
  )
}

export function CopyButton({
  value,
  label = "copy",
  className = ""
}: {
  value: string
  label?: string
  className?: string
}) {
  const [copied, setCopied] = useState(false)
  return (
    <button
      type="button"
      onClick={() => {
        void navigator.clipboard.writeText(value).then(() => {
          setCopied(true)
          // Copied is shown for a moment rather than until the next click: a
          // label that never clears stops being information.
          setTimeout(() => setCopied(false), 1600)
        })
      }}
      className={`shrink-0 rounded-md border border-white/10 px-2 py-1 font-mono text-[10px] text-zinc-400 transition hover:border-white/25 hover:text-zinc-100 ${className}`}
    >
      {copied ? "copied" : label}
    </button>
  )
}

/* -------------------------------------------------------------------------- */
/* States                                                                      */
/* -------------------------------------------------------------------------- */

export function Loading({ label = "Loading…" }: { label?: string }) {
  return <p className="py-6 text-center text-[13px] text-zinc-600">{label}</p>
}

export function Failure({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-red-400/20 bg-red-400/[0.05] px-4 py-3">
      <p className="text-[13px] text-red-200/90">{message}</p>
      {onRetry && (
        <Button size="sm" onClick={onRetry}>
          Try again
        </Button>
      )}
    </div>
  )
}

export function Empty({
  title,
  children
}: {
  title: string
  children?: ReactNode
}) {
  return (
    <div className="rounded-xl border border-dashed border-white/[0.08] px-6 py-8 text-center">
      <p className="text-[13px] text-zinc-400">{title}</p>
      {children && <div className="mx-auto mt-3 max-w-lg text-[12px] leading-5 text-zinc-600">{children}</div>}
    </div>
  )
}

/** A scrollable code block. `secret` gets the do-not-paste styling. */
export function Code({
  children,
  secret,
  className = ""
}: {
  children: string
  secret?: boolean
  className?: string
}) {
  return (
    <pre
      className={`max-h-[520px] overflow-auto whitespace-pre-wrap rounded-lg px-4 py-3 font-mono text-[11px] leading-5 text-zinc-400 ${
        secret ? "secret" : "border border-white/[0.06] bg-black/40"
      } ${className}`}
    >
      {children}
    </pre>
  )
}

/** Key/value rows, for the places that are really a table that happens to fit. */
export function Facts({ rows }: { rows: ReadonlyArray<[string, ReactNode]> }) {
  return (
    <dl className="divide-y divide-white/[0.05]">
      {rows.map(([key, value]) => (
        <div key={key} className="flex items-baseline justify-between gap-4 py-2">
          <dt className="text-[12px] text-zinc-500">{key}</dt>
          <dd className="min-w-0 truncate text-right font-mono text-[12px] text-zinc-300">{value}</dd>
        </div>
      ))}
    </dl>
  )
}

export function Table({ head, children }: { head: ReactNode; children: ReactNode }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-[13px]">
        <thead>
          <tr className="border-b border-white/[0.06] text-[10px] uppercase tracking-widest text-zinc-600">
            {head}
          </tr>
        </thead>
        <tbody className="divide-y divide-white/[0.04]">{children}</tbody>
      </table>
    </div>
  )
}

export const Th = ({
  children,
  className = "",
  title
}: {
  children?: ReactNode
  className?: string
  title?: string
}) => (
  <th title={title} className={`py-2 pr-4 font-normal ${className}`}>
    {children}
  </th>
)

export const Td = ({ children, className = "" }: { children?: ReactNode; className?: string }) => (
  <td className={`py-2 pr-4 align-top ${className}`}>{children}</td>
)