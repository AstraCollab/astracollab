import Link from "next/link"
import type { ReactNode } from "react"

import type { DocPage } from "@/lib/docs"

import { AnchorLink } from "./anchor-link"


/**
 * The vocabulary every documentation page is written in.
 *
 * A reference page is mostly prose, a couple of tables and some code, so the
 * markup is factored out here rather than repeated fifteen times. The alternative
 * — the inline `<pre>` blocks the pages used to carry — means the code treatment
 * has to be restated at every call site, and one page ends up with a slightly
 * different grey.
 */

/**
 * How an identifier, a link or an emphasis looks inside running text.
 *
 * These are descendant selectors rather than components because the whole point
 * is that an author cannot get them wrong: a bare `<code>` used to render as
 * whatever the browser decided, which is how the same word ended up in three
 * different typefaces across one page. Writing `<code>` and letting the prose
 * style it is the only version that stays consistent.
 *
 * Split out from `PROSE` because `Warning` sits outside the prose wrapper and
 * still has to style its own contents.
 */
const INLINE =
  "[&_a]:text-violet-200 [&_a]:underline [&_a]:underline-offset-2 [&_a]:transition hover:[&_a]:text-violet-100 " +
  "[&_b]:text-zinc-200 [&_em]:text-zinc-300 " +
  "[&_code]:rounded [&_code]:bg-white/[0.06] [&_code]:px-1 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-[11px] [&_code]:text-zinc-200"

/** Body text: the inline treatment, a reading measure, and paragraph spacing. */
const PROSE =
  "max-w-2xl space-y-4 text-[13px] leading-6 text-zinc-400 " +
  INLINE +
  // Inside a code block the text is already set, so the inline treatment has to
  // step aside or every snippet gets a highlighted box around each token.
  " [&_pre_code]:bg-transparent [&_pre_code]:p-0 [&_pre_code]:text-[12px]"

export function Prose({ children }: { children: ReactNode }) {
  return <div className={`max-w-2xl ${PROSE}`}>{children}</div>
}

/** One heading and its body. The unit the table of contents is built from. */
export function Section({
  id,
  title,
  children
}: {
  id: string
  title: string
  children: ReactNode
}) {
  return (
    <section id={id} className="group scroll-mt-20 space-y-4 pt-12 first:pt-0">
      <h2 className="text-lg font-medium tracking-tight">
        {title}
        <AnchorLink id={id} />
      </h2>
      <Prose>{children}</Prose>
    </section>
  )
}

/**
 * A section with its body supplied as data.
 *
 * The table of contents is derived from this rather than maintained beside it.
 * A hand-written list of anchors duplicates every heading, and the copy rots the
 * first time a heading is reworded — at which point the sidebar links to
 * something that is no longer there, silently.
 */
export interface DocSectionSpec {
  readonly id: string
  readonly title: string
  readonly body: ReactNode
}

export function DocSections({ sections }: { sections: readonly DocSectionSpec[] }) {
  return (
    <>
      {sections.map((section) => (
        <Section key={section.id} id={section.id} title={section.title}>
          {section.body}
        </Section>
      ))}
    </>
  )
}

/**
 * A rule stated on its own.
 *
 * Used for the sentences that are the reason a design decision is defensible —
 * the merge rule, the prior on the reliability average. Burying one in a
 * paragraph is how a constraint stops being read as a constraint.
 */
export function Callout({ children }: { children: ReactNode }) {
  return (
    <p className="rounded-lg border-l-2 border-violet-400/50 bg-violet-500/[0.05] px-4 py-3 text-zinc-300">
      {children}
    </p>
  )
}

/** A warning, for the thing that is easy to get wrong rather than hard. */
export function Warning({ title, children }: { title: string; children: ReactNode }) {
  return (
    <aside className="rounded-lg border border-amber-400/20 bg-amber-400/[0.05] px-4 py-3">
      <p className="font-mono text-[10px] uppercase tracking-widest text-amber-300/80">{title}</p>
      <div className={`mt-1.5 text-[13px] leading-6 text-zinc-400 ${INLINE}`}>{children}</div>
    </aside>
  )
}

/**
 * A grid of links to other pages.
 *
 * The index needs to do two jobs: say what the service is, and get someone to
 * the page that answers their actual question. A list of fifteen links in reading
 * order serves neither, because nobody arriving cold has a reading order yet —
 * they have a symptom, and four cards named after the symptom is a better
 * answer than fifteen named after the architecture.
 */
export function PageCards({
  pages,
  label
}: {
  readonly pages: readonly DocPage[]
  label?: string
}) {
  return (
    <div className="pt-8">
      {label ? (
        <p className="font-mono text-[9px] uppercase tracking-widest text-zinc-700">{label}</p>
      ) : null}
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        {pages.map((page) => (
          <Link
            key={page.href}
            href={page.href}
            className="group rounded-xl border border-white/[0.06] bg-white/[0.02] px-4 py-3.5 transition hover:border-white/[0.14] hover:bg-white/[0.035]"
          >
            <span className="block text-[13px] font-medium text-zinc-200 transition group-hover:text-white">
              {page.title}
            </span>
            <span className="mt-1.5 block text-xs leading-5 text-zinc-500">{page.summary}</span>
          </Link>
        ))}
      </div>
    </div>
  )
}

export interface DocColumn {
  readonly label: string
  /** A CSS width. Columns without one share what is left. */
  readonly width?: string
  /** Set for columns holding identifiers: paths, methods, tier names. */
  readonly mono?: boolean
}

/**
 * A reference table.
 *
 * A real `<table>`, in a scroll container. The endpoint and method tables are
 * the pages people read to find one line, and they are read on a phone more
 * often than anyone designing them expects — which a grid of divs handles by
 * squashing the path column until it wraps per character.
 */
export function DocTable({
  columns,
  rows,
  hrefs
}: {
  readonly columns: readonly DocColumn[]
  readonly rows: ReadonlyArray<ReadonlyArray<ReactNode>>
  /** One entry per row. A row with an href renders as a link. */
  readonly hrefs?: ReadonlyArray<string | undefined>
}) {
  return (
    <div className="overflow-x-auto rounded-xl border border-white/[0.08]">
      <table className="w-full min-w-[32rem] border-collapse text-left">
        <thead>
          <tr className="border-b border-white/[0.07] bg-white/[0.03]">
            {columns.map((column) => (
              <th
                key={column.label}
                style={column.width ? { width: column.width } : undefined}
                className="px-4 py-2 font-mono text-[10px] font-normal uppercase tracking-widest text-zinc-600"
              >
                {column.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => {
            const href = hrefs?.[index]
            const cells = row.map((cell, cellIndex) => {
              const column = columns[cellIndex]
              return (
                <td
                  key={cellIndex}
                  className={
                    column?.mono
                      ? "px-4 py-2.5 align-top font-mono text-[11px] text-violet-200"
                      : "px-4 py-2.5 align-top text-xs leading-5 text-zinc-500"
                  }
                >
                  {cell}
                </td>
              )
            })
            return href ? (
              <tr
                key={index}
                className="border-b border-white/[0.05] transition last:border-0 hover:bg-white/[0.03]"
              >
                {/* `contents` so the cells stay in the row's layout while the
                    whole row becomes one link rather than four separate ones. */}
                <Link href={href} className="contents">
                  {cells}
                </Link>
              </tr>
            ) : (
              <tr key={index} className="border-b border-white/[0.05] last:border-0">
                {cells}
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
