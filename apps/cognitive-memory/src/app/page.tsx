import type { Metadata } from "next"
import Link from "next/link"

import { CodeBlock } from "@/components/docs/code-block"
import { Glow, Grain, GridBackdrop } from "@/components/graphics/backdrop"
import { Reveal } from "@/components/graphics/reveal"
import { TierLadder } from "@/components/graphics/tier-ladder"
import {
  Card,
  PageGrid,
  PrimaryLink,
  SecondaryLink,
  Stat
} from "@/components/marketing/ui"
import { SiteFooter } from "@/components/site-footer"
import { SiteHeader } from "@/components/site-header"
import {
  CAPABILITIES,
  HTTP_SAMPLE,
  RECEIPT,
  RECEIPT_CEILING,
  RECEIPT_TOTAL,
  STATS,
  TURN_SAMPLE
} from "@/lib/marketing"

export const metadata: Metadata = {
  title: "Cognitive Memory — a budget and a paper trail",
  description:
    "A four-tier memory service for agents. Every line injected into a prompt carries the rule that selected it and its token cost, so the per-turn budget is a decision rather than an accident."
}

/**
 * The overview.
 *
 * Its job is to answer one question properly — what this is, and why it is not a
 * vector store with a nicer name — and then get out of the way. Everything the
 * four other marketing pages argue at length is here as a link and a single line,
 * because a landing page that tries to be the manual is a manual nobody reads.
 *
 * The hero shows the `/v1/context` receipt rather than the rendered prompt. The
 * prompt is a consequence; the receipt is the evidence, and it is the part a
 * reader cannot get from a competitor's documentation.
 */

