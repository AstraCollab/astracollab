import type { Metadata } from "next"
import Link from "next/link"

import { TensionDiagram } from "@/components/graphics/tension-diagram"
import { Reveal } from "@/components/graphics/reveal"
import {
  Card,
  PageGrid,
  PrimaryLink,
  SecondaryLink
} from "@/components/marketing/ui"
import { SiteFooter } from "@/components/site-footer"
import { SiteHeader } from "@/components/site-header"
import { STEPS } from "@/lib/marketing"

export const metadata: Metadata = {
  title: "How it works",
  description:
    "Five steps from a statement to a bounded prompt block: capture, reconcile, file, plan, inject. Only one of them can use a model, and by default none of them do."
}

/**
 * The loop.
 *
 * One idea per step, and a link to the page that argues it properly. The
 * argument that matters is the *order*: capture runs deterministically before
 * anything optional, and the block is assembled before the model is called rather
 * than from whatever the model remembered to ask for. Both are decisions, and
 * both are invisible if you only read the output.
 */

const WHY_ORDER = [
  {
    q: "Why is capture first, and deterministic?",
    a: "A model is a good judge and a poor witness. It can refuse, hedge, or return nothing, and a fact the user plainly stated then never gets learned at all. Patterns run first so a plainly-stated fact is captured even with no provider configured — health reports rules-only, so you know which mode you are in."
  },
  {
    q: "Why is the block built before the model runs?",
    a: "Because the alternative is asking the model what it would like to remember, and paying for the answer. Pre-injecting an index means the agent starts the turn knowing what is held, and the block is assembled deterministically from the message being answered rather than from a model's guess about it."
  },
  {
    q: "Why does a new fact land hot rather than after a promotion pass?",
    a: "Waiting for a pass added a turn of latency, which meant a fact you taught on one turn was still missing from the very next prompt. That is the most visible possible way for memory to look broken, so L1 is the default home and demotion is the deliberate act."
  },
  {
    q: "What happens to something that does not fit?",
    a: "It is kept apart rather than forced in. A merge that would drop a distinctive token is refused and both entries survive, because a duplicate costs one row and a lost fact is gone for good."
  }
] as const

export default function HowItWorksPage() {
  return (
    <div className="flex min-h-full flex-col">
      <SiteHeader />

      <main className="flex-1">
        <div className="mx-auto w-full max-w-5xl px-6">
          <header className="border-b border-white/[0.06] pb-12 pt-16 sm:pt-24">
            <p className="font-mono text-[11px] uppercase tracking-[0.22em] text-violet-300/70">
              The loop
            </p>
            <h1 className="mt-5 max-w-3xl text-balance text-4xl font-medium leading-[1.08] tracking-tight sm:text-5xl">
              Five steps, and only one of them can use a model
            </h1>
            <p className="mt-6 max-w-2xl text-base leading-7 text-zinc-400">
              A statement arrives in a conversation. It is checked against what is
              already known, folded in or kept apart, filed in a tier, and then either
              indexed or written out in full — depending on what the message in front of
              it actually referred to.
            </p>
            <div className="mt-8 flex flex-wrap items-center gap-3">
              <PrimaryLink href="/dashboard">Mint an API key</PrimaryLink>
              <SecondaryLink href="/docs/integrating">See the integration</SecondaryLink>
            </div>
          </header>

          {/* The five steps. A connecting rail rather than five boxes side by
              side, because this is a sequence and the horizontal row read as a
              set of equal options. */}
          <section className="border-b border-white/[0.06] py-16 sm:py-20">
            <ol className="relative space-y-px">
              {STEPS.map((step, index) => (
                <Reveal key={step.n} delay={index * 70}>
                  <li className="relative border-l border-white/[0.08] pb-10 pl-8 last:pb-0 sm:pl-10">
                    <span
                      aria-hidden
                      className="absolute -left-[3.5px] top-1.5 size-[7px] rounded-full bg-violet-400/70 ring-4 ring-[#08080b]"
                    />
                    <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                      <span className="font-mono text-[10px] tracking-widest text-violet-300/50">
                        {step.n}
                      </span>
                      <h2 className="text-lg font-medium tracking-tight text-zinc-100">
                        {step.title}
                      </h2>
                    </div>
                    <p className="mt-2 max-w-2xl text-sm leading-6 text-zinc-400">
                      {step.body}
                    </p>
                    <Link
                      href={step.href}
                      className="mt-3 inline-flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-widest text-zinc-600 transition hover:text-violet-200"
                    >
                      {step.hrefLabel}
                      <span aria-hidden>→</span>
                    </Link>
                  </li>
                </Reveal>
              ))}
            </ol>
          </section>

          {/* The one case a list of strings cannot hold. */}
          <section className="border-b border-white/[0.06] py-16 sm:py-20">
            <div className="max-w-2xl space-y-3">
              <p className="font-mono text-[10px] uppercase tracking-[0.22em] text-violet-300/60">
                Step 04 · plan
              </p>
              <h2 className="text-balance text-2xl font-medium tracking-tight">
                When two stored claims disagree, the disagreement is a record
              </h2>
              <p className="text-sm leading-6 text-zinc-500">
                A flat list has nowhere to put &ldquo;these disagree&rdquo;. It
                stores both and one quietly wins, or it drops one and never says so.
                Here the pair is kept, pinned into every prompt, and the question goes
                to a person — because picking a winner is a decision the service has no
                standing to make.
              </p>
            </div>
            <div className="mt-10">
              <TensionDiagram />
            </div>
            <p className="mt-8 text-sm text-zinc-500">
              <Link href="/docs/tensions" className="text-violet-200 hover:text-violet-100">
                How contradictions are detected and resolved →
              </Link>
            </p>
          </section>

          {/* The questions the order answers. */}
          <section className="py-16 sm:py-20">
            <div className="max-w-2xl space-y-3">
              <p className="font-mono text-[10px] uppercase tracking-[0.22em] text-violet-300/60">
                The questions
              </p>
              <h2 className="text-balance text-2xl font-medium tracking-tight">
                Four decisions that are invisible in the output
              </h2>
            </div>
            <div className="mt-8 grid gap-3 sm:grid-cols-2">
              {WHY_ORDER.map((item, index) => (
                <Reveal key={item.q} delay={index * 60}>
                  <Card className="h-full">
                    <h3 className="text-[13px] font-medium text-zinc-100">{item.q}</h3>
                    <p className="mt-2 text-xs leading-5 text-zinc-500">{item.a}</p>
                  </Card>
                </Reveal>
              ))}
            </div>

            <div className="mt-14">
              <PageGrid current="/how-it-works" />
            </div>
          </section>
        </div>
      </main>

      <SiteFooter />
    </div>
  )
}
