import Link from "next/link"

import { DocsSearch } from "./docs/search"

/**
 * The header.
 *
 * Sticky, because the documentation link matters more than usual: a visitor
 * deciding whether to trust a memory service wants the reference open in the
 * other tab, and a nav that scrolls away punishes that.
 *
 * `width` is a parameter because the documentation frame is three columns wide
 * and the marketing pages are one. Sharing the component keeps a single nav to
 * maintain; passing the container keeps the logo aligned with the content
 * instead of hanging in a narrower column of its own.
 */
export function SiteHeader({ width = "max-w-5xl" }: { width?: string }) {
  return (
    <header className="sticky top-0 z-20 border-b border-white/[0.06] bg-[#08080b]/85 backdrop-blur">
      <div className={`mx-auto flex w-full ${width} items-center justify-between px-6 py-3.5`}>
        <Link href="/" className="flex items-center gap-2.5">
          <Mark />
          <span className="text-[13px] font-medium tracking-tight">Cognitive Memory</span>
        </Link>

        <nav className="hidden items-center gap-7 text-[13px] text-zinc-400 sm:flex">
          <Link href="/#tiers" className="transition hover:text-zinc-100">
            How it works
          </Link>
          <Link href="/docs" className="transition hover:text-zinc-100">
            Docs
          </Link>
          <Link href="/dashboard" className="transition hover:text-zinc-100">
            Dashboard
          </Link>
        </nav>

        <div className="flex items-center gap-2">
          <DocsSearch />
          <Link
            href="/dashboard"
            className="rounded-lg border border-white/12 px-3 py-1.5 text-[12px] text-zinc-200 transition hover:border-violet-400/40 hover:bg-violet-500/10"
          >
            Get a key
          </Link>
        </div>
      </div>
    </header>
  )
}

/**
 * The mark: four stacked bars, L0 through L3, with the top one lit.
 *
 * Drawn rather than lettered because the four tiers are the idea, and a logo is
 * the one place an idea gets remembered.
 */
export function Mark() {
  return (
    <span aria-hidden className="flex h-4 w-4 flex-col justify-between">
      <span className="h-[3px] w-full rounded-[1px] bg-violet-400" />
      <span className="h-[3px] w-3/4 rounded-[1px] bg-violet-400/50" />
      <span className="h-[3px] w-1/2 rounded-[1px] bg-violet-400/25" />
      <span className="h-[3px] w-1/4 rounded-[1px] bg-violet-400/15" />
    </span>
  )
}
