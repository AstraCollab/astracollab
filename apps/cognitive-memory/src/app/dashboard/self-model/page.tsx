import type { Metadata } from "next"

import { SelfModelPanel } from "./panel"

export const metadata: Metadata = {
  title: "Self-model",
  description: "How reliable this agent is per domain, and the guardrails that follow."
}

export default function SelfModelPage() {
  return <SelfModelPanel />
}