"use client"

import { useId, useState, type ReactNode } from "react"

/**
 * The same call in several languages, or in several shapes.
 *
 * A reader arrives knowing which of the two they want — TypeScript if they are
 * wiring the SDK, curl if they are checking a deployment or writing a test
 * against the raw HTTP — and a page that shows one and merely mentions the other
 * makes half of them translate it themselves. The failure mode of a transcript
 * style is that the reader has to keep the other tabs in their head to follow
 * this one; the labels are right there instead.
 *
 * All panels stay mounted and only the inactive ones are hidden, so the code is
 * findable with the browser's own search and the tab strip is a filter rather
 * than a fork of the page.
 */
export function CodeTabs({
  tabs,
  initial = 0
}: {
  tabs: ReadonlyArray<{ label: string; node: ReactNode }>
  initial?: number
}) {
  const [active, setActive] = useState(initial)
  const group = useId()

  if (tabs.length === 0) return null
  const only = tabs.length === 1

  return (
    <div className="my-5">
      {!only ? (
        <div
          role="tablist"
          aria-label="Code variant"
          className="mb-2 flex gap-1 overflow-x-auto"
          onKeyDown={(event) => {
            // Roving focus, so tabbing moves past the strip instead of through
            // every variant — which is the behaviour a keyboard user expects from
            // a tablist and the reason the arrow keys are handled here at all.
            const delta = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0
            if (delta === 0) return
            event.preventDefault()
            const next = (active + delta + tabs.length) % tabs.length
            setActive(next)
            document.getElementById(`${group}-tab-${next}`)?.focus()
          }}
        >
          {tabs.map((tab, index) => (
            <button
              key={tab.label}
              id={`${group}-tab-${index}`}
              role="tab"
              type="button"
              aria-selected={active === index}
              aria-controls={`${group}-panel-${index}`}
              tabIndex={active === index ? 0 : -1}
              onClick={() => setActive(index)}
              className={`shrink-0 rounded-md px-2.5 py-1 font-mono text-[10px] tracking-widest transition ${
                active === index
                  ? "bg-white/[0.07] text-zinc-100"
                  : "text-zinc-600 hover:bg-white/[0.03] hover:text-zinc-300"
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>
      ) : null}

      {tabs.map((tab, index) => (
        <div
          key={tab.label}
          id={`${group}-panel-${index}`}
          role="tabpanel"
          aria-labelledby={`${group}-tab-${index}`}
          hidden={active !== index}
        >
          {/* The block carries its own top margin, which would double up under
              the tab strip but is wanted when a page uses one block alone. */}
          <div className="[&>*:first-child]:mt-0">{tab.node}</div>
        </div>
      ))}
    </div>
  )
}
