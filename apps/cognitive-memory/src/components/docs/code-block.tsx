import { highlightLines, type CodeLanguage } from "@/lib/highlight"

import { CopyButton } from "./copy-button"

/**
 * A code block.
 *
 * Highlighted on the server, so the parser never reaches the browser, and copied
 * as the raw source rather than the rendered spans — a copy button that hands
 * back markup is worse than no copy button.
 *
 * `emphasise` takes 1-based line numbers and tints them. It exists because the
 * useful thing about most of these snippets is one line in the middle: the
 * `truncated: true` you have to check for, the `domain` that makes the self-model
 * work, the line that decides whether the turn learns at all. Pointing at it is
 * more use than another sentence of prose.
 */
export function CodeBlock({
  children,
  language = "text",
  title,
  emphasise
}: {
  children: string
  language?: CodeLanguage
  /** A filename or path, shown instead of the language. */
  title?: string
  /** 1-based line numbers to tint. */
  emphasise?: readonly number[]
}) {
  const source = children.replace(/\n+$/, "")
  const lines = highlightLines(source, language)
  const marked = new Set(emphasise ?? [])

  return (
    <div className="overflow-hidden rounded-xl border border-white/[0.08] bg-black/40">
      <div className="flex items-center justify-between gap-3 border-b border-white/[0.06] px-4 py-1.5">
        <span className="truncate font-mono text-[9px] uppercase tracking-widest text-zinc-700">
          {title ?? language}
        </span>
        <CopyButton text={source} />
      </div>
      <pre className="overflow-x-auto px-4 py-3.5 font-mono text-[11px] leading-5">
        <code>
          {lines.map((html, index) => (
            <span
              key={index}
              className={`block ${marked.has(index + 1) ? "-mx-4 bg-violet-400/[0.07] px-4" : ""}`}
              // Produced by `highlightLines`, which escapes the source before
              // wrapping it. Nothing else in the app emits raw HTML.
              dangerouslySetInnerHTML={{ __html: html === "" ? "" : html }}
            />
          ))}
        </code>
      </pre>
    </div>
  )
}
