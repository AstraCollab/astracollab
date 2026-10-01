import type { Metadata } from "next"

import { Dashboard } from "./dashboard"

export const metadata: Metadata = {
  title: "Dashboard",
  description: "Issue API keys, and see exactly what your agent is being told."
}

/**
 * The dashboard.
 *
 * Renders client-side rather than reading a session cookie here: the panels are
 * interactive, and gating the whole route on a server-side session would make
 * every keystroke in the context preview a round trip.
 */
export default function DashboardPage() {
  return <Dashboard />
}
