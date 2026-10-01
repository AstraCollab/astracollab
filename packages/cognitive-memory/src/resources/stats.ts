import type { HttpClient } from "../client"
import type { Health, Stats } from "../types"

/** What the memory currently holds, and what the service can do. */
export class StatsResource {
  constructor(private readonly client: HttpClient) {}

  /** Needs only `stats:read`, so monitoring can watch without reading memories. */
  get(): Promise<Stats> {
    return this.client<Stats>("/stats", { method: "GET" })
  }
}

/**
 * Liveness, and this deployment's limits and extractor mode.
 *
 * Takes an explicit base URL because it is the one call that must work with no
 * key at all — including from a health check that has no credentials.
 */
export const fetchHealth = async (baseUrl: string): Promise<Health> => {
  const origin = baseUrl.replace(/\/$/, "")
  const response = await fetch(`${origin}/api/v1/health`, { headers: { accept: "application/json" } })
  if (!response.ok) {
    throw new Error(`cognitive-memory: health check failed with ${response.status}`)
  }
  return (await response.json()) as Health
}
