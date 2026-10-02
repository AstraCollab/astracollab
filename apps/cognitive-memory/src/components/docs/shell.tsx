import type { ReactNode } from "react"

import { SiteFooter } from "@/components/site-footer"
import { SiteHeader } from "@/components/site-header"

import { DocsSideNav } from "./side-nav"

/**
 * The documentation frame.
 *
 * Wider than the marketing pages, because a reference needs three columns where
 * a landing page has one: the map, the prose, and the contents of the page you
 * are on. The header and footer take the width from here so the logo, the frame
 * and the footer rule line up with the sidebar instead of stopping short of it.
 */
export function DocsShell({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-full flex-col">
      <SiteHeader width="max-w-6xl" />

      <div className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-6 px-6 py-10 lg:flex-row lg:gap-10">
        <DocsSideNav />
        <main className="min-w-0 flex-1">{children}</main>
      </div>

      <SiteFooter width="max-w-6xl" />
    </div>
  )
}
