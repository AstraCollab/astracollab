import Link from "next/link"

import { GridBackdrop, Grain } from "@/components/graphics/backdrop"
import { Reveal } from "@/components/graphics/reveal"
import { MARKETING_PAGES, REFERENCE } from "@/lib/marketing"

/**
 * Marketing furniture.
 *
 * Every page on the marketing site is a layout over data from `lib/marketing`, so
 * these are the only pieces of chrome it needs: a page frame with a heading, a
 * few card shapes, and the two buttons. All server components — the only client
 * JavaScript on these pages is inside a `<Reveal>`.
 */

/**
 * A page.
 *
 * `hero` pages get the lattice and the grain; the rest get neither, because a
 * background on every scroll position turns a site into wallpaper. The
 * decoration belongs at the top of the page and then it is the reader's turn.
 */
export function Page({
  eyebrow,
  title,
  lede,
  children,
  backdrop = false,
  actions
}: {
  eyebrow: string
  title: React.ReactNode
  lede: React.ReactNode
  children: React.ReactNode
  /** The lattice and grain. First page of a section only. */
  backdrop?: boolean
  actions?: React.ReactNode
}) {
  return (
    <div className="flex min-h-full flex-col">
      {backdrop ? (
        <div aria-hidden className="pointer-events-none fixed inset-0 -z-10 overflow-hidden">
          <GridBackdrop />
          <Grain />
        </div>
      ) : null}

      <div className="mx-auto w-full max-w-5xl flex-1 px-6">
        <header className="relative border-b border-white/[0.06] pb-12 pt-16 sm:pt-24">
          <p className="font-mono text-[11px] uppercase tracking-[0.22em] text-violet-300/70">
            {eyebrow}
          </p>
          <h1 className="mt-5 max-w-3xl text-balance text-4xl font-medium leading-[1.08] tracking-tight sm:text-5xl">
            {title}
          </h1>
          <div className="mt-6 max-w-2xl text-base leading-7 text-zinc-400">{lede}</div>
          {actions ? <div className="mt-8 flex flex-wrap items-center gap-3">{actions}</div> : null}
        </header>

        {children}
      </div>
    </div>
  )
}

/** A titled band within a page. */
export function Section({
  eyebrow,
  title,
  lede,
  children,
  className = ""
}: {
  eyebrow?: string
  title: string
  lede?: React.ReactNode
  children: React.ReactNode
  className?: string
}) {
  return (
    <section className={`border-b border-white/[0.06] py-16 last:border-0 sm:py-20 ${className}`}>
      <div className="space-y-8">
        <div className="max-w-2xl space-y-3">
          {eyebrow ? (
            <p className="font-mono text-[10px] uppercase tracking-[0.22em] text-violet-300/60">
              {eyebrow}
            </p>
          ) : null}
          <h2 className="text-balance text-2xl font-medium tracking-tight">{title}</h2>
          {lede ? <p className="text-sm leading-6 text-zinc-500">{lede}</p> : null}
        </div>
        {children}
      </div>
    </section>
  )
}

export function Card({
  children,
  className = "",
  href,
  accent = false
}: {
  children: React.ReactNode
  className?: string
  href?: string
  /** The violet treatment, for the one card that is a destination rather than a
      sibling. Set here rather than passed as a class because the surface and
      border are already set below, and two background-colour utilities on one
      element are resolved by stylesheet order, not by the order they appear in
      the class attribute — so overriding them from `className` is a coin toss. */
  accent?: boolean
}) {
  const className_ = `rounded-xl border p-5 ${
    accent
      ? "border-violet-400/20 bg-violet-500/[0.04] transition hover:border-violet-400/40 hover:bg-violet-500/[0.08]"
      : "border-white/[0.07] bg-white/[0.02]"
  } ${href && !accent ? "transition hover:border-white/[0.16] hover:bg-white/[0.035]" : ""} ${className}`
  return href ? (
    <Link href={href} className={className_}>
      {children}
    </Link>
  ) : (
    <div className={className_}>{children}</div>
  )
}

/**
 * A grid of links to the other marketing pages, then the reference.
 *
 * Takes the *current* page rather than a list of pages to show, because taking a
 * list is what let every subpage link to itself: each one passed
 * `MARKETING_PAGES.filter((page) => page.href !== "/")`, which excludes the
 * overview and nothing else, so `/tiers` shipped a card titled "Tiers & cost"
 * pointing at `/tiers`. Four pages were also passing an empty heading, and the
 * overview was the only one rendering the section at all, so the same component
 * looked like three different sections depending on where you landed. Deriving
 * the list from `current` makes all three mistakes unrepresentable.
 *
 * The heading lives here for the same reason — it is part of the section, and
 * four copies of it is four chances to forget it.
 *
 * Four cards plus the reference, and the reference spans both columns: the odd
 * count would otherwise leave a hole in the last row, and the reference is where
 * these pages are pointing anyway, so giving it the full width says so.
 */
