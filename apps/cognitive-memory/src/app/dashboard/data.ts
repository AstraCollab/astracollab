"use client"

import { useCallback, useEffect, useRef, useState } from "react"

/**
 * The dashboard's data layer.
 *
 * Every panel reads through the session cookie and nothing else, so this is where
 * "how does a page talk to the server" lives: the response shapes, one place to
 * turn a failure into something readable, and a hook so ten pages do not each
 * reimplement mount-fetch-cancel.
 *
 * The responses are typed by hand rather than generated. They are hand-written
 * views, so the type is the contract a person can read, and a drift between it
 * and the route shows up as a type error at the call site.
 */

/** A failed request, already flattened to a sentence. */
export class DashboardError extends Error {}

const readBody = async (response: Response): Promise<unknown> =>
  response.json().catch(() => ({}))

const message = (body: unknown, fallback: string): string => {
  if (typeof body === "object" && body !== null && "message" in body) {
    const value = (body as { message: unknown }).message
    if (typeof value === "string" && value !== "") return value
  }
  return fallback
}

export const getJson = async <T>(url: string): Promise<T> => {
  const response = await fetch(url, { credentials: "include" })
  if (!response.ok) {
    throw new DashboardError(message(await readBody(response), `Could not load ${url}.`))
  }
  return (await response.json()) as T
}

