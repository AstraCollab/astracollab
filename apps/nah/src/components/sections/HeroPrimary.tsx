"use client";

import Link from "next/link";
import { ArrowDown, ArrowRight, Check, Code2, Copy, MoveUpRight } from "lucide-react";
import { motion } from "framer-motion";
import { useState } from "react";

const reveal = { initial: { opacity: 0, y: 30 }, whileInView: { opacity: 1, y: 0 }, viewport: { once: true }, transition: { duration: 0.7, ease: [0.22, 1, 0.36, 1] as const } };

export function HeroPrimary() {
  const [copied, setCopied] = useState(false);
  const [copiedStudio, setCopiedStudio] = useState(false);
  async function copyInstall() {
    try {
      await navigator.clipboard.writeText("npm install -g nah-ai");
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      setCopied(false);
    }
  }
  async function copyStudio() {
    try {
      await navigator.clipboard.writeText("npx --yes nah-studio");
      setCopiedStudio(true);
      window.setTimeout(() => setCopiedStudio(false), 1800);
    } catch {
      setCopiedStudio(false);
    }
  }

  return (
    <section id="top" className="relative flex min-h-screen scroll-mt-16 flex-col overflow-hidden border-b border-white/10">
      <header className="fixed inset-x-0 top-0 z-50 border-b border-white/10 bg-zinc-950/70 backdrop-blur-md">
        <nav className="mx-auto flex h-16 max-w-7xl items-center justify-between px-5 sm:px-8" aria-label="Main navigation">
          <Link href="#top" className="flex items-center gap-2.5 text-sm font-semibold tracking-tight text-zinc-100">
            <span className="grid size-7 place-items-center rounded-lg border border-white/10 bg-white/[0.06] font-mono text-xs">n.</span>
            nah (not another harness)
          </Link>
          <div className="hidden items-center gap-7 text-xs text-zinc-400 md:flex">
            <Link className="transition hover:text-white" href="/docs">Docs</Link>
            <Link className="transition hover:text-white" href="#reasoning">Framework</Link>
            <Link className="transition hover:text-white" href="#tools">Tools</Link>
            <Link className="transition hover:text-white" href="#control">The agent</Link>
          </div>
          <Link href="/docs" className="group inline-flex shrink-0 items-center gap-2 whitespace-nowrap rounded-full border border-white/10 bg-white/[0.06] px-3.5 py-2 text-xs text-zinc-200 transition hover:border-white/20 hover:bg-white/10">
            Read the docs <MoveUpRight className="size-3.5 shrink-0 transition group-hover:-translate-y-0.5 group-hover:translate-x-0.5" />
          </Link>
        </nav>
      </header>

      <div className="pointer-events-none absolute inset-0 -z-0" aria-hidden="true">
        <div className="absolute inset-0 opacity-[0.035] [background-image:linear-gradient(rgba(255,255,255,.8)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,.8)_1px,transparent_1px)] [background-size:72px_72px] [mask-image:linear-gradient(to_bottom,black,transparent_90%)]" />
        <div className="absolute left-1/2 top-[22%] h-[28rem] w-[44rem] -translate-x-1/2 rounded-full bg-indigo-500/20 blur-[120px]" />
      </div>

      <div className="relative z-10 mx-auto flex w-full max-w-7xl flex-1 flex-col items-center justify-center px-5 pb-16 pt-28 text-center sm:px-8">
        <motion.div {...reveal} className="mb-8">
          <Link href="/docs" className="group inline-flex max-w-full items-center gap-2 whitespace-nowrap rounded-full border border-white/10 bg-white/[0.04] px-3 py-1.5 font-mono text-[11px] text-zinc-300 transition hover:border-indigo-300/30 hover:bg-indigo-300/[0.06]">
            <span className="size-1.5 shrink-0 rounded-full bg-indigo-300" />
            <span className="truncate">An agentic framework, and the agent built on it</span> <ArrowRight className="size-3 shrink-0 text-zinc-500 transition group-hover:translate-x-0.5 group-hover:text-indigo-200" />
          </Link>
        </motion.div>
        <motion.h1 {...reveal} transition={{ ...reveal.transition, delay: 0.08 }} className="max-w-5xl text-balance text-3xl font-medium leading-[1.05] tracking-[-0.055em] text-transparent sm:text-5xl lg:text-[3.6rem]">
          <span className="bg-gradient-to-b from-white via-zinc-200 to-zinc-500 bg-clip-text">Stop fighting black-box agents.</span>
          <br className="hidden sm:block" />
          <span className="bg-gradient-to-b from-zinc-100 to-zinc-500 bg-clip-text">Build or run on a real harness.</span>
        </motion.h1>
        <motion.p {...reveal} transition={{ ...reveal.transition, delay: 0.16 }} className="mt-7 max-w-3xl text-pretty text-base leading-7 text-zinc-400 sm:text-lg">
          nah is a terminal coding agent. not-another-harness is the framework powering it. Take the CLI, take the loop, or take both.
        </motion.p>
        <motion.div {...reveal} transition={{ ...reveal.transition, delay: 0.24 }} className="mt-9 flex w-full flex-col items-center justify-center gap-3 sm:w-auto sm:flex-row">
          <Link href="/docs/installation" className="inline-flex w-full items-center justify-center gap-2 whitespace-nowrap rounded-full bg-zinc-100 px-5 py-3 text-sm font-medium text-zinc-950 transition hover:bg-white sm:w-auto">
            Get started <ArrowRight className="size-4 shrink-0" />
          </Link>
          <button type="button" onClick={copyInstall} className="inline-flex w-full min-w-0 items-center justify-between gap-4 rounded-full border border-white/10 bg-zinc-900/70 px-4 py-3 font-mono text-xs text-zinc-300 transition hover:border-white/20 sm:w-auto" aria-label="Copy NAH CLI install command">
            <span className="min-w-0 truncate"><span className="text-zinc-600">$</span> npm install -g nah-ai</span>
            {copied ? <Check className="size-3.5 shrink-0 text-emerald-400" /> : <Copy className="size-3.5 shrink-0 text-zinc-500" />}
          </button>
        </motion.div>
        <motion.button {...reveal} transition={{ ...reveal.transition, delay: 0.28 }} type="button" onClick={copyStudio} className="mt-5 inline-flex max-w-full items-center gap-2 whitespace-nowrap rounded-full border border-white/10 bg-white/[0.03] px-3.5 py-2 font-mono text-[11px] text-zinc-400 transition hover:border-white/20 hover:text-zinc-200" aria-label="Copy the nah-studio command to run a dashboard without installing">
          <span className="shrink-0 text-zinc-600">$</span> npx --yes nah-studio <span className="text-zinc-600">· dashboard, no install</span>
          {copiedStudio ? <Check className="size-3.5 shrink-0 text-emerald-400" /> : <Copy className="size-3.5 shrink-0 text-zinc-500" />}
        </motion.button>
        <motion.div {...reveal} transition={{ ...reveal.transition, delay: 0.32 }} className="mt-20 flex items-center gap-3 text-[10px] font-mono uppercase tracking-[0.18em] text-zinc-600">
          <Code2 className="size-3.5" /> Open source · AI SDK v5 · Agent, or the agent you write <span className="mx-2 h-px w-8 bg-white/10" />
          <Link href="#reasoning" className="inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap transition hover:text-zinc-300">See how it works <ArrowDown className="size-3 shrink-0" /></Link>
        </motion.div>
      </div>
      <div className="pointer-events-none absolute inset-x-0 bottom-0 h-32 bg-gradient-to-t from-zinc-950 to-transparent" />
    </section>
  );
}