export function PageGrid({ current }: { current: string }) {
  const pages = MARKETING_PAGES.filter((page) => page.href !== current)

  return (
    <div className="space-y-8">
      <div className="max-w-2xl space-y-3">
        <p className="font-mono text-[10px] uppercase tracking-[0.22em] text-violet-300/60">
          Read on
        </p>
        <h2 className="text-balance text-2xl font-medium tracking-tight">
          Four pages, and then the reference
        </h2>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        {pages.map((page, index) => (
          <Reveal key={page.href} delay={index * 60} className="h-full">
            <PageCard {...page} />
          </Reveal>
        ))}

        {/* Spans both columns, so four cards plus this one make three whole rows
            instead of leaving a hole — and the reference is the destination these
            pages are pointing at, so giving it the full width says so. The span
            has to be on the `Reveal`, which is the grid item, not the card. */}
        <Reveal delay={pages.length * 60} className="h-full sm:col-span-2">
          <PageCard {...REFERENCE} accent />
        </Reveal>
      </div>
    </div>
  )
}

/**
 * One card in that grid.
 *
 * The summary grows and the "Read" sits at the bottom of the card, because a
 * grid row is as tall as its tallest cell and a `Read` that follows the text
 * lands at a different height in every column. That ragged edge was the most
 * visible thing wrong with the section before the layout was fixed.
 */
function PageCard({
  href,
  title,
  summary,
  accent = false
}: {
  href: string
  title: string
  summary: string
  accent?: boolean
}) {
  return (
    <Card href={href} accent={accent} className="flex h-full flex-col">
      <h3 className="text-sm font-medium text-zinc-100">{title}</h3>
      <p className="mt-2 flex-1 text-[13px] leading-6 text-zinc-500">{summary}</p>
      <span className="mt-4 inline-flex items-center gap-1.5 font-mono text-[10px] text-violet-200/70">
        Read
        <span aria-hidden>→</span>
      </span>
    </Card>
  )
}

/** A labelled figure with a proportional bar. */
export function Bar({
  label,
  value,
  max,
  tone = "accent",
  suffix = "tok"
}: {
  label: string
  value: number
  max: number
  tone?: "accent" | "muted"
  suffix?: string
}) {
  return (
    <div>
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-xs text-zinc-400">{label}</span>
        <span className="font-mono text-[11px] text-zinc-500">
          {value.toLocaleString()} {suffix}
        </span>
      </div>
      <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-white/[0.06]">
        <div
          className={tone === "accent" ? "h-full bg-violet-400/70" : "h-full bg-white/15"}
          // Never zero: a 0% bar is indistinguishable from a broken chart.
          style={{ width: `${Math.max(2, (value / max) * 100)}%` }}
        />
      </div>
    </div>
  )
}

/** A number with its label and an explanation. */
export function Stat({
  value,
  label,
  detail
}: {
  value: string
  label: string
  detail: string
}) {
  return (
    <div className="py-2">
      <p className="text-2xl font-medium tracking-tight text-zinc-100">{value}</p>
      <p className="mt-1 font-mono text-[10px] uppercase tracking-widest text-violet-300/60">
        {label}
      </p>
      <p className="mt-3 text-xs leading-5 text-zinc-500">{detail}</p>
    </div>
  )
}

export function PrimaryLink({
  href,
  children
}: {
  href: string
  children: React.ReactNode
}) {
  return (
    <Link
      href={href}
      className="inline-flex items-center gap-2 rounded-lg bg-violet-500 px-4 py-2.5 text-[13px] font-medium text-white transition hover:bg-violet-400 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-violet-300"
    >
      {children}
      <span aria-hidden>→</span>
    </Link>
  )
}

export function SecondaryLink({
  href,
  children
}: {
  href: string
  children: React.ReactNode
}) {
  return (
    <Link
      href={href}
      className="inline-flex items-center gap-2 rounded-lg border border-white/12 px-4 py-2.5 text-[13px] text-zinc-300 transition hover:border-white/25 hover:text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-violet-300"
    >
      {children}
    </Link>
  )
}