export const sendJson = async <T>(
  url: string,
  method: "POST" | "PATCH" | "DELETE",
  body?: unknown
): Promise<T> => {
  const response = await fetch(url, {
    method,
    credentials: "include",
    ...(body === undefined
      ? {}
      : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
  })
  if (!response.ok) {
    throw new DashboardError(message(await readBody(response), `Could not ${method.toLowerCase()} ${url}.`))
  }
  // A 204 has nothing to parse, and the dashboard's own routes always answer
  // with JSON, so an empty body means the caller passed the wrong method.
  return (await response.json().catch(() => ({}))) as T
}

/**
 * Load a resource, with a cancel flag.
 *
 * The fetch starts in the effect body and state is applied in the continuation,
 * so nothing is set synchronously during render. `reload` exists because a panel
 * that can only refresh by navigating away is a panel that lies after a change.
 *
 * `loading` is derived from which request has settled rather than set to true at
 * the start of each one: toggling a flag inside the effect body is the cascade
 * React's own guidance warns about, and the derived value answers the same
 * question — "is the thing on screen stale?" — without a second source of truth.
 */
export const useResource = <T>(url: string | null) => {
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [settled, setSettled] = useState<{ readonly url: string; readonly nonce: number } | null>(null)
  const [nonce, setNonce] = useState(0)
  // Guards a reload that resolves after the url changed underneath it.
  const requested = useRef(url)

  useEffect(() => {
    if (url === null) return
    requested.current = url
    const mine = nonce
    let cancelled = false
    void getJson<T>(url)
      .then((body) => {
        if (cancelled || requested.current !== url) return
        setData(body)
        setError(null)
      })
      .catch((cause: unknown) => {
        if (cancelled || requested.current !== url) return
        setError(cause instanceof Error ? cause.message : "Something went wrong.")
      })
      .finally(() => {
        if (cancelled || requested.current !== url) return
        setSettled({ url, nonce: mine })
      })
    return () => {
      cancelled = true
    }
  }, [url, nonce])

  const reload = useCallback(() => setNonce((value) => value + 1), [])

  const loading = url !== null && (settled?.url !== url || settled?.nonce !== nonce)

  return { data, error, loading, reload, setData }
}

export interface MemoryRow {
  id: string
  content: string
  gist?: string
  tier: string
  domains: Array<string>
  accessCount: number
  source?: string
  sessionId?: string
  createdAt: number
  lastAccessedAt: number
}

export interface Tension {
  id: string
  status: "active" | "latent" | "resolved"
  claimA: { source: string; statement: string; timestamp: number }
  claimB: { source: string; statement: string; timestamp: number }
  impact: "low" | "medium" | "critical"
  actionableQuestion: string
  resolvedBy?: string
  pattern?: string
}

export interface Capability {
  reliabilityScore: number
  sampleCount: number
  knownFailurePatterns: Array<string>
  recommendedStrategies: Array<string>
}

export interface Overview {
  organizationId: string
  memories: Array<MemoryRow>
  stats: {
    total: number
    byTier: Record<string, number>
    sessions: number
    firstStoredAt: number
    lastAccessedAt: number
    activeTensions: number
  }
  selfModel: {
    calibrationFactor: number
    activeDomains: Array<string>
    domains: Record<string, Capability>
    weakDomains: Array<string>
  }
  tensions: Array<Tension>
  budget: {
    effective: { maxTotalTokens: number; maxIndexItems: number; defaultRecallLimit: number }
    overrides: {
      organizationId: string
      maxTotalTokens: number | null
      maxIndexItems: number | null
      defaultRecallLimit: number | null
      retentionDays: number
      extraction: "auto" | "rules"
    } | null
    defaults: { maxTotalTokens: number; maxIndexItems: number; defaultRecallLimit: number }
  }
  extraction: "rules-only" | "rules+model"
  problems: Array<string>
  spend: {
    daily: Array<DailyBucket>
    totals: Totals
  }
  recent: Array<InjectionSummary>
  usedMost: Array<MemoryRow>
}

export interface DailyBucket {
  day: string
  builds: number
  tokens: number
  truncated: number
  added: number
}

export interface Totals {
  builds: number
  tokens: number
  medianTokens: number
  p95Tokens: number
  truncated: number
  truncatedShare: number
  utilisation: number
  memories: number
  memoriesAdded: number
  activeTensions: number
  resolvedTensions: number
  weakDomains: number
  guardrailBuilds: number
  activeKeys: number
}

export interface Analytics {
  from: number
  to: number
  days: number
  totals: Totals
  daily: Array<DailyBucket>
  routes: Array<{ route: string; calls: number; tokens: number }>
  keys: Array<{
    id: string
    name: string
    prefix: string
    calls: number
    tokens: number
    lastUsedAt: string | null
    revoked: boolean
  }>
  reasons: Array<{ label: string; count: number }>
  tiers: Array<{ label: string; count: number }>
  domains: Array<{ label: string; count: number }>
  sources: Array<{ label: string; count: number }>
  largest: Array<{
    id: string
    tokens: number
    bodies: number
    truncated: boolean
    createdAt: string
    preview: string
  }>
  budget: { maxTotalTokens: number; maxIndexItems: number; defaultRecallLimit: number }
}

export interface InjectionSummary {
  id: string
  createdAt: string
  tokens: number
  truncated: boolean
  bodies: number
  indexLines: number
  identifiers: Array<string>
}

export interface InjectionEvent extends InjectionSummary {
  indexLines: number
  identifiers: Array<string>
  reasons: Record<string, number>
  entries: Array<{ id: string; tier: string; reason: string; gist: string; tokens: number }>
  text: string
  apiKeyId: string | null
  key: { name: string; prefix: string } | null
}

export interface MemoryPageResponse {
  total: number
  offset: number
  limit: number
  memories: Array<MemoryRow>
  facets: {
    tiers: Record<string, number>
    sources: Record<string, number>
    domains: Array<{ name: string; count: number }>
  }
}

export interface SelfModelResponse {
  selfModel: Overview["selfModel"]
  outcomes: Array<{
    id: string
    domain: string
    success: boolean
    failurePattern: string | null
    strategy: string | null
    createdAt: string
  }>
}

export interface SettingsResponse {
  settings: Overview["budget"]["overrides"]
  effective: {
    maxTotalTokens: number
    maxIndexItems: number
    defaultRecallLimit: number
    retentionDays: number
    extraction: "rules-only" | "rules+model"
  }
  requestedExtraction: "auto" | "rules"
  deployment: {
    databasePath: string
    modelName: string
    modelProvider: string
    modelConfigured: boolean
    authConfigured: boolean
    defaults: { maxTotalTokens: number; maxIndexItems: number; defaultRecallLimit: number }
  }
  problems: Array<string>
  footprint: { memories: number; keys: number; activeKeys: number }
}

export interface LearnResponse {
  stored: Array<MemoryRow>
  mergedInto: Array<MemoryRow>
  counts: { stored: number; merged: number; rejected: number; tensions: number; promoted: number }
  rejected: Array<{ content: string; reason: string }>
}

/** `POST /api/dashboard/recall`, with the terms that did the matching. */
export interface RecallResponse {
  query: string
  results: Array<{
    memory: MemoryRow
    score: number
    matched: Array<string>
  }>
}

export interface PreviewResponse {
  text: string
  entries: Array<{
    id: string
    tier: string
    reason: string
    gist: string
    body?: string
    tokens: number
  }>
  totalTokens: number
  truncated: boolean
  identifiers: Array<string>
}

export interface KeyRow {
  id: string
  name: string
  prefix: string
  scopes: Array<string>
  createdAt: string
  lastUsedAt: string | null
  revokedAt: string | null
  expiresAt: string | null
  status: "active" | "revoked" | "expired"
}