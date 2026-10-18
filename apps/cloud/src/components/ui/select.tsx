import type { ComponentProps } from "react"

/**
 * A form select control on the shared theme.
 * Matches the Input component styling but for <select> elements.
 */
export function Select({ className, ...props }: ComponentProps<"select">) {
  return (
    <select
      className={
        `flex h-9 w-full rounded-[0.75rem] border border-input bg-[var(--surface-inset)] px-3 py-1 text-sm text-[var(--ink)] shadow-xs outline-none transition-colors placeholder:text-[var(--ink-faint)] focus-visible:border-signal disabled:opacity-50 ${className ?? ""}`
      }
      {...props}
    />
  )
}