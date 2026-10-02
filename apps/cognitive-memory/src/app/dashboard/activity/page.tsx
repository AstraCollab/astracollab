import type { Metadata } from "next"

import { ActivityPanel } from "./panel"

export const metadata: Metadata = {
  title: "Activity",
  description: "Every context build, with the exact block that was injected."
}

export default function ActivityPage() {
  return <ActivityPanel />
}