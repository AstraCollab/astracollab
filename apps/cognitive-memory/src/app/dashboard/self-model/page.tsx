import type { Metadata } from "next"
import { headers } from "next/headers"

import { resolveOrigin } from "@/server/auth/origin"

import { SelfModelPanel } from "./panel"

export const metadata: Metadata = {
  title: "Self-model",
  description: "How reliable this agent is per domain, and the guardrails that follow."
}

/**
 * The page that says how reliable this agent is.
 *
 * The sample names the origin the reader is already on, for the same reason the
 * start page does: a snippet that says `localhost:3000` on a deployment that is
 * not on localhost sends the reader's agent to their own machine.
 */
export default async function SelfModelPage() {
  const requestHeaders = await headers()

  return <SelfModelPanel origin={resolveOrigin(requestHeaders)} />
}
