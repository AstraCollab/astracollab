import Link from "next/link";
import { ArrowRight, Blocks, Braces, Brain, Radio, Terminal } from "lucide-react";
import { Code, DocHeader, DocSection, DocsShell } from "@/components/docs/DocsShell";

const cards = [
  { title: "Install NAH", detail: "Get the CLI running and configure a model provider.", href: "/docs/installation", icon: Terminal, label: "QUICKSTART" },
  { title: "Understand the loop", detail: "Model steps, budgets, steering, and how a stuck turn is stopped.", href: "/docs/agent-loop", icon: Radio, label: "RUNTIME" },
  { title: "Use the tool set", detail: "Read, list, glob, grep, edit, write, recall, and shell.", href: "/docs/tools", icon: Blocks, label: "TOOLS" },
  { title: "Build with the SDK", detail: "Run the harness from TypeScript and consume its event stream.", href: "/docs/sdk", icon: Braces, label: "SDK" },
  { title: "Add cognitive memory", detail: "What it learns, what it pre-stages, and what recall returns.", href: "/docs/memory", icon: Brain, label: "MEMORY" },
];

export default function DocsHome() {
  return <DocsShell current="/docs"><DocHeader eyebrow="DOCUMENTATION / OVERVIEW" title="A small runtime. No hidden harness." description="NAH is a coding-agent runtime and CLI built around an explicit loop, a compact set of capped tools, and typed events you can observe or persist." />
    <DocSection id="start" title="Start with the CLI"><p>Install the command line package, choose a model provider, and run it from the repository you want the agent to work in.</p><Code>{"npm install -g nah-ai\nexport ANTHROPIC_API_KEY=your-key\ncd your-project\nnah \"explain this codebase\""}</Code><p>Interactive sessions ask before mutating files by default. Print and JSON modes allow mutations by default; use <code className="rounded bg-white/[0.06] px-1.5 py-0.5 font-mono text-[11px] text-zinc-300">--permissions readonly</code> when a non-interactive run must not write.</p><Link href="/docs/installation" className="inline-flex items-center gap-2 text-xs text-violet-200 hover:text-white">Full installation guide <ArrowRight className="size-3.5" /></Link></DocSection>
    <section className="grid gap-3 py-8 sm:grid-cols-2">{cards.map(({ title, detail, href, icon: Icon, label }) => <Link key={title} href={href} className="group rounded-xl border border-white/[0.08] bg-white/[0.025] p-4 transition hover:-translate-y-0.5 hover:border-white/[0.16] hover:bg-white/[0.04]"><div className="flex items-center justify-between"><Icon className="size-4 text-violet-200" /><span className="font-mono text-[9px] tracking-widest text-zinc-600">{label}</span></div><h2 className="mt-5 text-sm font-medium text-zinc-200">{title}</h2><p className="mt-1.5 text-xs leading-5 text-zinc-500">{detail}</p><span className="mt-4 inline-flex items-center gap-1 font-mono text-[9px] text-zinc-500 group-hover:text-violet-200">Read guide <ArrowRight className="size-3 transition group-hover:translate-x-0.5" /></span></Link>)}</section>
    <DocSection id="principles" title="What NAH does—and doesn’t do"><p>The harness owns the iteration loop, tool execution, event stream, token and step budgets, and optional transcript compaction. The model itself is supplied as an AI SDK v5 language model. The built-in CLI adds terminal interaction, model selection, permissions, and JSONL session persistence.</p><p>The core package is intentionally small. It does not provide a web dashboard, hosted agent service, or a broad plugin marketplace; bring your own model provider and use the SDK or CLI surfaces that fit your workflow.</p></DocSection>
  </DocsShell>;
}
