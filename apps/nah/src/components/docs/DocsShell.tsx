import Link from "next/link";
import { ArrowUpRight, BookOpen } from "lucide-react";
import type { ReactNode } from "react";
import { SiteFooter, SiteNav } from "@/components/SiteNav";

const groups = [
  { label: "GET STARTED", links: [{ title: "Introduction", href: "/docs" }, { title: "Installation", href: "/docs/installation" }] },
  { label: "RUNTIME", links: [{ title: "SDK quickstart", href: "/docs/sdk" }, { title: "The agent loop", href: "/docs/agent-loop" }, { title: "Built-in tools", href: "/docs/tools" }, { title: "Delegation", href: "/docs/delegation" }, { title: "Workflows", href: "/docs/workflows" }, { title: "Streaming events", href: "/docs/events" }] },
  { label: "CLI", links: [{ title: "Command line", href: "/docs/cli" }] },
  { label: "MEMORY", links: [{ title: "Cognitive memory", href: "/docs/memory" }] },
];

export function DocsShell({ current, children }: { current: string; children: ReactNode }) {
  return (
    <div className="docs-shell"><div className="docs-backdrop"/><SiteNav/><div className="docs-layout">
      <aside className="docs-sidebar"><Link href="/docs" className="docs-sidebar-title"><BookOpen/> NAH DOCUMENTATION <span>v1</span></Link><nav aria-label="Documentation" className="docs-nav">
        {groups.map((group) => <div key={group.label} className="docs-nav-group"><p>{group.label}</p><ul>{group.links.map((link) => <li key={link.href}><Link href={link.href} aria-current={current === link.href ? "page" : undefined}>{link.title}</Link></li>)}</ul></div>)}
      </nav></aside>
      <main className="docs-content">{children}</main>
      <aside className="docs-aside"><div><p>BUILT FOR CONTROL</p><p>A transparent loop, bounded tools, and no hidden orchestration layer.</p><Link href="/how-it-works">How it works <ArrowUpRight/></Link></div></aside>
    </div><SiteFooter/></div>
  );
}

export function DocHeader({ eyebrow, title, description }: { eyebrow: string; title: string; description: string }) {
  return <header className="doc-header"><p>{eyebrow}</p><h1>{title}</h1><p>{description}</p></header>;
}

export function DocSection({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return <section id={id} className="doc-section"><h2>{title}</h2><div>{children}</div></section>;
}

export function Code({ children, language = "bash" }: { children: string; language?: string }) {
  return <div className="doc-code"><div><span><i/> {language}</span><span>nah</span></div><pre><code>{children}</code></pre></div>;
}

export function Note({ title, children }: { title: string; children: ReactNode }) {
  return <aside className="doc-note"><p>{title}</p><div>{children}</div></aside>;
}
