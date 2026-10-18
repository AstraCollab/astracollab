import type { ComponentProps } from "react"

/**
 * A form control on the shared theme.
 *
 * The shared palette is defined in `.landing, .auth, .app` in `globals.css`, so
 * this needs almost no colour of its own: `bg-background` and `border-input`
 * already resolve to the theme's inset surface and hairline. It sets geometry and
 * nothing else, which is what keeps a new input from being a second design.
 */
export function Input({ className, ...props }: ComponentProps<"input">) {
  return (
    <input
      className={
        `flex h-9 w-full rounded-[0.75rem] border border-input bg-[var(--surface-inset)] px-3 py-1 text-sm text-[var(--ink)] shadow-xs outline-none transition-colors placeholder:text-[var(--ink-faint)] focus-visible:border-signal disabled:opacity-50 ${className ?? ""}`
      }
      {...props}
    />
  )
}
