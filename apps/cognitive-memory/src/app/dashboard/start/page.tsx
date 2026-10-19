import type { Metadata } from "next"
import { headers } from "next/headers"

import { resolveOrigin } from "@/server/auth/origin"

import { StartPanel } from "./panel"

export const metadata: Metadata = {
  title: "Get started",
  description: "Wire an agent to this service, and try it against your own key."
}

/**
 * The page that says how to point an agent at this service.
 *
 * The snippets name the origin the reader is already on, because a snippet that
 * says `localhost:3000` on a deployment that is not on localhost sends the
 * reader's agent to their own machine. The origin is resolved from the request
 * rather than baked in, so one build serves every host it is deployed on.
 */
export default async function StartPage() {
  const requestHeaders = await headers()

  return <StartPanel origin={resolveOrigin(requestHeaders)} />
}
