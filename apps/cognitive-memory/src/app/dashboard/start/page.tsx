import type { Metadata } from "next"

import { StartPanel } from "./panel"

export const metadata: Metadata = {
  title: "Get started",
  description: "Wire an agent to this service, and try it against your own key."
}

export default function StartPage() {
  return <StartPanel />
}