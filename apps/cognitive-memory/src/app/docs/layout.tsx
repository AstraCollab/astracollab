import type { Metadata } from "next"

import { DocsShell } from "@/components/docs/shell"

/**
 * The documentation layout.
 *
 * The frame is here rather than in each page, so a new page is a route and a
 * call to `DocPage` — with nothing to remember about the sidebar, the header or
 * the pager. It is also why the pages are plain server components: the only
 * client code under `/docs` is the sidebar, which needs the URL to know where
 * you are, and the copy buttons.
 */
export const metadata: Metadata = {
  title: { default: "Documentation", template: "%s · Cognitive Memory" },
  description:
    "How Cognitive Memory works: the four tiers, what gets learned, how restatements are reconciled, how contradictions are held open, and why every injection is labelled."
}

export default function DocsLayout({ children }: LayoutProps<"/docs">) {
  return <DocsShell>{children}</DocsShell>
}
