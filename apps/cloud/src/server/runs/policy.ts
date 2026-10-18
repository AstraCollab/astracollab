import type { AgentConfig } from "@/server/db/schema"

/**
 * Run duration policy, in one place.
 *
 * Two clocks hang off one number. The run timeout decides when a run that has
 * gone quiet is declared failed and its machine stopped; the sandbox TTL is the
 * provider's own reclaim deadline, and it must outlive the timeout — a machine
 * the provider reclaims while our poller still has a process id would turn a
 * long run into an unexplained 404. So TTL is derived from the timeout with a
 * buffer, never tuned independently.
 */

/** A run that produces nothing for this long is dead, not thinking. */
export const DEFAULT_RUN_TIMEOUT_MS = 30 * 60_000

/** How long a machine may sit untouched before the provider reclaims it. */
const TTL_BUFFER_SECONDS = 30 * 60
const MIN_TTL_SECONDS = 10 * 60
const MAX_TTL_SECONDS = 30 * 24 * 3600

/**
 * The timeout for a run of this agent, in milliseconds.
 *
 * Per-agent override first, default second. Clamped to sane bounds so a typo in
 * agent config cannot set a 10ms timeout or a 10-year one.
 */
export const resolveRunTimeoutMs = (config: AgentConfig): number => {
  const requested = config.timeoutMs
  if (typeof requested !== "number" || !Number.isFinite(requested)) return DEFAULT_RUN_TIMEOUT_MS
  return Math.min(Math.max(requested, 60_000), 6 * 3600_000)
}

/**
 * The TTL to provision or resume with, derived from the run timeout.
 *
 * Applied on both create and resume: a reused sandbox gets a fresh allowance
 * rather than whatever remains of a previous one, so a second run cannot start
 * on a machine with minutes left.
 */
export const resolveSandboxTtlSeconds = (timeoutMs: number): number => {
  const seconds = Math.ceil(timeoutMs / 1000) + TTL_BUFFER_SECONDS
  return Math.min(Math.max(seconds, MIN_TTL_SECONDS), MAX_TTL_SECONDS)
}
