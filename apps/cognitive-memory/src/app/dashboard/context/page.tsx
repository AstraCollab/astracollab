import type { Metadata } from "next"

import { ContextPanel } from "./panel"

export const metadata: Metadata = {
  title: "Context",
  description: "The exact block an agent would be given, for any message."
}

export default function ContextPage() {
  return <ContextPanel />
}