import type { Metadata } from "next"
import Link from "next/link"

import { Reveal } from "@/components/graphics/reveal"
import { TokenBudget } from "@/components/graphics/token-budget"
import { Bar, Card, PageGrid, PrimaryLink, SecondaryLink } from "@/components/marketing/ui"
import { SiteFooter } from "@/components/site-footer"
import { SiteHeader } from "@/components/site-header"
import { EVERY_BODY_TOKENS, INDEX_TOKENS, REASONS, TIERS } from "@/lib/marketing"

export const metadata: Metadata = {
  title: "Tiers & cost",
  description:
    "What a memory costs per turn, the four rules that decide it, and why a budget that is mostly index lines means the store needs promoting rather than a bigger ceiling."
}

/**
 * Tiers and cost.
 *
 * The differentiator, given its own page. Everything else on this site is a
 * consequence of the claim made here: that per-turn cost is a decision, and that
 * you can see which rule spent it.
 *
 * The field drawing at the top is the argument in one image — the same store,
 * thinning as it gets colder — and the measured bars below are the claim it
 * makes good on.
 */

export default function TiersPage() {
  return (
    <div className="flex min-h-full flex-col">
      <SiteHeader />

      <main className="flex-1">
        <div className="mx-auto w-full max-w-5xl px-6">
          <header className="border-b border-white/[0.06] pb-12 pt-16 sm:pt-24">
            <p className="font-mono text-[11px] uppercase tracking-[0.22em] text-violet-300/70">
              Tiers &amp; cost
            </p>
            <h1 className="mt-5 max-w-3xl text-balance text-4xl font-medium leading-[1.08] tracking-tight sm:text-5xl">
              Four tiers, one budget
            </h1>
            <p className="mt-6 max-w-2xl text-base leading-7 text-zinc-400">
              One turn&rsquo;s block, drawn to scale against the ceiling it has to fit inside: what each tier costs, and how much of the window is left for the task rather than for the memory.
            </p>
            <div className="mt-8 flex flex-wrap items-center gap-3">
              <PrimaryLink href="/docs/tiers">The full tier reference</PrimaryLink>
              <SecondaryLink href="/docs/injection">What goes into the prompt</SecondaryLink>
            </div>
          </header>

          {/* The budget, to scale. */}
          <section className="border-b border-white/[0.06] py-14 sm:py-16">
            <TokenBudget />
          </section>

          {/* The tiers in full. */}
          <section className="border-b border-white/[0.06] py-16 sm:py-20">
            <div className="max-w-2xl space-y-3">
              <p className="font-mono text-[10px] uppercase tracking-[0.22em] text-violet-300/60">
                The tiers
              </p>
              <h2 className="text-balance text-2xl font-medium tracking-tight">
                What each one holds, and what it costs
              </h2>
            </div>

            <div className="mt-8 overflow-hidden rounded-xl border border-white/[0.08]">
              <div className="hidden grid-cols-[64px_130px_1fr_180px] gap-4 border-b border-white/[0.07] bg-white/[0.03] px-5 py-2.5 font-mono text-[10px] uppercase tracking-widest text-zinc-600 sm:grid">
                <span>Tier</span>
                <span>Name</span>
                <span>Holds</span>
                <span>Cost per turn</span>
              </div>
              {TIERS.map((tier, index) => (
                <Reveal key={tier.tier} delay={index * 60}>
                  <div className="grid gap-1 border-b border-white/[0.05] px-5 py-4 last:border-0 sm:grid-cols-[64px_130px_1fr_180px] sm:gap-4">
                    <code className="font-mono text-[12px] text-violet-200">{tier.tier}</code>
                    <span className="text-[13px] text-zinc-200">{tier.name}</span>
                    <div>
                      <p className="text-[13px] leading-5 text-zinc-400">{tier.holds}</p>
                      <p className="mt-1 text-xs text-zinc-600">{tier.when}</p>
                    </div>
                    <span className="text-xs leading-5 text-zinc-500">{tier.cost}</span>
                  </div>
                </Reveal>
              ))}
            </div>
          </section>

          {/* The rules that decide it. */}
          <section className="border-b border-white/[0.06] py-16 sm:py-20">
            <div className="max-w-2xl space-y-3">
              <p className="font-mono text-[10px] uppercase tracking-[0.22em] text-violet-300/60">
                Injection reasons
              </p>
              <h2 className="text-balance text-2xl font-medium tracking-tight">
                Four reasons a line is there
              </h2>
              <p className="text-sm leading-6 text-zinc-500">
                Every line carries the rule that selected it. Four reasons is a small
                enough set that a token bill can be attributed, which is what makes
                analytics an argument rather than a decoration.
              </p>
            </div>

            <div className="mt-8 grid gap-6 lg:grid-cols-[1fr_320px]">
              <div className="overflow-hidden rounded-xl border border-white/[0.08]">
                <div className="grid grid-cols-[104px_116px_1fr] gap-3 border-b border-white/[0.07] bg-white/[0.03] px-4 py-2.5 font-mono text-[10px] uppercase tracking-widest text-zinc-600">
                  <span>Reason</span>
                  <span>Included</span>
                  <span>What earned it</span>
                </div>
                {REASONS.map((item, index) => (
                  <Reveal key={item.reason} delay={index * 50}>
                    <div className="grid grid-cols-[104px_116px_1fr] gap-3 border-b border-white/[0.05] px-4 py-3 last:border-0">
                      <code className="font-mono text-[11px] text-violet-200">
                        {item.reason}
                      </code>
                      <span className="text-xs text-zinc-300">{item.included}</span>
                      <span className="text-xs leading-5 text-zinc-500">{item.why}</span>
                    </div>
                  </Reveal>
                ))}
              </div>

              <Reveal delay={120}>
                <Card className="h-full">
                  <p className="font-mono text-[10px] uppercase tracking-widest text-zinc-600">
                    measured, 200 memories
                  </p>
                  <div className="mt-4 space-y-4">
                    <Bar label="Index + triggers" value={INDEX_TOKENS} max={EVERY_BODY_TOKENS} />
                    <Bar label="Every body" value={EVERY_BODY_TOKENS} max={EVERY_BODY_TOKENS} tone="muted" />
                  </div>
                  <p className="mt-4 text-xs leading-5 text-zinc-500">
                    Same 200 facts. 77% fewer tokens, and the window keeps its room for
                    the actual task.
                  </p>
                  <p className="mt-3 text-[11px] leading-5 text-zinc-700">
                    Chroma&rsquo;s 2025 context-rot report measures accuracy falling as
                    input length grows, with the damage coming from topically-related
                    distractors rather than from structure.
                  </p>
                  <p className="mt-3 text-[11px] text-zinc-700">
                    Reproduce with <code className="font-mono">pnpm measure</code>.
                  </p>
                </Card>
              </Reveal>
            </div>
          </section>

          {/* Reading the number. */}
          <section className="py-16 sm:py-20">
            <div className="max-w-2xl space-y-3">
              <p className="font-mono text-[10px] uppercase tracking-[0.22em] text-violet-300/60">
                Reading your own bill
              </p>
              <h2 className="text-balance text-2xl font-medium tracking-tight">
                The shape of the spend tells you what to fix
              </h2>
            </div>
            <div className="mt-8 grid gap-3 sm:grid-cols-2">
              {[
                {
                  headline: "Mostly index lines, no bodies",
                  body: "Not a budget problem. A store with nothing worth promoting, and the opposite fix — promote more, do not raise the ceiling.",
                  tone: "amber"
                },
                {
                  headline: "One trigger body per turn",
                  body: "Healthy. Something concrete was named each time and exactly one memory earned a full body.",
                  tone: "violet"
                },
                {
                  headline: "truncated: true on most turns",
                  body: "The ceiling is doing its job and the store is larger than the window. Raise it, or accept a smaller hot set — both are legitimate, neither is silent.",
                  tone: "amber"
                },
                {
                  headline: "A tension on every build",
                  body: "Something is being contradicted often enough to pin itself into every prompt. That is a queue for a human, not a budget.",
                  tone: "violet"
                }
              ].map((item, index) => (
                <Reveal key={item.headline} delay={index * 60}>
                  <Card className="h-full">
                    <p
                      className={`text-[13px] font-medium ${
                        item.tone === "amber" ? "text-amber-200" : "text-violet-200"
                      }`}
                    >
                      {item.headline}
                    </p>
                    <p className="mt-2 text-xs leading-5 text-zinc-500">{item.body}</p>
                  </Card>
                </Reveal>
              ))}
            </div>
            <p className="mt-8 text-sm text-zinc-500">
              The dashboard splits the spend by the same four rules, per endpoint and
              per key.{" "}
              <Link href="/docs/dashboard" className="text-violet-200 hover:text-violet-100">
                The dashboard reference →
              </Link>
            </p>

            <div className="mt-14">
              <PageGrid current="/tiers" />
            </div>
          </section>
        </div>
      </main>

      <SiteFooter />
    </div>
  )
}
