"use client"

import { createAuthClient } from "better-auth/react"

/**
 * The browser-side Better Auth client.
 *
 * A client component module, because `createAuthClient` registers fetch hooks and
 * cache bindings that only make sense after hydration. Imported by the sign-in and
 * sign-up forms; nothing on the server imports it.
 *
 * No baseURL: the client resolves same-origin `/api/auth`, which is where the
 * catch-all route mounts Better Auth.
 */
export const authClient = createAuthClient()