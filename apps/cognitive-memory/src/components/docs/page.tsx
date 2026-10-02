import Link from "next/link"
import type { ReactNode } from "react"

import { docGroupOf, docNeighbours } from "@/lib/docs"

import { DocSections, type DocSectionSpec } from "./primitives"
import { Toc } from "./toc"

/**
 * A documentation page.
 *
 * The frame every page shares: where you are, what is on it, and what to read
 * next. The page supplies its own route so the breadcrumb and the pager can be
 * derived from the map in `lib/docs` rather than restated per page — a pager
 * maintained by hand is wrong within one commit, because adding a page means
 * remembering to renumber the one after it.
 *
 * `sections` is the table of contents as data. Pass it and the contents is
 * rendered on both sides of the page; omit it and the page is a single
 * continuous read with no contents to speak of.
 */
export function DocPage({
  href,
  title,
  description,
  actions,
  lead,
  sections,
  children
}: {
  href: string
  title: string
  description: string
  /** Buttons under the description. Only the overview has any. */
  actions?: ReactNode
  /** Between the header and the first section, where a card grid goes. */
  lead?: ReactNode
  sections?: readonly DocSectionSpec[]
  children?: ReactNode
}) {
  const group = docGroupOf(href)
  const hasContents = sections !== undefined && sections.length > 0

  return (
    <div className="flex gap-10">
      <article className="min-w-0 max-w-2xl flex-1">
        <header className="border-b border-white/[0.06] pb-7">
          {group ? (
            <p className="font-mono text-[10px] uppercase tracking-[0.22em] text-violet-300/60">
              {group.label}
            </p>
          ) : null}
          <h1 className="mt-3 text-3xl font-medium tracking-tight">{title}</h1>
          <p className="mt-4 text-[15px] leading-7 text-zinc-400">{description}</p>
          {actions ? <div className="mt-6 flex flex-wrap gap-3">{actions}</div> : null}
        </header>

        {lead}

        {hasContents ? (
          <>
            {/* Below the rail's breakpoint there is no room for it, so the same
                list collapses into a disclosure. `<details>` rather than a
                toggle so it needs no JavaScript and stays closed until asked. */}
            <details className="mt-8 rounded-xl border border-white/[0.06] bg-white/[0.02] px-4 py-3 xl:hidden">
              <summary className="cursor-pointer text-[13px] text-zinc-300">
                On this page
              </summary>
              <Toc sections={sections} variant="inline" />
            </details>

            <DocSections sections={sections} />
          </>
        ) : null}

        {children}

        <Pager href={href} />
      </article>

      {hasContents ? (
        <nav aria-label="On this page" className="hidden w-40 shrink-0 xl:block">
          <div className="sticky top-20">
            <p className="font-mono text-[9px] uppercase tracking-widest text-zinc-700">
              On this page
            </p>
            <Toc sections={sections} variant="rail" />
          </div>
        </nav>
      ) : null}
    </div>
  )
}

/**
 * Where to go next.
 *
 * Reading order is the useful order for someone new, and the sidebar is the
 * useful thing for someone looking. Both, because they answer different
 * questions, and the pager is the only one that works on a phone.
 */
function Pager({ href }: { href: string }) {
  const { previous, next } = docNeighbours(href)
  if (!previous && !next) return null

  return (
    <nav
      aria-label="Previous and next page"
      className="mt-16 grid gap-3 border-t border-white/[0.06] pt-8 sm:grid-cols-2"
    >
      {previous ? (
        <Link
          href={previous.href}
          className="group rounded-xl border border-white/[0.06] bg-white/[0.02] px-4 py-3 transition hover:border-white/[0.14]"
        >
          <span className="block font-mono text-[9px] uppercase tracking-widest text-zinc-700">
            Previous
          </span>
          <span className="mt-1.5 block text-[13px] text-zinc-300 transition group-hover:text-zinc-100">
            {previous.title}
          </span>
        </Link>
      ) : (
        <span />
      )}
      {next ? (
        <Link
          href={next.href}
          className="group rounded-xl border border-white/[0.06] bg-white/[0.02] px-4 py-3 text-right transition hover:border-white/[0.14]"
        >
          <span className="block font-mono text-[9px] uppercase tracking-widest text-zinc-700">
            Next
          </span>
          <span className="mt-1.5 block text-[13px] text-zinc-300 transition group-hover:text-zinc-100">
            {next.title}
          </span>
        </Link>
      ) : null}
    </nav>
  )
}
