import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm"

import { getDb } from "@/server/db/client"
import { sandboxes, type AgentConfig, type Sandbox, type SandboxStatus } from "@/server/db/schema"

import { requireSandboxProvider, SandboxNotFoundError } from "./provider"

/**
 * The sandbox state machine, in one table.
 *
 * Transitions are declared rather than checked inline because the illegal ones are
 * the interesting ones, and they are the ones a webhook will eventually try. Boat
 * can deliver a `stopped` for a sandbox we already destroyed, or a `ready` that
 * lands after a `stopped`; without this table each of those is a status clobber
 * that looks fine in the database and wrong on the dashboard.
 *
 * `destroyed` is terminal and `stopped` is not. That distinction is the billing
 * model: a stopped sandbox keeps its disk and snapshots for free, so stopping is
 * a pause, and only destroying frees the machine.
 */
const LEGAL_TRANSITIONS: Readonly<Record<SandboxStatus, readonly SandboxStatus[]>> = {
  starting: ["running", "stopped", "destroyed"],
  running: ["stopped", "destroyed"],
  stopped: ["running", "destroyed"],
  destroyed: []
}

export class IllegalTransitionError extends Error {
  readonly from: SandboxStatus
  readonly to: SandboxStatus

  constructor(from: SandboxStatus, to: SandboxStatus) {
    super(`Illegal sandbox transition ${from} -> ${to}.`)
    this.name = "IllegalTransitionError"
    this.from = from
    this.to = to
  }
}

export const canTransition = (from: SandboxStatus, to: SandboxStatus): boolean =>
  from === to || LEGAL_TRANSITIONS[from].includes(to)

export interface TransitionOptions {
  /** Set once the daemon is reachable, so a resume does not re-resolve it. */
  readonly runtimeUrl?: string | null
  readonly bytesUsed?: number
}

/**
 * Move a sandbox to a new status, or throw.
 *
 * The `from` predicate is part of the `where` rather than checked first, so this is
 * correct under concurrency: two callers racing to destroy the same sandbox both
 * read `running`, but only one update matches, and the loser updates nothing and
 * is told so. Check-then-write would let the second destroy report success and
 * then fail at the provider, which is how a double-charge for a teardown happens.
 */
/**
 * Move a sandbox to a new status, enforcing the table, or throw.
 *
 * The current status is read rather than passed in. Taking it as a caller-supplied
 * `from` list looked tidier and was wrong: it let a caller assert any predecessor it
 * liked, so `LEGAL_TRANSITIONS` was only ever consulted in the two places that
 * remembered to check, and the state machine was advisory everywhere else.
 *
 * The update is then a compare-and-swap on that status, so two callers racing to
 * destroy the same sandbox both read `running`, only one update matches, and the
 * loser is told nothing changed rather than reporting a success it did not have.
 */
export const transitionSandbox = async (
  sandboxId: string,
  to: SandboxStatus,
  options: TransitionOptions = {}
): Promise<Sandbox | null> => {
  const db = getDb()

  const [current] = await db.select().from(sandboxes).where(eq(sandboxes.id, sandboxId))
  if (!current) return null

  const needsPatch =
    options.runtimeUrl !== undefined || options.bytesUsed !== undefined

  // Already there. A retry, a duplicate webhook and a double click all land here,
  // and all of them should report the row rather than write it again.
  if (current.status === to) {
    return needsPatch ? applySandboxPatch(sandboxId, to, options) : current
  }

  if (!canTransition(current.status, to)) {
    throw new IllegalTransitionError(current.status, to)
  }

  return applySandboxPatch(sandboxId, to, options, current.status)
}

const applySandboxPatch = async (
  sandboxId: string,
  to: SandboxStatus,
  options: TransitionOptions,
  expectedFrom?: SandboxStatus
): Promise<Sandbox | null> => {
  const db = getDb()

  const patch: Partial<Sandbox> = { status: to }
  if (options.runtimeUrl !== undefined) patch.runtimeUrl = options.runtimeUrl
  if (options.bytesUsed !== undefined) patch.bytesUsed = options.bytesUsed
  if (to === "destroyed") patch.destroyedAt = new Date()

  const [row] = await db
    .update(sandboxes)
    .set(patch)
    .where(
      expectedFrom
        ? and(eq(sandboxes.id, sandboxId), eq(sandboxes.status, expectedFrom))
        : eq(sandboxes.id, sandboxId)
    )
    .returning()

  return row ?? null
}

/**
 * Find a sandbox this agent can reuse, or provision one.
 *
 * Reuse is why `stopped` is not terminal: a second run for the same agent against
 * a paused sandbox resumes it in seconds at the snapshot's cost, where a fresh
 * machine means a fresh install. The `destroyed` exclusion is what stops a dead
 * machine being handed to a run.
 *
 * A `running` sandbox belongs to whoever is already using it. One run at a time
 * per sandbox is the rule, not an accident — the agent process writes to one
 * working tree, and two concurrent runs would interleave edits.
 */
export interface AcquireOptions {
  /**
   * Machine TTL for the provision or resume that this call may perform.
   *
   * Derived from the run's timeout by `runs/policy` — the caller owns that
   * coupling, lifecycle only applies it. Omitted means the provider default.
   */
  readonly ttlSeconds?: number
}

