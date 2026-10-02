"use client"

import { useState } from "react"

/**
 * Copy a snippet.
 *
 * Every code block on a reference page exists to be pasted somewhere, and a
 * snippet that has to be selected by hand is where transcription mistakes come
 * from. The label is text rather than an icon because this interface has no icon
 * set, and the state has to be legible without one.
 */
export function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)

  return (
    <button
      type="button"
      onClick={() => {
        void navigator.clipboard.writeText(text).then(
          () => {
            setCopied(true)
            window.setTimeout(() => setCopied(false), 1600)
          },
          () => setCopied(false)
        )
      }}
      className="shrink-0 font-mono text-[9px] uppercase tracking-widest text-zinc-700 transition hover:text-zinc-300"
    >
      {copied ? "Copied" : "Copy"}
    </button>
  )
}