export default function Home() {
  return (
    <div className="flex min-h-full flex-col">
      {/* The lattice, the grain and the bloom, all behind the headerless hero. */}
      <div aria-hidden className="pointer-events-none absolute inset-x-0 top-0 -z-10 h-[880px] overflow-hidden">
        <GridBackdrop />
        <Grain />
        {/* Drifts very slowly. CSS-only, and inert when motion is reduced. */}
        <div data-drift="" className="absolute inset-0">
          <Glow className="opacity-70" />
        </div>
      </div>

      <SiteHeader />

      <main className="flex-1">
        {/* Hero */}
        <section className="relative border-b border-white/[0.06]">
          <div className="mx-auto w-full max-w-5xl px-6 pb-20 pt-16 sm:pt-24">
            <p className="font-mono text-[11px] uppercase tracking-[0.22em] text-violet-300/70">
              A budget and a paper trail
            </p>
            <h1 className="mt-5 max-w-3xl text-balance text-4xl font-medium leading-[1.08] tracking-tight sm:text-5xl">
              Every line comes with a reason and a price.{" "}
              <span className="text-zinc-500">Nothing enters the prompt unattributed.</span>
            </h1>
            <p className="mt-6 max-w-2xl text-base leading-7 text-zinc-400">
              You cannot budget what has no price. Cognitive Memory files what an agent
              is told into four tiers — a gist line by default, a full body only where
              something concrete earned it — and returns the reason and the token cost
              of every line it injects.
            </p>

            <div className="mt-9 flex flex-wrap items-center gap-3">
              <PrimaryLink href="/dashboard">Mint an API key</PrimaryLink>
              <SecondaryLink href="/docs">Read the reference</SecondaryLink>
            </div>
            <p className="mt-4 text-xs text-zinc-600">
              Self-hosted SQLite · REST API · TypeScript SDK · learns with no model key set
            </p>
          </div>
        </section>

        {/* The receipt. This is the proof; the rest of the site is the argument. */}
        <section className="border-b border-white/[0.06]">
          <div className="mx-auto w-full max-w-5xl space-y-10 px-6 py-16 sm:py-20">
                <Reveal>
              <div className="overflow-hidden rounded-xl border border-white/[0.08] bg-black/40">
                <div className="flex items-center justify-between border-b border-white/[0.06] px-4 py-2">
                  <span className="font-mono text-[10px] uppercase tracking-widest text-zinc-600">
                    one turn, itemised
                  </span>
                  <span className="font-mono text-[10px] text-zinc-700">POST /v1/context</span>
                </div>

                <div className="divide-y divide-white/[0.04]">
                  {RECEIPT.map((line) => (
                    <div
                      key={line.id}
                      className="grid grid-cols-[auto_1fr_auto] items-center gap-3 px-4 py-2.5"
                    >
                      <span className="w-[62px] font-mono text-[10px] uppercase tracking-wide text-zinc-700">
                        {line.tier}
                      </span>
                      <div className="min-w-0">
                        <p className="truncate text-[13px] leading-5 text-zinc-300">
                          {line.gist}
                        </p>
                        <p className="mt-0.5 text-[11px] leading-4 text-zinc-600">{line.why}</p>
                      </div>
                      <div className="flex items-center gap-2">
                        <span className="rounded border border-white/[0.08] px-1.5 py-0.5 font-mono text-[10px] text-violet-200/80">
                          {line.reason}
                        </span>
                        <span className="w-12 text-right font-mono text-[11px] text-zinc-500">
                          {line.tokens}
                        </span>
                      </div>
                    </div>
                  ))}
                </div>

                <div className="border-t border-white/[0.06] px-4 py-3">
                  <div className="flex items-baseline justify-between">
                    <span className="text-[11px] text-zinc-500">
                      {RECEIPT_TOTAL} of a {RECEIPT_CEILING.toLocaleString()} token ceiling
                    </span>
                    <span className="font-mono text-[10px] text-zinc-700">
                      truncated: false
                    </span>
                  </div>
                  <div className="mt-2 h-1 overflow-hidden rounded-full bg-white/[0.06]">
                    <div
                      className="h-full rounded-full bg-violet-400/70"
                      style={{ width: `${(RECEIPT_TOTAL / RECEIPT_CEILING) * 100}%` }}
                    />
                  </div>
                </div>
              </div>
            </Reveal>
          </div>
        </section>

        {/* Numbers */}
        <section className="border-b border-white/[0.06] bg-white/[0.015]">
          <div className="mx-auto grid w-full max-w-5xl gap-8 px-6 py-12 sm:grid-cols-2 lg:grid-cols-4">
            {STATS.map((stat, index) => (
              <Reveal key={stat.label} delay={index * 70}>
                <Stat {...stat} />
              </Reveal>
            ))}
          </div>
        </section>

        {/* What the numbers above are spent on. */}
        <section className="border-b border-white/[0.06]">
          <div className="mx-auto w-full max-w-5xl px-6 py-14 sm:py-16">
            <TierLadder />
          </div>
        </section>

        {/* What this is */}
        <section className="border-b border-white/[0.06]">
          <div className="mx-auto w-full max-w-5xl space-y-8 px-6 py-16 sm:py-20">
            <div className="max-w-2xl space-y-3">
              <p className="font-mono text-[10px] uppercase tracking-[0.22em] text-violet-300/60">
                What this is
              </p>
              <h2 className="text-balance text-2xl font-medium tracking-tight">
                A memory store that tells you what it cost
              </h2>
              <p className="text-sm leading-6 text-zinc-500">
                Keeping facts is the easy half. The part that decides whether an agent
                is usable in production is everything around them: what a stored fact
                costs per turn, which line earned its place, what was refused, and why a
                recall came back empty.
              </p>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              {CAPABILITIES.map((capability, index) => (
                <Reveal key={capability.title} delay={index * 60}>
                  <Card className="h-full">
                    <h3 className="text-sm font-medium text-zinc-100">{capability.title}</h3>
                    <p className="mt-2 text-[13px] leading-6 text-zinc-400">{capability.body}</p>
                    <p className="mt-3 border-l border-white/[0.08] pl-3 text-xs leading-5 text-zinc-600">
                      {capability.aside}
                    </p>
                  </Card>
                </Reveal>
              ))}
            </div>
          </div>
        </section>

        {/* The rest of the site */}
        <section className="border-b border-white/[0.06]">
          <div className="mx-auto w-full max-w-5xl px-6 py-16 sm:py-20">
            <PageGrid current="/" />
          </div>
        </section>

        {/* Two calls */}
        <section className="border-b border-white/[0.06]">
          <div className="mx-auto w-full max-w-5xl space-y-8 px-6 py-16 sm:py-20">
            <div className="max-w-2xl space-y-3">
              <p className="font-mono text-[10px] uppercase tracking-[0.22em] text-violet-300/60">
                Integration
              </p>
              <h2 className="text-balance text-2xl font-medium tracking-tight">
                Two calls, in any language
              </h2>
              <p className="text-sm leading-6 text-zinc-500">
                Build context before the model runs. Record the turn after it finishes.
                There is one official SDK, and it is the only one you need to install —
                everything else is JSON over HTTP.
              </p>
            </div>
            <div className="grid gap-3 lg:grid-cols-2">
              <CodeBlock language="ts" title="TypeScript">{TURN_SAMPLE}</CodeBlock>
              <CodeBlock language="sh" title="Any language">{HTTP_SAMPLE}</CodeBlock>
            </div>
            <p className="text-sm text-zinc-500">
              The SDK is ~3kB gzipped, ESM-first, and depends on one small fetch
              wrapper. It also ships the deterministic engine, so the same ranking and
              tiering can run in-process with no service at all.{" "}
              <Link href="/docs/integrating" className="text-violet-200 hover:text-violet-100">
                Integrating with an agent →
              </Link>
            </p>
          </div>
        </section>

        {/* CTA */}
        <section className="border-b border-white/[0.06]">
          <div className="mx-auto w-full max-w-5xl px-6 py-20 text-center">
            <h2 className="text-balance text-2xl font-medium tracking-tight">
              Give every token your agent spends a receipt.
            </h2>
            <p className="mx-auto mt-3 max-w-xl text-sm leading-6 text-zinc-500">
              Create an account, make an organisation, and mint a key. The secret is
              shown once, because only a hash is stored.
            </p>
            <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
              <PrimaryLink href="/dashboard">Open the dashboard</PrimaryLink>
              <SecondaryLink href="/docs">Read the reference</SecondaryLink>
            </div>
          </div>
        </section>
      </main>

      <SiteFooter />
    </div>
  )
}
