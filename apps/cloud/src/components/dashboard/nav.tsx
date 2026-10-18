"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"

import { SignOutButton } from "@/components/dashboard/sign-out-button"

/**
 * The dashboard's sidebar.
 *
 * A client component only because it highlights the item you are on, which needs
 * the current pathname — a value the server does not have during render. The
 * identity it displays is still passed in from the server, so it costs one small
 * boundary rather than a session lookup on the client.
 */
export function DashboardNav({
  viewerEmail,
  organizationName
}: {
  readonly viewerEmail: string
  readonly organizationName: string | null
}) {
  const pathname = usePathname()

  const items = [
    { href: "/dashboard", label: "Overview" },
    { href: "/dashboard/agents", label: "Agents" },
    { href: "/dashboard/runs", label: "Runs" },
    { href: "/dashboard/traces", label: "Traces" },
    { href: "/dashboard/analytics", label: "Analytics" },
    { href: "/dashboard/sandboxes", label: "Sandboxes" },
    { href: "/dashboard/usage", label: "Usage" },
    { href: "/dashboard/keys", label: "Keys" },
    { href: "/dashboard/settings", label: "Settings" }
  ]

  // Exact match for the overview, prefix for the rest — otherwise `/dashboard`
  // stays highlighted while you are three levels deep in it.
  const isActive = (href: string) =>
    href === "/dashboard" ? pathname === href : pathname.startsWith(href)

  return (
    <aside className="flex shrink-0 flex-col gap-6 lg:w-60">
      <Link href="/" className="flex items-center gap-2.5 px-1 font-medium">
        <span
          className="size-2 rounded-full bg-signal shadow-[0_0_12px_rgb(167_139_250/0.6)]"
          aria-hidden="true"
        />
        Nah Cloud
      </Link>

      <nav className="flex flex-col gap-0.5">
        {items.map((item) => (
          <Link
            key={item.href}
            href={item.href}
            aria-current={isActive(item.href) ? "page" : undefined}
            className={
              isActive(item.href)
                ? "rounded-[0.75rem] border border-line bg-[var(--surface-raised)] px-3 py-2 text-sm text-[var(--ink)]"
                : "rounded-[0.75rem] border border-transparent px-3 py-2 text-sm text-[var(--ink-muted)] transition-colors hover:text-[var(--ink)]"
            }
          >
            {item.label}
          </Link>
        ))}
      </nav>

      <div className="mt-auto rounded-[0.75rem] border border-line p-4">
        <p className="eyebrow">{organizationName ?? "No organisation"}</p>
        <p className="font-mono-tech mt-2 truncate text-xs text-[var(--ink-muted)]">
          {viewerEmail}
        </p>
        <div className="mt-4">
          <SignOutButton />
        </div>
      </div>
    </aside>
  )
}
