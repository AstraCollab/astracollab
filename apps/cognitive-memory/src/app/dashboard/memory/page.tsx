import type { Metadata } from "next"

import { MemoryPanel } from "./panel"

export const metadata: Metadata = {
  title: "Memory library",
  description: "Search, edit, retier and forget what the agent has been told."
}

export default function MemoryPage() {
  return <MemoryPanel />
}