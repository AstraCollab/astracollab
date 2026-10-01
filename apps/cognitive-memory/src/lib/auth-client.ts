"use client"

import { organizationClient } from "better-auth/client/plugins"
import { createAuthClient } from "better-auth/react"

/**
 * Better Auth, from the browser.
 *
 * One client for the whole dashboard. The organisation plugin is here because a
 * Better Auth organisation is exactly what a memory key is scoped to, so choosing
 * an organisation in the UI is choosing whose memory you are looking at.
 */
export const authClient = createAuthClient({
  baseURL: process.env.NEXT_PUBLIC_COGNITIVE_MEMORY_URL || "http://localhost:3000",
  plugins: [organizationClient()]
})
