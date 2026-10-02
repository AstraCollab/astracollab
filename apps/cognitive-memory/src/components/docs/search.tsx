"use client"

import { useRouter } from "next/navigation"
import { useEffect, useMemo, useRef, useState } from "react"

import { DOC_GROUPS } from "@/lib/docs"

/**
 * Documentation search.
 *
 * Fifteen pages is past the point where the sidebar answers every question, and
 * the reader who knows what they want has a word for it — "truncated", "403",
 * "prior" — that appears in no title. The sidebar is ordered by teaching
 * sequence; this is ordered by the reader's problem.
 *
 * It searches titles, summaries and the keyword list beside each page rather
 * than page bodies, which is a deliberate limit: body text would need an index
 * generated from the built HTML, and an index that silently misses the sentence
 * someone is looking for is worse than one that honestly covers the vocabulary.
 * Every page in fifteen is two keystrokes away anyway.
 *
 * `⌘K` because that is what every other tool does, and a search that needs a
 * different shortcut is a search nobody finds.
 */
export function DocsSearch() {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState("")
  const [cursor, setCursor] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)

  const entries = useMemo(
    () =>
      DOC_GROUPS.flatMap((group) =>
        group.pages.map((page) => ({ page, group: group.label }))
      ),
    []
  )

  const results = useMemo(() => {
    const needle = query.trim().toLowerCase()
    if (needle === "") return entries
    const terms = needle.split(/\s+/)
    return entries
      .map(({ page, group }) => {
        const title = page.title.toLowerCase()
        const haystack = `${title} ${page.summary.toLowerCase()} ${page.keywords.join(" ").toLowerCase()}`
        // Every term has to appear somewhere. Ranking then prefers a title hit,
        // then a keyword hit, then a body-of-summary hit — so typing "tokens"
        // puts the tiers page above the overview that mentions them in passing.
        if (!terms.every((term) => haystack.includes(term))) return null
        let score = 0
        for (const term of terms) {
          if (title.startsWith(term)) score += 8
          else if (title.includes(term)) score += 5
          if (page.keywords.some((keyword) => keyword === term)) score += 4
          else if (page.keywords.some((keyword) => keyword.includes(term))) score += 2
          if (page.summary.toLowerCase().includes(term)) score += 1
        }
        return { page, group, score }
      })
      .filter((entry): entry is { page: (typeof entries)[number]["page"]; group: string; score: number } => entry !== null)
      .sort((a, b) => b.score - a.score)
  }, [entries, query])

  /**
   * Open or close, from the button or the shortcut.
   *
   * The reset is a plain call rather than something inside a `setOpen` updater.
   * Setting state from within another state's updater looks like it works and
   * silently does not — the outer update is discarded — which is why the
   * shortcut was dead while the button was fine.
   */
  function toggleOpen() {
    setQuery("")
    setCursor(0)
    setOpen((was) => !was)
  }

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        // Stops the browser's own "search" behaviour stealing the chord.
        event.preventDefault()
        toggleOpen()
      } else if (event.key === "Escape") {
        setOpen(false)
      }
    }
    document.addEventListener("keydown", onKeyDown)
    return () => document.removeEventListener("keydown", onKeyDown)
  }, [])

  useEffect(() => {
    if (!open) return
    // The dialog is the only thing on the page while it is open, so the input
    // can take focus without any focus-trap machinery.
    inputRef.current?.focus()
    const previous = document.body.style.overflow
    document.body.style.overflow = "hidden"
    return () => {
      document.body.style.overflow = previous
    }
  }, [open])

  function go(href: string) {
    setOpen(false)
    router.push(href)
  }

  return (
    <>
      <button
        type="button"
        onClick={toggleOpen}
        className="flex items-center gap-2 rounded-lg border border-white/[0.08] px-2.5 py-1.5 text-[12px] text-zinc-500 transition hover:border-white/[0.18] hover:text-zinc-300"
      >
        <span>Search</span>
        <kbd className="hidden font-mono text-[10px] text-zinc-700 sm:inline">⌘K</kbd>
      </button>

      {open ? (
        <div
          className="fixed inset-0 z-50 flex items-start justify-center bg-black/60 px-4 pt-[12vh] backdrop-blur-sm"
          onClick={(event) => {
            if (event.target === event.currentTarget) setOpen(false)
          }}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-label="Search documentation"
            className="w-full max-w-lg overflow-hidden rounded-xl border border-white/[0.12] bg-[#0e0e13] shadow-2xl"
          >
            <input
              ref={inputRef}
              value={query}
              onChange={(event) => {
                setQuery(event.target.value)
                // Reset here rather than in an effect: the selection belongs to
                // the query, so it changes when the query does.
                setCursor(0)
              }}
              onKeyDown={(event) => {
                if (event.key === "ArrowDown") {
                  event.preventDefault()
                  setCursor((c) => Math.min(c + 1, results.length - 1))
                } else if (event.key === "ArrowUp") {
                  event.preventDefault()
                  setCursor((c) => Math.max(c - 1, 0))
                } else if (event.key === "Enter" && results[cursor] !== undefined) {
                  event.preventDefault()
                  go(results[cursor].page.href)
                }
              }}
              placeholder="Search the docs…"
              aria-label="Search the documentation"
              className="w-full border-b border-white/[0.08] bg-transparent px-4 py-3 text-[13px] text-zinc-100 outline-none placeholder:text-zinc-600"
            />

            <ul className="max-h-[22rem] overflow-y-auto py-1.5">
              {results.length === 0 ? (
                <li className="px-4 py-6 text-center text-[12px] text-zinc-600">
                  Nothing matches “{query}”.
                </li>
              ) : (
                results.map((entry, index) => (
                  <li key={entry.page.href}>
                    <button
                      type="button"
                      onClick={() => go(entry.page.href)}
                      onMouseEnter={() => setCursor(index)}
                      className={`flex w-full items-baseline gap-3 px-4 py-2 text-left transition ${
                        index === cursor ? "bg-white/[0.06]" : ""
                      }`}
                    >
                      <span className="shrink-0 text-[13px] text-zinc-200">
                        {entry.page.title}
                      </span>
                      <span className="truncate text-[11px] text-zinc-600">
                        {entry.page.summary}
                      </span>
                      <span className="ml-auto shrink-0 font-mono text-[9px] uppercase tracking-widest text-zinc-700">
                        {entry.group}
                      </span>
                    </button>
                  </li>
                ))
              )}
            </ul>

            <p className="border-t border-white/[0.08] px-4 py-2 font-mono text-[9px] uppercase tracking-widest text-zinc-700">
              ↑↓ to move · ↵ to open · esc to close
            </p>
          </div>
        </div>
      ) : null}
    </>
  )
}
