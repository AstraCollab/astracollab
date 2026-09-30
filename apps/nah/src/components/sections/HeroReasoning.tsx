"use client";

import Link from "next/link";
import { ArrowRight, Check, Circle, Cpu, FileCode2, GitBranch, Terminal } from "lucide-react";
import { motion } from "framer-motion";

const reveal = { initial: { opacity: 0, y: 30 }, whileInView: { opacity: 1, y: 0 }, viewport: { once: true }, transition: { duration: 0.7, ease: [0.22, 1, 0.36, 1] as const } };
const events = [
  { name: "run-start", detail: "stepBudget · tokenBudget", color: "text-violet-200" },
  { name: "step-start", detail: "step: 1", color: "text-zinc-300" },
  { name: "tool-call", detail: "toolName · input · call ID", color: "text-cyan-200" },
  { name: "tool-result", detail: "capped output · isError", color: "text-cyan-200" },
  { name: "step-finish", detail: "cumulative usage", color: "text-zinc-300" },
];

export function HeroReasoning() {
  return (
    <section id="reasoning" className="relative flex min-h-screen scroll-mt-16 items-center overflow-hidden border-b border-white/10 py-24 sm:py-28">
      <div className="pointer-events-none absolute inset-0 opacity-[0.03] [background-image:linear-gradient(rgba(255,255,255,.8)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,.8)_1px,transparent_1px)] [background-size:72px_72px]" />
      <div className="pointer-events-none absolute left-[55%] top-1/2 h-[34rem] w-[36rem] -translate-y-1/2 rounded-full bg-cyan-500/[0.09] blur-[120px]" />
      <div className="relative mx-auto grid w-full max-w-7xl items-center gap-14 px-5 sm:px-8 lg:grid-cols-[0.82fr_1.18fr] lg:gap-16">
        <motion.div {...reveal}>
          <p className="mb-5 font-mono text-[11px] tracking-[0.16em] text-cyan-300/70">[01 // THE LOOP]</p>
          <h2 className="max-w-xl text-balance text-4xl font-medium leading-[1.04] tracking-[-0.055em] text-zinc-100 sm:text-5xl lg:text-6xl">A model call. <span className="text-zinc-500">A tool call. A clear next step.</span></h2>
          <p className="mt-6 max-w-lg text-pretty text-sm leading-7 text-zinc-400 sm:text-base">NAH owns the loop around the model: one streamed response per step, real tool execution, then an explicit check against the run limits.</p>
          <div className="mt-8 flex flex-wrap gap-2 font-mono text-[10px] text-zinc-500">
            <span className="rounded-full border border-white/10 px-3 py-1.5">max 32 steps by default</span><span className="rounded-full border border-white/10 px-3 py-1.5">typed async events</span><span className="rounded-full border border-white/10 px-3 py-1.5">abortable</span>
          </div>
          <Link href="/docs/agent-loop" className="mt-8 inline-flex items-center gap-2 text-xs text-cyan-200 transition hover:text-white">How the loop works <ArrowRight className="size-3.5" /></Link>
        </motion.div>
        <motion.div {...reveal} transition={{ ...reveal.transition, delay: 0.1 }} className="relative">
          <div className="absolute -inset-5 rounded-[2rem] bg-cyan-400/[0.04] blur-2xl" />
          <div className="relative overflow-hidden rounded-2xl border border-white/10 bg-[#0c0d10]/90 shadow-[0_32px_100px_-44px_rgba(34,211,238,.35)] backdrop-blur-xl">
            <div className="flex items-center justify-between border-b border-white/[0.07] px-4 py-3 sm:px-5"><div className="flex items-center gap-2"><div className="flex gap-1.5"><i className="size-2 rounded-full bg-white/15" /><i className="size-2 rounded-full bg-white/15" /><i className="size-2 rounded-full bg-white/15" /></div><span className="ml-2 font-mono text-[10px] text-zinc-500">example event stream</span></div><span className="rounded-full border border-white/[0.08] px-2.5 py-1 font-mono text-[9px] text-zinc-500">illustrative</span></div>
            <div className="grid min-h-[345px] md:grid-cols-[155px_1fr]">
              <aside className="hidden border-r border-white/[0.07] p-4 md:block"><p className="mb-3 font-mono text-[9px] uppercase tracking-widest text-zinc-600">Run limits</p><div className="space-y-2 font-mono text-[10px] text-zinc-400"><p className="flex items-center gap-2"><Circle className="size-2 fill-cyan-300 text-cyan-300" /> maxSteps <span className="ml-auto text-zinc-300">32</span></p><p className="flex items-center gap-2"><Circle className="size-2 fill-cyan-300 text-cyan-300" /> maxTokens <span className="ml-auto text-zinc-300">400k</span></p><p className="flex items-center gap-2"><Circle className="size-2 fill-zinc-600 text-zinc-600" /> compaction <span className="ml-auto text-zinc-300">model</span></p></div><div className="mt-7 border-t border-white/[0.07] pt-4"><p className="font-mono text-[9px] uppercase tracking-widest text-zinc-600">One step</p><p className="mt-2 text-[10px] leading-5 text-zinc-500">One model round-trip plus its tool calls.</p></div></aside>
              <div className="p-4 sm:p-6"><div className="mb-5 flex items-start gap-3"><span className="grid size-7 shrink-0 place-items-center rounded-lg border border-cyan-300/15 bg-cyan-300/[0.07] text-cyan-200"><Cpu className="size-3.5" /></span><div><p className="font-mono text-[10px] text-zinc-500">HarnessRun <span className="ml-2 text-zinc-700">HarnessEvent stream</span></p><p className="mt-1.5 max-w-xl text-xs leading-6 text-zinc-300 sm:text-sm">Consume events while the run is in progress. The final promise returns the text, stop reason, usage, and transcript.</p></div></div>
                <div className="ml-3 space-y-0 border-l border-white/10 pl-5">{events.map(({ name, detail, color }, index) => <div key={name} className="relative flex gap-3 pb-4 last:pb-1"><span className={`absolute -left-[25px] top-0.5 grid size-3.5 place-items-center rounded-full border ${index === 2 || index === 3 ? "border-cyan-300/30 bg-cyan-300/10" : "border-white/10 bg-zinc-900"}`}><span className={`size-1 rounded-full ${index === 2 || index === 3 ? "bg-cyan-200" : "bg-zinc-500"}`} /></span><span className="min-w-[88px] font-mono text-[10px] text-zinc-600">0{index + 1}</span><div className="flex flex-1 flex-wrap items-baseline justify-between gap-x-3 gap-y-1"><p className={`font-mono text-[10px] ${color}`}>{name}</p><p className="font-mono text-[9px] text-zinc-500">{detail}</p></div></div>)}</div>
                <div className="mt-5 flex flex-wrap gap-2 border-t border-white/[0.07] pt-4 font-mono text-[9px]"><span className="rounded-md bg-white/[0.04] px-2 py-1 text-zinc-400">finish.reason</span><span className="rounded-md bg-white/[0.04] px-2 py-1 text-zinc-400">finish.usage</span><span className="rounded-md bg-emerald-400/[0.08] px-2 py-1 text-emerald-300"><Check className="mr-1 inline size-3" />result.messages</span></div>
              </div>
            </div>
            <div className="flex items-center justify-between border-t border-white/[0.07] px-4 py-2.5 font-mono text-[9px] text-zinc-600 sm:px-5"><span className="flex items-center gap-1.5"><Terminal className="size-3" /> explicit loop · streamed events</span><span className="flex items-center gap-1"><FileCode2 className="size-3" /><GitBranch className="size-3" /> your runtime</span></div>
          </div>
        </motion.div>
      </div>
    </section>
  );
}
