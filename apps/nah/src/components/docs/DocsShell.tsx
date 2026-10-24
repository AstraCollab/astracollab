import Link from "next/link";
import { ArrowUpRight, BookOpen } from "lucide-react";
import { Children, isValidElement, type ReactNode } from "react";
import { SiteFooter, SiteNav } from "@/components/SiteNav";

const groups = [
  { label: "GET STARTED", links: [{ title: "Framework overview", href: "/docs" }, { title: "Installation", href: "/docs/installation" }] },
  { label: "BUILD AN AGENT", links: [{ title: "SDK build guide", href: "/docs/sdk" }, { title: "Configure tools", href: "/docs/tools" }, { title: "Run configuration", href: "/docs/agent-loop" }, { title: "Events and UI", href: "/docs/events" }] },
  { label: "WEB APPLICATIONS", links: [{ title: "nah-js and frameworks", href: "/docs/web" }, { title: "Server adapter", href: "/docs/server-adapter" }] },
  { label: "COMPOSE", links: [{ title: "Orchestrator", href: "/docs/orchestrator" }, { title: "Delegation", href: "/docs/delegation" }, { title: "Workflows", href: "/docs/workflows" }] },
  { label: "MEMORY", links: [{ title: "Conversation state", href: "/docs/memory" }, { title: "Cognitive memory", href: "/docs/cognitive-memory" }] },
  { label: "OPERATE", links: [{ title: "Host NAH Studio", href: "/docs/studio-hosting" }] },
  { label: "CLI", links: [{ title: "Command line", href: "/docs/cli" }] },
];

export function DocsShell({ current, children }: { current: string; children: ReactNode }) {
  const sections = Children.toArray(children).flatMap((child) => {
    if (!isValidElement<{ id?: string; title?: string; "aria-label"?: string }>(child)) return [];
    if (child.type === DocSection && child.props.id && child.props.title) {
      return [{ id: child.props.id, title: child.props.title }];
    }
    if (child.type === "section" && child.props.id && child.props["aria-label"]) {
      return [{ id: child.props.id, title: child.props["aria-label"] }];
    }
    return [];
  });

  return (
    <div className="docs-shell"><div className="docs-backdrop"/><SiteNav/><div className="docs-layout">
      <aside className="docs-sidebar"><Link href="/docs" className="docs-sidebar-title"><BookOpen/> NAH DOCUMENTATION <span>v1</span></Link><nav aria-label="Documentation" className="docs-nav">
        {groups.map((group) => <div key={group.label} className="docs-nav-group"><p>{group.label}</p><ul>{group.links.map((link) => <li key={link.href}><Link href={link.href} aria-current={current === link.href ? "page" : undefined}>{link.title}</Link></li>)}</ul></div>)}
      </nav></aside>
      <main className="docs-content">{children}</main>
      <aside className="docs-aside"><div className="docs-aside-sticky">
        <div className="docs-aside-callout"><p>BUILT FOR CONTROL</p><p>A transparent loop, bounded tools, and no hidden orchestration layer.</p><Link href="/how-it-works">How it works <ArrowUpRight/></Link></div>
        {sections.length > 0 && <nav className="docs-toc" aria-label="On this page"><p>Section ledger</p><ol>{sections.map(({ id, title }) => <li key={id}><Link href={`#${id}`}>{title}</Link></li>)}</ol></nav>}
      </div></aside>
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
