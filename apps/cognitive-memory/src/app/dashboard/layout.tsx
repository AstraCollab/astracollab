import type { Metadata } from "next"

import { DashboardFrame } from "./shell"

/**
 * The dashboard layout.
 *
 * A server component that owns nothing but the frame: the session check happens
 * inside the client `DashboardFrame`, because the panels it wraps are interactive
 * and a server-side gate would put the session read in front of every one of
 * them. Each page then fetches exactly what it shows through `/api/dashboard/*`,
 * which authenticates the request itself — so the gate here is a convenience, and
 * the authorisation is in the route.
 */
export const metadata: Metadata = {
  title: { default: "Dashboard", template: "%s · Dashboard" },
  description: "Issue API keys, and see exactly what your agent is being told."
}

export default function DashboardLayout({ children }: LayoutProps<"/dashboard">) {
  return <DashboardFrame>{children}</DashboardFrame>
}