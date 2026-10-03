import type { Metadata } from "next"
import Link from "next/link"

import { Reveal } from "@/components/graphics/reveal"
import { PrimaryLink, PageGrid, SecondaryLink } from "@/components/marketing/ui"
import { SiteFooter } from "@/components/site-footer"
import { SiteHeader } from "@/components/site-header"
import { FAQ } from "@/lib/marketing"

export const metadata: Metadata = {
  title: "Questions",
  description:
    "The three that decide whether this is the right tool — what it costs, whether it needs a model, and why it is not a vector database — plus everything else worth answering honestly."
}

/**
 * Questions.
 *
 * On its own page rather than a disclosure stack at the bottom of the landing
 * page, because a disclosure that is closed by default is an answer nobody reads
 * — and these are the answers that decide whether somebody integrates.
 *
 * The three marked decisive are pulled out at the top. Burying "is this just a
 * vector database" under eight other questions would be a way of not answering it.
 */

const DECISIVE = FAQ.filter((item) => item.decisive)
const THE_REST = FAQ.filter((item) => !item.decisive)

export default function FaqPage() {
  return (
    <div className="flex min-h-full flex-col">
      <SiteHeader />

      <main className="flex-1">
        <div className="mx-auto w-full max-w-5xl px-6">
          <header className="border-b border-white/[0.06] pb-12 pt-16 sm:pt-24">
            <p className="font-mono text-[11px] uppercase tracking-[0.22em] text-violet-300/70">
              Questions
            </p>
            <h1 className="mt-5 max-w-3xl text-balance text-4xl font-medium leading-[1.08] tracking-tight sm:text-5xl">
              The ones worth answering honestly
            </h1>
            <p className="mt-6 max-w-2xl text-base leading-7 text-zinc-400">
              Including the three that decide whether this is the right tool for you.
              Where the honest answer is a limitation, it is a limitation — the
              alternatives are documented in the{" "}
              <Link href="/docs" className="text-violet-200 hover:text-violet-100">
                reference
              </Link>
              .
            </p>
            <div className="mt-8 flex flex-wrap items-center gap-3">
              <PrimaryLink href="/dashboard">Mint an API key</PrimaryLink>
              <SecondaryLink href="/docs/self-hosting">Run it yourself</SecondaryLink>
            </div>
          </header>

          {/* The three that decide the fit. */}
          <section className="border-b border-white/[0.06] py-16 sm:py-20">
            <div className="max-w-2xl space-y-3">
              <p className="font-mono text-[10px] uppercase tracking-[0.22em] text-violet-300/60">
                Decide the fit
              </p>
              <h2 className="text-balance text-2xl font-medium tracking-tight">
                Read these three first
              </h2>
            </div>
            <div className="mt-8 grid gap-3 lg:grid-cols-3">
              {DECISIVE.map((item, index) => (
                <Reveal key={item.q} delay={index * 80}>
                  <article className="h-full rounded-xl border border-violet-300/15 bg-violet-500/[0.035] p-5">
                    <h3 className="text-[13px] font-medium leading-5 text-zinc-100">
                      {item.q}
                    </h3>
                    <p className="mt-3 text-xs leading-5 text-zinc-400">{item.a}</p>
                  </article>
                </Reveal>
              ))}
            </div>
          </section>

          {/* Everything else, as a plain list. */}
          <section className="py-16 sm:py-20">
            <div className="max-w-2xl space-y-3">
              <p className="font-mono text-[10px] uppercase tracking-[0.22em] text-violet-300/60">
                Everything else
              </p>
              <h2 className="text-balance text-2xl font-medium tracking-tight">
                And the rest of it
              </h2>
            </div>
            <div className="mt-8 divide-y divide-white/[0.06] overflow-hidden rounded-xl border border-white/[0.08]">
              {THE_REST.map((item, index) => (
                <Reveal key={item.q} delay={Math.min(index, 4) * 50}>
                  <details className="group px-5 py-5">
                    <summary className="flex cursor-pointer list-none items-start justify-between gap-4 text-[13px] leading-5 text-zinc-200 marker:hidden">
                      {item.q}
                      <span
                        aria-hidden
                        className="mt-0.5 shrink-0 font-mono text-zinc-600 transition group-open:rotate-45"
                      >
                        +
                      </span>
                    </summary>
                    <p className="mt-3 max-w-3xl text-[13px] leading-6 text-zinc-500">
                      {item.a}
                    </p>
                  </details>
                </Reveal>
              ))}
            </div>
          </section>

          <section className="border-t border-white/[0.06] pt-14">
            <PageGrid current="/faq" />
          </section>
        </div>
      </main>

      <SiteFooter />
    </div>
  )
}
