import Link from "next/link";
import { ArrowUpRight, Braces, ChevronDown, Cloud, Code2, Eye, GitBranch, Terminal, Workflow } from "lucide-react";

export function SiteNav() {
  return <header className="site-nav"><nav className="nav-inner" aria-label="Main navigation">
    <Link href="/" className="brand"><span className="brand-mark">n.</span><span>nah<span className="brand-sub"> / not another harness</span></span></Link>
    <div className="nav-links">
      <div className="nav-group"><button className="nav-trigger">Product <ChevronDown size={13}/></button><div className="nav-menu">
        <Link href="/framework"><Braces/><span><b>Framework</b><small>Build agents with a loop you own</small></span></Link>
        <Link href="/agent"><Terminal/><span><b>NAH Agent</b><small>A practical coding agent</small></span></Link>
        <Link href="/studio"><Eye/><span><b>Studio</b><small>See what your agents did</small></span></Link>
        <Link href="/cloud"><Cloud/><span><b>NAH Cloud <em>soon</em></b><small>Bring your agents together</small></span></Link>
      </div></div>
      <div className="nav-group"><button className="nav-trigger">Resources <ChevronDown size={13}/></button><div className="nav-menu">
        <Link href="/docs"><Code2/><span><b>Documentation</b><small>Guides, API, and examples</small></span></Link>
        <Link href="/how-it-works"><Workflow/><span><b>How it works</b><small>From model call to real work</small></span></Link>
        <Link href="https://github.com/astracollab"><GitBranch/><span><b>GitHub</b><small>Open source, built in public</small></span></Link>
      </div></div>
    </div>
    <Link href="/docs/installation" className="nav-cta">Get started <ArrowUpRight size={14}/></Link>
  </nav></header>;
}

export function SiteFooter() {
  return <footer className="site-footer"><Link href="/" className="brand"><span className="brand-mark">n.</span><span>nah</span></Link><span>Open tools for agents that do real work.</span><div><Link href="/docs">Docs</Link><Link href="/cloud">NAH Cloud</Link><Link href="https://github.com/astracollab">GitHub <ArrowUpRight size={12}/></Link></div></footer>;
}
