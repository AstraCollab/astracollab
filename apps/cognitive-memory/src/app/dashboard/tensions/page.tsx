import type { Metadata } from "next"

import { TensionsPanel } from "./panel"

export const metadata: Metadata = {
  title: "Tensions",
  description: "Claims that cannot both be true, and the question to ask about each."
}

export default function TensionsPage() {
  return <TensionsPanel />
}