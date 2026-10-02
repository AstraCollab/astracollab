"use client"

import { useState } from "react"

/**
 * A link to the section you are looking at.
 *
 * Two jobs. It is the obvious affordance for deep-linking a heading, which is
 * how arguments about a specific rule actually get settled. And clicking it
 * copies that link, because a section reference you cannot paste is a section
 * reference you retype — and a retyped URL is a broken one about a third of the
 * time.
 *
 * Hidden until hover so a page of headings does not look like a page of
 * controls, but still in the accessibility tree and reachable by keyboard.
 */
export function AnchorLink({ id }: { id: string }) {
  const [copied, setCopied] = useState(false)

  return (
    <a
      href={`#${id}`}
      onClick={(event) => {
        event.preventDefault()
        const url = `${window.location.origin}${window.location.pathname}#${id}`
        // Update the address bar too: a copied link that the reader cannot also
        // see selected is only half a deep link.
        window.history.replaceState(null, "", `#${id}`)
        navigator.clipboard.writeText(url).then(
          () => {
            setCopied(true)
            window.setTimeout(() => setCopied(false), 1400)
          },
          () => undefined
        )
      }}
      aria-label={copied ? "Link copied" : "Copy link to this section"}
      className="ml-2 select-none align-middle text-zinc-700 opacity-0 transition group-hover:opacity-100 focus-visible:opacity-100 hover:text-violet-300"
    >
      <span aria-hidden className="font-mono text-[13px]">
        {copied ? "✓" : "#"}
      </span>
    </a>
  )
}
