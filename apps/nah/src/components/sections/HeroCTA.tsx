"use client";

import Link from "next/link";
import { ArrowRight, Check, Code2, Copy, MoveUpRight, Terminal } from "lucide-react";
import { motion } from "framer-motion";
import { useState } from "react";

const reveal = { initial: { opacity: 0, y: 30 }, whileInView: { opacity: 1, y: 0 }, viewport: { once: true }, transition: { duration: 0.7, ease: [0.22, 1, 0.36, 1] as const } };
const installCommand = "npm install -g @astracollab/nah";

export function HeroCTA() {
  const [copied, setCopied] = useState(false);
  async function copyInstall() {
    try {
      await navigator.clipboard.writeText(installCommand);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      setCopied(false);
    }
  }

  return (
    <section id="deploy" className="relative flex min-h-screen scroll-mt-16 flex-col overflow-hidden py-24 sm:py-28">
      <div className="pointer-events-none absolute inset-0 opacity-[0.03] [background-image:linear-gradient(rgba(255,255,255,.8)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,.8)_1px,transparent_1px)] [background-size:72px_72px]" />
      <div className="pointer-events-none absolute left-1/2 top-1/4 h-[36rem] w-[50rem] -translate-x-1/2 rounded-full bg-gradient-to-r from-indigo-500/[0.12] via-violet-400/[0.13] to-fuchsia-400/[0.08] blur-[120px]" />
      <div className="relative mx-auto flex w-full max-w-7xl flex-1 flex-col items-center justify-center px-5 text-center sm:px-8">
        <motion.div {...reveal} className="mb-6 inline-flex max-w-full items-center gap-2 whitespace-nowrap rounded-full border border-white/10 bg-white/[0.04] px-3 py-1.5 font-mono text-[10px] tracking-[0.14em] text-violet-200/80"><Code2 className="size-3.5 shrink-0" /><span className="truncate">[04 // RUN IT YOUR WAY]</span></motion.div>
        <motion.h2 {...reveal} transition={{ ...reveal.transition, delay: 0.08 }} className="max-w-5xl text-balance text-5xl font-medium leading-[0.96] tracking-[-0.065em] text-transparent sm:text-7xl lg:text-[6.5rem]"><span className="bg-gradient-to-b from-white via-zinc-200 to-zinc-500 bg-clip-text">Keep the loop small.</span><br /><span className="bg-gradient-to-r from-zinc-100 via-violet-100 to-zinc-400 bg-clip-text">Keep control yours.</span></motion.h2>
        <motion.p {...reveal} transition={{ ...reveal.transition, delay: 0.16 }} className="mt-6 max-w-lg text-pretty text-sm leading-7 text-zinc-400 sm:text-base">Install the CLI for a ready-to-use terminal workflow, or compose the TypeScript runtime into your own application.</motion.p>
        <motion.div {...reveal} transition={{ ...reveal.transition, delay: 0.24 }} className="mt-9 flex w-full max-w-xl flex-col justify-center gap-3 sm:flex-row">
          <button type="button" onClick={copyInstall} className="inline-flex min-w-0 flex-1 items-center justify-between gap-4 rounded-xl border border-white/10 bg-zinc-900/75 px-4 py-3.5 font-mono text-xs text-zinc-300 shadow-[0_24px_80px_-40px_rgba(167,139,250,.45)] backdrop-blur-xl transition hover:border-white/20" aria-label="Copy npm install command"><span className="truncate"><span className="text-zinc-600">$ </span>{installCommand}</span>{copied ? <Check className="size-4 shrink-0 text-emerald-400" /> : <Copy className="size-4 shrink-0 text-zinc-500" />}</button>
          <Link href="/docs/installation" className="inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-xl bg-zinc-100 px-5 py-3.5 text-sm font-medium text-zinc-950 transition hover:bg-white">Quickstart <ArrowRight className="size-4 shrink-0" /></Link>
        </motion.div>
        <motion.div {...reveal} transition={{ ...reveal.transition, delay: 0.32 }} className="mt-7 flex flex-wrap items-center justify-center gap-x-5 gap-y-3 font-mono text-[10px] text-zinc-500"><span className="inline-flex items-center gap-1.5"><Terminal className="size-3.5" /> Node.js 20.6+</span><span className="hidden size-1 rounded-full bg-zinc-700 sm:block" /><Link className="inline-flex items-center whitespace-nowrap transition hover:text-zinc-200" href="/docs/sdk">SDK quickstart <MoveUpRight className="ml-1 inline size-3 shrink-0" /></Link><span className="hidden size-1 rounded-full bg-zinc-700 sm:block" /><Link className="inline-flex items-center gap-1.5 transition hover:text-zinc-200" href="https://github.com/astracollab/nah" target="_blank" rel="noreferrer"><Code2 className="size-3.5" /> Source on GitHub</Link></motion.div>
      </div>
      <footer className="relative mx-auto mt-12 flex w-full max-w-7xl flex-col items-center justify-between gap-4 border-t border-white/10 px-5 pt-6 text-[10px] text-zinc-600 sm:flex-row sm:px-8">
        <Link href="#top" className="font-mono text-zinc-400">nah<span className="text-violet-300">.</span></Link>
        <nav aria-label="Footer links" className="flex flex-wrap justify-center gap-5 font-mono"><Link href="/docs" className="transition hover:text-zinc-300">Docs</Link><Link href="https://github.com/astracollab/nah" target="_blank" rel="noreferrer" className="transition hover:text-zinc-300">GitHub</Link><Link href="https://github.com/astracollab/nah/releases" target="_blank" rel="noreferrer" className="transition hover:text-zinc-300">Releases</Link><Link href="https://github.com/astracollab/nah/blob/main/LICENSE" target="_blank" rel="noreferrer" className="transition hover:text-zinc-300">MIT License</Link></nav>
        <span className="font-mono">© {new Date().getFullYear()} AstraCollab</span>
      </footer>
    </section>
  );
}
