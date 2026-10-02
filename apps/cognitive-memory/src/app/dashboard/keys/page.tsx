import type { Metadata } from "next"

import { KeysPanel } from "./panel"

export const metadata: Metadata = {
  title: "Keys",
  description: "Issue, scope and revoke the credential your agent presents."
}

export default function KeysPage() {
  return <KeysPanel />
}