import Link from "next/link";
import { ArrowLeft, ArrowUpRight, BookOpen, Code2 } from "lucide-react";
import type { ReactNode } from "react";

const groups = [
  { label: "GET STARTED", links: [{ title: "Introduction", href: "/docs" }, { title: "Installation", href: "/docs/installation" }] },
  { label: "RUNTIME", links: [{ title: "SDK quickstart", href: "/docs/sdk" }, { title: "The agent loop", href: "/docs/agent-loop" }, { title: "Built-in tools", href: "/docs/tools" }, { title: "Delegation", href: "/docs/delegation" }, { title: "Workflows", href: "/docs/workflows" }, { title: "Streaming events", href: "/docs/events" }] },
  { label: "CLI", links: [{ title: "Command line", href: "/docs/cli" }] },
  { label: "MEMORY", links: [{ title: "Cognitive memory", href: "/docs/memory" }] },
];

export function DocsShell({ current, children }: { current: string; children: ReactNode }) {
  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100">
      <div className="pointer-events-none fixed inset-0 -z-0 opacity-[0.025] [background-image:linear-gradient(rgba(255,255,255,.8)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,.8)_1px,transparent_1px)] [background-size:72px_72px]" />
      <div className="pointer-events-none fixed -right-40 -top-48 -z-0 size-[42rem] rounded-full bg-violet-500/[0.09] blur-[130px]" />
      <header className="sticky top-0 z-40 border-b border-white/[0.08] bg-zinc-950/80 backdrop-blur-xl">
        <div className="mx-auto flex h-16 max-w-[1440px] items-center justify-between px-5 sm:px-8">
          <div className="flex items-center gap-3"><Link href="/" className="flex items-center gap-2 text-sm font-semibold tracking-tight"><span className="grid size-7 place-items-center rounded-lg border border-white/10 bg-white/[0.06] font-mono text-xs">n.</span>nah</Link><span className="h-4 w-px bg-white/10" /><Link href="/docs" className="text-xs text-zinc-300">Documentation</Link><span className="rounded-full border border-violet-300/15 bg-violet-300/[0.06] px-2 py-0.5 font-mono text-[9px] text-violet-200">v1</span></div>
          <nav className="flex items-center gap-4 text-xs text-zinc-400"><Link href="/" className="hidden transition hover:text-white sm:inline-flex sm:items-center sm:gap-1.5"><ArrowLeft className="size-3" /> Home</Link><Link href="https://github.com/astracollab/nah" target="_blank" rel="noreferrer" aria-label="NAH source on GitHub" className="transition hover:text-white"><Code2 className="size-4" /></Link><Link href="/docs/installation" className="inline-flex items-center gap-1.5 rounded-full bg-zinc-100 px-3 py-2 font-medium text-zinc-950 transition hover:bg-white">Get started <ArrowUpRight className="size-3" /></Link></nav>
        </div>
      </header>
      <div className="relative mx-auto grid max-w-[1440px] grid-cols-1 gap-10 px-5 sm:px-8 lg:grid-cols-[220px_minmax(0,760px)_1fr] lg:gap-14">
        <aside className="border-b border-white/[0.08] py-5 lg:sticky lg:top-16 lg:h-[calc(100vh-4rem)] lg:overflow-y-auto lg:border-b-0 lg:py-10">
          <Link href="/docs" className="mb-5 flex items-center gap-2 text-[11px] font-medium text-zinc-400"><BookOpen className="size-3.5 text-violet-300" /> NAH DOCUMENTATION</Link>
          <nav aria-label="Documentation" className="flex gap-7 overflow-x-auto lg:flex-col lg:gap-7">
            {groups.map((group) => <div key={group.label} className="shrink-0"><p className="mb-2.5 font-mono text-[9px] tracking-[0.16em] text-zinc-600">{group.label}</p><ul className="space-y-1">{group.links.map((link) => <li key={link.href}><Link href={link.href} aria-current={current === link.href ? "page" : undefined} className={`block rounded-lg px-2.5 py-2 text-xs transition ${current === link.href ? "bg-white/[0.07] text-white" : "text-zinc-500 hover:bg-white/[0.04] hover:text-zinc-200"}`}>{link.title}</Link></li>)}</ul></div>)}
          </nav>
        </aside>
        <main className="min-w-0 py-9 sm:py-12 lg:py-16">{children}</main>
        <aside className="hidden py-16 xl:block"><div className="sticky top-28 rounded-xl border border-white/[0.08] bg-white/[0.025] p-4"><p className="font-mono text-[9px] tracking-[0.16em] text-zinc-600">BUILT FOR CONTROL</p><p className="mt-3 text-xs leading-5 text-zinc-400">A transparent loop, bounded tools, and no hidden orchestration layer.</p><Link href="/docs/agent-loop" className="mt-4 inline-flex items-center gap-1 text-[10px] text-violet-200">How it works <ArrowUpRight className="size-3" /></Link></div></aside>
      </div>
      <footer className="relative border-t border-white/[0.08]"><div className="mx-auto flex max-w-[1440px] flex-col gap-3 px-5 py-5 font-mono text-[9px] text-zinc-600 sm:flex-row sm:items-center sm:justify-between sm:px-8"><span>NAH · NOT ANOTHER HARNESS</span><span>Small runtime. Explicit behavior.</span><Link href="/" className="transition hover:text-zinc-300">Back to nah.astracollab.com</Link></div></footer>
    </div>
  );
}

export function DocHeader({ eyebrow, title, description }: { eyebrow: string; title: string; description: string }) {
  return <header className="mb-10 border-b border-white/[0.08] pb-8 sm:mb-12 sm:pb-10"><p className="mb-4 font-mono text-[10px] tracking-[0.17em] text-violet-300/80">{eyebrow}</p><h1 className="text-balance text-4xl font-medium leading-[1.05] tracking-[-0.055em] text-zinc-100 sm:text-5xl">{title}</h1><p className="mt-5 max-w-2xl text-pretty text-sm leading-7 text-zinc-400 sm:text-base">{description}</p></header>;
}

export function DocSection({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return <section id={id} className="scroll-mt-28 py-6 first:pt-0"><h2 className="mb-3 text-xl font-medium tracking-tight text-zinc-100">{title}</h2><div className="space-y-4 text-sm leading-7 text-zinc-400">{children}</div></section>;
}

export function Code({ children, language = "bash" }: { children: string; language?: string }) {
  return <div className="my-5 overflow-hidden rounded-xl border border-white/[0.09] bg-[#0b0c0f]"><div className="flex items-center justify-between border-b border-white/[0.07] px-4 py-2.5"><span className="flex items-center gap-2"><span className="size-1.5 rounded-full bg-violet-300/80" /><span className="font-mono text-[9px] uppercase tracking-widest text-zinc-600">{language}</span></span><span className="font-mono text-[9px] text-zinc-700">nah</span></div><pre className="overflow-x-auto p-4 font-mono text-[11px] leading-6 text-zinc-300 sm:p-5 sm:text-xs"><code>{children}</code></pre></div>;
}

export function Note({ title, children }: { title: string; children: ReactNode }) {
  return <aside className="my-5 rounded-xl border border-violet-300/15 bg-violet-300/[0.045] p-4"><p className="mb-1 font-mono text-[9px] uppercase tracking-[0.14em] text-violet-200/80">{title}</p><div className="text-xs leading-6 text-zinc-400">{children}</div></aside>;
}
