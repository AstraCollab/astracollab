import type { Metadata } from "next"

import { AnalyticsPanel } from "./panel"

export const metadata: Metadata = {
  title: "Analytics",
  description: "What memory costs per turn, and whether the budget is the thing to change."
}

export default function AnalyticsPage() {
  return <AnalyticsPanel />
}