import type { ComponentProps } from "react"

export function Textarea({ className, ...props }: ComponentProps<"textarea">) {
  return (
    <textarea
      className={
        `w-full rounded-[0.75rem] border border-input bg-[var(--surface-inset)] px-3 py-2 text-sm text-[var(--ink)] shadow-xs outline-none transition-colors placeholder:text-[var(--ink-faint)] focus-visible:border-signal ${className ?? ""}`
      }
      {...props}
    />
  )
}
