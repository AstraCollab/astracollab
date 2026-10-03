"use client";

import { ArrowDown, Check, Copy, CornerDownLeft, GitCommitHorizontal, Terminal } from "lucide-react";
import { motion } from "framer-motion";
import { useState } from "react";

const reveal = { initial: { opacity: 0, y: 30 }, whileInView: { opacity: 1, y: 0 }, viewport: { once: true }, transition: { duration: 0.7, ease: [0.22, 1, 0.36, 1] as const } };

export function HeroTerminal() {
  const [copied, setCopied] = useState(false);
  async function copyConfig() {
    try {
      await navigator.clipboard.writeText('import { runAgent, buildSystemPrompt, createCodingTools } from "not-another-harness";\nimport { createNodeEnvironment } from "not-another-harness/node";\n\nconst run = runAgent({\n  model,\n  prompt: "fix the session refresh edge case",\n  system: buildSystemPrompt({ cwdLabel: process.cwd() }),\n  tools: createCodingTools(createNodeEnvironment(process.cwd())),\n  maxSteps: 32,\n});\n\nfor await (const event of run.events) {\n  console.log(event.type, event);\n}');
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch { setCopied(false); }
  }

  return (
    <section id="control" className="relative flex min-h-screen scroll-mt-16 items-center overflow-hidden border-b border-white/10 py-24 sm:py-28">
      <div className="pointer-events-none absolute inset-0 opacity-[0.03] [background-image:linear-gradient(rgba(255,255,255,.8)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,.8)_1px,transparent_1px)] [background-size:72px_72px]" />
      <div className="pointer-events-none absolute right-0 top-1/3 h-[32rem] w-[38rem] rounded-full bg-blue-500/[0.08] blur-[120px]" />
      <div className="relative mx-auto grid w-full max-w-7xl items-center gap-12 px-5 sm:px-8 lg:grid-cols-[0.72fr_1.28fr] lg:gap-16">
        <motion.div {...reveal}>
          <p className="mb-5 font-mono text-[11px] tracking-[0.16em] text-blue-300/70">[03 // CONTROL]</p>
          <h2 className="max-w-xl text-balance text-4xl font-medium leading-[1.04] tracking-[-0.055em] text-zinc-100 sm:text-5xl lg:text-6xl">Native to your terminal. <span className="text-zinc-500">A runtime you can compose.</span></h2>
          <p className="mt-6 max-w-lg text-pretty text-sm leading-7 text-zinc-400 sm:text-base">The CLI and TypeScript SDK are the product. Run in your project, choose a supported model provider, and consume the same explicit event stream.</p>
          <div className="mt-8 flex items-center gap-2 font-mono text-[10px] text-zinc-500"><Terminal className="size-3.5 text-blue-300" /> local workspace · optional Blaxel sandbox</div>
        </motion.div>
        <motion.div {...reveal} transition={{ ...reveal.transition, delay: 0.1 }} className="relative">
          <div className="absolute -inset-5 rounded-[2rem] bg-blue-400/[0.04] blur-2xl" />
          <div className="relative overflow-hidden rounded-2xl border border-white/10 bg-[#0b0c0e]/95 shadow-[0_35px_100px_-50px_rgba(96,165,250,.32)] backdrop-blur-xl">
            <div className="flex items-center justify-between border-b border-white/[0.07] px-4 py-3 sm:px-5"><div className="flex items-center gap-2"><div className="flex gap-1.5"><i className="size-2 rounded-full bg-red-400/60" /><i className="size-2 rounded-full bg-amber-300/60" /><i className="size-2 rounded-full bg-emerald-400/60" /></div><span className="ml-3 font-mono text-[10px] text-zinc-500">~/projects/atlas <span className="text-zinc-700">— nah</span></span></div><button type="button" onClick={copyConfig} aria-label="Copy NAH SDK example" className="inline-flex items-center gap-1.5 font-mono text-[9px] text-zinc-500 transition hover:text-zinc-200">{copied ? <Check className="size-3 text-emerald-400" /> : <Copy className="size-3" />}{copied ? "copied" : "copy example"}</button></div>
            <div className="grid md:grid-cols-[1fr_190px]">
              <div className="min-w-0 p-4 sm:p-6">
                <div className="mb-5 flex items-center gap-2 font-mono text-[10px] text-zinc-500"><GitCommitHorizontal className="size-3.5 text-blue-300" /> src/agent.ts</div>
                <pre className="overflow-x-auto font-mono text-[11px] leading-7 sm:text-xs"><code><span className="text-violet-300">import</span> {'{'} <span className="text-blue-200">runAgent</span>, <span className="text-blue-200">buildSystemPrompt</span>,<br />{'  '}<span className="text-blue-200">createCodingTools</span> {'}'} <span className="text-violet-300">from</span> <span className="text-emerald-300">&quot;not-another-harness&quot;</span>;<br /><span className="text-violet-300">import</span> {'{'} <span className="text-blue-200">createNodeEnvironment</span> {'}'} <span className="text-violet-300">from</span><br />{'  '}<span className="text-emerald-300">&quot;not-another-harness/node&quot;</span>;<br /><br /><span className="text-violet-300">const</span> run = <span className="text-blue-200">runAgent</span>({'{'}<br />{'  '}<span className="text-sky-200">model</span>, <span className="text-zinc-600">{"// AI SDK v5 LanguageModel"}</span><br />{'  '}<span className="text-sky-200">prompt</span>: <span className="text-emerald-300">&quot;fix the session refresh edge case&quot;</span>,<br />{'  '}<span className="text-sky-200">system</span>: <span className="text-blue-200">buildSystemPrompt</span>({'{'} <span className="text-sky-200">cwdLabel</span>: process.<span className="text-blue-200">cwd</span>() {'}'}),<br />{'  '}<span className="text-sky-200">tools</span>: <span className="text-blue-200">createCodingTools</span>(<br />{'    '}<span className="text-blue-200">createNodeEnvironment</span>(process.<span className="text-blue-200">cwd</span>()),<br />{'  '}),<br />{'  '}<span className="text-sky-200">maxSteps</span>: <span className="text-orange-200">32</span>,<br />{'}'});<br /><br /><span className="text-violet-300">for await</span> (<span className="text-violet-300">const</span> event <span className="text-violet-300">of</span> run.events) {'{'}<br />{'  '}console.<span className="text-blue-200">log</span>(event.type, event);<br />{'}'}</code></pre>
                <div className="mt-7 rounded-lg border border-white/[0.07] bg-white/[0.025] p-3 font-mono text-[10px] leading-6"><p className="text-zinc-600">$ nah --permissions ask &quot;fix the session refresh edge case&quot;</p><p className="text-zinc-300"><span className="text-blue-300">›</span> tool: read src/auth/session.ts</p><p className="text-zinc-400"><span className="text-blue-300">›</span> streamed response · step 1</p><p className="text-amber-200"><span className="text-amber-300">!</span> edit src/auth/session.ts — allow? [y/N/a]</p><p className="mt-1 text-zinc-500">Changes wait for your approval.</p></div>
              </div>
              <aside className="border-t border-white/[0.07] bg-white/[0.015] p-4 md:border-l md:border-t-0 sm:p-5"><p className="font-mono text-[9px] uppercase tracking-[0.16em] text-zinc-600">CLI modes</p><div className="mt-5 space-y-4">{[["nah", "interactive REPL"], ["nah -p", "print and exit"], ["--mode json", "JSONL events"]].map(([command, label]) => <div key={command} className="flex flex-col gap-1"><code className="font-mono text-[10px] text-zinc-300">{command}</code><span className="text-[10px] text-zinc-500">{label}</span></div>)}</div><div className="mt-7 border-t border-white/[0.07] pt-4"><p className="font-mono text-[9px] uppercase tracking-[0.16em] text-zinc-600">Interactive defaults</p><p className="mt-3 flex items-center gap-2 font-mono text-[10px] text-zinc-400"><span className="size-1.5 rounded-full bg-emerald-400" /> permissions: ask</p><p className="mt-2 flex items-center gap-2 font-mono text-[10px] text-zinc-400"><span className="size-1.5 rounded-full bg-blue-300" /> sessions: JSONL</p></div><p className="mt-7 flex items-center gap-1.5 font-mono text-[9px] text-zinc-600"><CornerDownLeft className="size-3" /> /help for commands</p></aside>
            </div>
            <div className="flex items-center justify-between border-t border-white/[0.07] px-4 py-2.5 font-mono text-[9px] text-zinc-600 sm:px-5"><span>NAH · Node.js 20.6+ · AI SDK v5</span><span className="flex items-center gap-1">CLI + TypeScript SDK <ArrowDown className="size-3" /></span></div>
          </div>
        </motion.div>
      </div>
    </section>
  );
}
