"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"

import { DOC_GROUPS } from "@/lib/docs"

/**
 * The documentation sidebar.
 *
 * A client component for one reason: the active page is read from the URL rather
 * than passed in by each of the fifteen pages. Passing it down means every page
 * has to name its own route correctly, and a page that names the wrong one
 * renders a sidebar that highlights the wrong entry — a bug that looks like
 * nothing at all until someone is already lost.
 *
 * Same list, two shapes: a wrapping row of links on a phone, a column on a
 * desk. The alternative, a disclosure on small screens, hides the whole
 * information architecture behind a click on exactly the device where you most
 * need to know there are other pages.
 */
export function DocsSideNav() {
  const pathname = usePathname()

  return (
    // Sticky on a desk, and only there. Fifteen entries in three groups is a
    // column you want available while reading the bottom of a page — being able
    // to jump to the next page without scrolling back up is most of what a
    // sidebar is for. Below `lg` it becomes a single scrolling row above the
    // content, where sticking it would pin a full-width bar over the page.
    <nav
      aria-label="Documentation"
      className="w-full shrink-0 lg:sticky lg:top-20 lg:max-h-[calc(100vh-6rem)] lg:w-44 lg:self-start lg:overflow-y-auto"
    >
      <ul className="flex gap-6 overflow-x-auto pb-1 lg:flex-col lg:gap-7 lg:overflow-visible lg:pb-0">
        {DOC_GROUPS.map((group) => (
          <li key={group.label} className="shrink-0">
            <p className="font-mono text-[9px] uppercase tracking-widest text-zinc-700 lg:pb-2">
              {group.label}
            </p>
            <ul className="mt-1.5 flex gap-0.5 lg:flex-col lg:gap-0.5">
              {group.pages.map((page) => {
                const current = pathname === page.href
                return (
                  <li key={page.href}>
                    <Link
                      href={page.href}
                      title={page.summary}
                      aria-current={current ? "page" : undefined}
                      className={`block whitespace-nowrap rounded-md px-2.5 py-1.5 text-[13px] transition ${
                        current
                          ? "bg-white/[0.06] text-zinc-100"
                          : "text-zinc-500 hover:bg-white/[0.03] hover:text-zinc-200"
                      }`}
                    >
                      {page.title}
                    </Link>
                  </li>
                )
              })}
            </ul>
          </li>
        ))}
      </ul>
    </nav>
  )
}