export const acquireSandbox = async (
  organizationId: string,
  agentId: string,
  config: AgentConfig,
  options: AcquireOptions = {}
): Promise<Sandbox> => {
  const db = getDb()
  const provider = requireSandboxProvider()
  const ttlSeconds = options.ttlSeconds

  const [existing] = await db
    .select()
    .from(sandboxes)
    .where(
      and(
        eq(sandboxes.organizationId, organizationId),
        eq(sandboxes.agentId, agentId),
        inArray(sandboxes.status, ["stopped", "running"])
      )
    )
    .orderBy(desc(sandboxes.createdAt))
    .limit(1)

  if (existing) {
    if (existing.status === "stopped") {
      // Resume with a fresh TTL, then wait for the state to confirm: the resume
      // is a 202, and a command sent against a machine still waking up is a
      // 409 that would look like a launch failure.
      await provider.resume(
        existing.boatSandboxId,
        ttlSeconds !== undefined ? { ttlSeconds } : {}
      )
      await provider.waitForRuntime(existing.boatSandboxId)
      const resumed = await transitionSandbox(existing.id, "running", {
        runtimeUrl: existing.runtimeUrl
      })
      if (resumed) return resumed
    }
    return existing
  }

  const provisioned = await provider.provision({
    organizationId,
    agentId,
    cpu: config.cpu ?? 2,
    memoryMb: config.memoryMb ?? 4096,
    ...(ttlSeconds !== undefined ? { ttlSeconds } : {}),
    env: config.env ?? {}
  })

  const [created] = await db
    .insert(sandboxes)
    .values({
      organizationId,
      agentId,
      boatSandboxId: provisioned.providerSandboxId,
      status: "starting",
      runtimeUrl: provisioned.runtimeUrl
    })
    .returning()

  if (!created) throw new Error("Sandbox insert returned no row.")

  let runtimeUrl: string | null
  try {
    runtimeUrl = await provider.waitForRuntime(provisioned.providerSandboxId)
  } catch (error) {
    // The machine exists and bills from the moment it was created. A wait that
    // fails — bad image, no capacity, immediate error state — has to tear it
    // down, or every cold-start failure becomes a machine nobody can see and
    // nobody will ever stop.
    try {
      await provider.destroy(provisioned.providerSandboxId)
    } catch {
      // Best effort: if the destroy also fails the TTL is the backstop, and the
      // original error is the one the caller needs to see.
    }
    await transitionSandbox(created.id, "destroyed")
    throw error
  }

  const ready = await transitionSandbox(created.id, "running", {
    runtimeUrl: runtimeUrl ?? provisioned.runtimeUrl
  })

  // A concurrent destroy won the race while we were waiting for the daemon. Report
  // that rather than handing back a sandbox we have already torn down.
  if (!ready) throw new Error(`Sandbox ${created.id} left the starting state before it was ready.`)
  return ready
}

/** Stop billing without losing the disk. */
export const stopSandbox = async (sandboxId: string): Promise<Sandbox | null> => {
  const provider = requireSandboxProvider()
  const [current] = await getDb().select().from(sandboxes).where(eq(sandboxes.id, sandboxId))
  if (!current) return null

  // A destroyed sandbox cannot be stopped, and asking the provider to stop a
  // machine we have already torn down is a call that either 404s or, worse, is
  // billed. Report the row as it is rather than raising at the caller.
  if (!canTransition(current.status, "stopped")) return current

  if (current.status !== "stopped") {
    await provider.stop(current.boatSandboxId)
  }
  return transitionSandbox(sandboxId, "stopped")
}

/** The only transition that frees the machine. */
export const destroySandbox = async (sandboxId: string): Promise<Sandbox | null> => {
  const provider = requireSandboxProvider()
  const [current] = await getDb().select().from(sandboxes).where(eq(sandboxes.id, sandboxId))
  if (!current) return null

  if (current.status !== "destroyed") {
    await provider.destroy(current.boatSandboxId)
  }
  // Idempotent by way of the transition itself: a second destroy finds the row
  // already `destroyed`, skips the provider, and reports it back unchanged.
  return transitionSandbox(sandboxId, "destroyed")
}

export interface DriftRow {
  readonly id: string
  readonly status: SandboxStatus
  readonly providerStatus: string
}

/**
 * Compare what the database believes against what the provider reports.
 *
 * Without this a sandbox deleted out of band — the machine was destroyed from the
 * Boat console, or the account was paused — stays `running` forever. The dashboard
 * then offers to attach to a machine that no longer exists, and every attempt
 * fails with a 404 from a provider the user has never heard of. Provider state is
 * the truth; the database is a cache of it, and a cache that cannot be wrong is
 * not a cache.
 */
export const reconcileSandboxes = async (
  organizationId: string
): Promise<readonly DriftRow[]> => {
  const provider = requireSandboxProvider()
  const db = getDb()

  const ours = await db
    .select()
    .from(sandboxes)
    .where(
      and(
        eq(sandboxes.organizationId, organizationId),
        // `destroyed` is our own terminal state, not the provider's, and a
        // destroyed machine has no provider row to compare against.
        isNull(sql`${sandboxes.destroyedAt}`)
      )
    )

  const drift: DriftRow[] = []
  for (const row of ours) {
    try {
      const seen = await provider.exec(row.boatSandboxId, "true", [], { timeoutMs: 15_000 })
      // exitCode 0 means the machine executed our probe: it exists and runs
      // commands, which is the only thing this check can honestly assert.
      if (seen.exitCode === 0) continue
      drift.push({ id: row.id, status: row.status, providerStatus: "missing" })
    } catch (error) {
      // A 404-shaped provider error means the machine is provably gone — that
      // is drift, and the row must stop advertising a sandbox that cannot be
      // attached to. Anything else — a timeout, a 5xx, a network blip — is the
      // provider having a bad moment, and a bad moment is not evidence that a
      // healthy machine is dead: skipping keeps it trustworthy.
      if (error instanceof SandboxNotFoundError) {
        drift.push({ id: row.id, status: row.status, providerStatus: "missing" })
      }
    }
  }

  return drift
}
