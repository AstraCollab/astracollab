import type { Metadata } from "next"

import { SettingsPanel } from "./panel"

export const metadata: Metadata = {
  title: "Settings",
  description: "Budgets, extraction, retention, the organisation, and the danger zone."
}

export default function SettingsPage() {
  return <SettingsPanel />
}