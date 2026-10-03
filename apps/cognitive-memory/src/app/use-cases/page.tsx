import type { Metadata } from "next"

import { Reveal } from "@/components/graphics/reveal"
import { Card, PageGrid, PrimaryLink, SecondaryLink } from "@/components/marketing/ui"
import { SiteFooter } from "@/components/site-footer"
import { SiteHeader } from "@/components/site-header"
import { USE_CASES } from "@/lib/marketing"

export const metadata: Metadata = {
  title: "Use cases",
  description:
    "Coding agents, support agents, research assistants, internal assistants, long-running work, and multi-tenant products — and what the tiering buys each of them."
}

/**
 * Use cases.
 *
 * Each one gets what it tends to store and what the tiering buys it, rather than
 * a generic list of benefits. The second line is the one that decides it: an agent
 * that stores build ids and one that stores research findings need the same
 * machinery for different reasons, and saying so is more useful than six
 * paragraphs about continuity.
 */

export default function UseCasesPage() {
  return (
    <div className="flex min-h-full flex-col">
      <SiteHeader />

      <main className="flex-1">
        <div className="mx-auto w-full max-w-5xl px-6">
          <header className="border-b border-white/[0.06] pb-12 pt-16 sm:pt-24">
            <p className="font-mono text-[11px] uppercase tracking-[0.22em] text-violet-300/70">
              Use cases
            </p>
            <h1 className="mt-5 max-w-3xl text-balance text-4xl font-medium leading-[1.08] tracking-tight sm:text-5xl">
              For agents that have to be right twice
            </h1>
            <p className="mt-6 max-w-2xl text-base leading-7 text-zinc-400">
              The same failure everywhere: an agent that was right last month is
              confidently wrong today, and nothing in the transcript shows which. A
              bounded prompt and a recorded reason for every line are what turn one
              session into continuity.
            </p>
            <div className="mt-8 flex flex-wrap items-center gap-3">
              <PrimaryLink href="/dashboard">Mint an API key</PrimaryLink>
              <SecondaryLink href="/docs/quickstart">The quickstart</SecondaryLink>
            </div>
          </header>

          <section className="py-16 sm:py-20">
            <div className="grid gap-3 sm:grid-cols-2">
              {USE_CASES.map((useCase, index) => (
                <Reveal key={useCase.title} delay={(index % 2) * 80 + Math.floor(index / 2) * 40}>
                  <Card className="h-full">
                    <h2 className="text-sm font-medium text-zinc-100">{useCase.title}</h2>
                    <p className="mt-2 text-[13px] leading-6 text-zinc-400">{useCase.body}</p>
                    <dl className="mt-4 space-y-2 border-t border-white/[0.06] pt-4">
                      <div>
                        <dt className="font-mono text-[9px] uppercase tracking-widest text-zinc-700">
                          Tends to hold
                        </dt>
                        <dd className="mt-1 text-xs leading-5 text-zinc-400">{useCase.holds}</dd>
                      </div>
                      <div>
                        <dt className="font-mono text-[9px] uppercase tracking-widest text-violet-300/50">
                          What tiering buys
                        </dt>
                        <dd className="mt-1 text-xs leading-5 text-zinc-400">{useCase.gain}</dd>
                      </div>
                    </dl>
                  </Card>
                </Reveal>
              ))}
            </div>
          </section>

          <section className="border-t border-white/[0.06] py-16 sm:py-20">
            <div className="max-w-2xl space-y-3">
              <p className="font-mono text-[10px] uppercase tracking-[0.22em] text-violet-300/60">
                If none of these fit
              </p>
              <h2 className="text-balance text-2xl font-medium tracking-tight">
                The requirement underneath all six
              </h2>
              <p className="text-sm leading-6 text-zinc-500">
                You need a store where a fact has a per-turn price, a disagreement is a
                record rather than a coin toss, and you can read every byte your agent
                has been told. If that is the shape of your problem, the use case is
                incidental.
              </p>
            </div>

            <div className="mt-14">
              <PageGrid current="/use-cases" />
            </div>
          </section>
        </div>
      </main>

      <SiteFooter />
    </div>
  )
}
