import type { Metadata } from "next"

import { OverviewPanel } from "./panel"

export const metadata: Metadata = {
  title: "Overview",
  description: "What this agent knows, what it contradicts, and what it is costing."
}

export default function DashboardPage() {
  return <OverviewPanel />
}