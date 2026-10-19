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
/**
 * Where the browser sends auth requests.
 *
 * The origin that served this page, unless the operator says otherwise. The
 * dashboard, `/api/auth` and `/api/v1` are one app on one host, so the origin
 * that served the page is the one that has to answer.
 *
 * The literal `http://localhost:3000` that used to be the default was not a
 * fallback but a target. `NEXT_PUBLIC_*` values are inlined at build time, so
 * a production build without the variable set shipped a bundle that asked
 * every visitor's browser to talk to `http://localhost:3000` — the visitor's
 * own machine, not this deployment.
 *
 * The variable stays for the split case: a dashboard served from one host
 * talking to an auth server on another.
 */
const baseURL =
  process.env.NEXT_PUBLIC_COGNITIVE_MEMORY_URL?.trim() ||
  (typeof window === "undefined" ? undefined : window.location.origin)

export const authClient = createAuthClient({
  ...(baseURL ? { baseURL } : {}),
  plugins: [organizationClient()]
})
