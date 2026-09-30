"use client";

import Link from "next/link";
import { ArrowRight, Check, CircleDashed, FileCode2, Lock, Search, Terminal } from "lucide-react";
import { motion } from "framer-motion";

const reveal = { initial: { opacity: 0, y: 30 }, whileInView: { opacity: 1, y: 0 }, viewport: { once: true }, transition: { duration: 0.7, ease: [0.22, 1, 0.36, 1] as const } };
const toolGroups = [
  { title: "Inspect", tools: "read · list · grep", detail: "Find context with bounded file reads, directory listings, and content search.", icon: Search, tone: "violet" },
  { title: "Change", tools: "edit · write", detail: "Require read-before-write by default. Gate changes with an approval callback.", icon: FileCode2, tone: "cyan" },
  { title: "Execute", tools: "bash · optional", detail: "Run workspace commands with a timeout. Disable bash when a task should stay read-only.", icon: Terminal, tone: "amber" },
];

export function HeroOrchestration() {
  return (
    <section id="tools" className="relative flex min-h-screen scroll-mt-16 items-center overflow-hidden border-b border-white/10 py-24 sm:py-28">
      <div className="pointer-events-none absolute inset-0 opacity-[0.03] [background-image:linear-gradient(rgba(255,255,255,.8)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,.8)_1px,transparent_1px)] [background-size:72px_72px]" />
      <div className="pointer-events-none absolute -left-40 top-1/4 h-[30rem] w-[30rem] rounded-full bg-violet-500/[0.09] blur-[110px]" />
      <div className="relative mx-auto w-full max-w-7xl px-5 sm:px-8">
        <motion.div {...reveal} className="mx-auto mb-14 max-w-3xl text-center">
          <p className="mb-5 font-mono text-[11px] tracking-[0.16em] text-violet-300/70">[02 // TOOLS & PERMISSIONS]</p>
          <h2 className="text-balance text-4xl font-medium leading-[1.04] tracking-[-0.055em] text-zinc-100 sm:text-5xl lg:text-6xl">A small toolset. <span className="text-zinc-500">Boundaries you can set.</span></h2>
          <p className="mx-auto mt-5 max-w-xl text-pretty text-sm leading-7 text-zinc-400 sm:text-base">Six focused tools cover the coding loop. Read operations stay available; mutating operations can pause for approval or be disabled.</p>
        </motion.div>
        <motion.div {...reveal} transition={{ ...reveal.transition, delay: 0.1 }} className="relative">
          <div className="absolute -inset-x-8 -inset-y-8 rounded-[2.5rem] bg-gradient-to-r from-violet-500/[0.07] via-fuchsia-400/[0.04] to-cyan-400/[0.07] blur-3xl" />
          <div className="relative overflow-hidden rounded-2xl border border-white/10 bg-zinc-900/60 p-4 shadow-[0_35px_100px_-55px_rgba(167,139,250,.35)] backdrop-blur-xl sm:p-7">
            <div className="mb-6 flex flex-wrap items-center justify-between gap-4 border-b border-white/[0.07] pb-5"><div className="flex items-center gap-3"><span className="grid size-9 place-items-center rounded-xl border border-violet-300/15 bg-violet-300/[0.08] text-violet-200"><CircleDashed className="size-4" /></span><div><p className="text-xs font-medium text-zinc-200">Default coding tools</p><p className="mt-1 font-mono text-[9px] text-zinc-600">read · list · grep · edit · write · bash</p></div></div><span className="flex items-center gap-2 rounded-full border border-white/[0.08] bg-white/[0.03] px-3 py-1.5 font-mono text-[9px] text-zinc-400"><Lock className="size-3 text-violet-200" /> YOU SET THE POLICY</span></div>
            <div className="grid gap-3 md:grid-cols-3">
              {toolGroups.map(({ title, tools, detail, icon: Icon, tone }, index) => <motion.article key={title} initial={{ opacity: 0, y: 14 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true }} transition={{ duration: 0.5, delay: 0.16 + index * 0.1 }} className="rounded-xl border border-white/[0.08] bg-zinc-950/60 p-5 transition duration-300 hover:-translate-y-1 hover:border-white/15 hover:bg-zinc-900/80 sm:p-6">
                <div className="flex items-start justify-between"><span className={`grid size-10 place-items-center rounded-xl border ${tone === "violet" ? "border-violet-300/15 bg-violet-300/[0.08] text-violet-200" : tone === "cyan" ? "border-cyan-300/15 bg-cyan-300/[0.08] text-cyan-200" : "border-amber-300/15 bg-amber-300/[0.08] text-amber-200"}`}><Icon className="size-4" /></span><span className="font-mono text-[9px] text-zinc-600">0{index + 1} / 03</span></div>
                <h3 className="mt-6 text-lg font-medium tracking-tight text-zinc-100">{title}</h3><p className="mt-2 font-mono text-[10px] text-zinc-400">{tools}</p><p className="mt-4 min-h-12 text-xs leading-5 text-zinc-500">{detail}</p>
                <div className="mt-5 flex items-center gap-2 border-t border-white/[0.07] pt-4 font-mono text-[9px] text-zinc-500"><Check className="size-3 text-emerald-300" /> bounded output</div>
              </motion.article>)}
            </div>
            <div className="mt-5 flex flex-col gap-4 border-t border-white/[0.07] pt-4 sm:flex-row sm:items-center sm:justify-between"><div className="flex flex-wrap gap-x-5 gap-y-2 font-mono text-[9px] text-zinc-500"><span><span className="text-emerald-300">read/list/grep</span> ungated</span><span><span className="text-violet-200">edit/write/bash</span> callback-gated · CLI defaults to ask</span></div><div className="flex flex-wrap gap-2 font-mono text-[9px]"><span className="rounded-md bg-white/[0.04] px-2 py-1 text-zinc-400">ask</span><span className="rounded-md bg-white/[0.04] px-2 py-1 text-zinc-400">readonly</span><span className="rounded-md bg-white/[0.04] px-2 py-1 text-zinc-400">yolo</span></div></div>
          </div>
        </motion.div>
        <motion.div {...reveal} transition={{ ...reveal.transition, delay: 0.2 }} className="mt-7 flex flex-wrap items-center justify-center gap-2 font-mono text-[9px] uppercase tracking-widest text-zinc-600"><Link href="/docs/tools" className="inline-flex items-center gap-1.5 transition hover:text-violet-200">Tool reference <ArrowRight className="size-3" /></Link><span className="px-2 text-zinc-800">·</span><Link href="/docs/installation" className="transition hover:text-violet-200">CLI permission defaults</Link></motion.div>
      </div>
    </section>
  );
}
