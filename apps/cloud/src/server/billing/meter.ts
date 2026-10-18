import { eq, sql } from "drizzle-orm"

import { getDb } from "@/server/db/client"
import { runs, sandboxes, usageLedger } from "@/server/db/schema"

/**
 * Metering: turning a settled run into exactly one billable ledger row.
 *
 * The ledger is append-only, so "how much did this run cost" is answered by
 * writing the answer once and never revising it. That makes idempotency the whole
 * problem — a run can be settled from more than one path (a user cancelling it,
 * the sandbox reporting its exit code), and if both of those meter, the customer is
 * charged twice for one run and there is no row to correct because rows are never
 * updated.
 *
 * Idempotency is therefore enforced by `usage_run_unique_idx`, not by a check. The
 * insert conflicts on that index and the conflicting row is dropped. A `select`
 * first would look equivalent and is not: two concurrent settles both see no row,
 * both insert, and one of them wins the race silently.
 */

/** What a single settled run cost. */
export interface MeteredUsage {
  readonly runId: string
  readonly tokens: number
  readonly computeMs: number
  readonly storageBytes: number
}

/** A run's terminal states. Metering any other status bills work still in flight. */
const SETTLED = ["succeeded", "failed", "cancelled"] as const

/**
 * Write the ledger row for a settled run, if it has not been written already.
 *
 * Returns what was metered, or `null` if there was nothing to do — the run has not
 * settled, or it was already metered. `null` is the normal return for a repeated
 * call and callers should not treat it as a failure.
 *
 * The organisation is taken from the run row rather than from the caller. A meter
 * function that accepted an org id would be a way to bill one tenant for another
 * tenant's run, and the join that would introduce is exactly the sort of thing that
 * reads as harmless.
 */
export async function meterRun(runId: string): Promise<MeteredUsage | null> {
  const db = getDb()

  const [run] = await db
    .select({
      id: runs.id,
      organizationId: runs.organizationId,
      status: runs.status,
      tokensIn: runs.tokensIn,
      tokensOut: runs.tokensOut,
      startedAt: runs.startedAt,
      finishedAt: runs.finishedAt,
      sandboxId: runs.sandboxId
    })
    .from(runs)
    .where(eq(runs.id, runId))
    .limit(1)

  if (run === undefined) return null
  if (!SETTLED.includes(run.status as (typeof SETTLED)[number])) return null

  // Storage is the sandbox the run was pointed at, resolved through the Boat id
  // that `runs.sandboxId` holds. It is read now rather than at destroy time so the
  // ledger records the peak a run actually reached — a sandbox destroyed later
  // still bills what it held while the run was live.
  const [sandbox] = run.sandboxId
    ? await db
        .select({ bytesUsed: sandboxes.bytesUsed })
        .from(sandboxes)
        .where(eq(sandboxes.boatSandboxId, run.sandboxId))
        .limit(1)
    : [undefined]

  const usage: MeteredUsage = {
    runId: run.id,
    tokens: (run.tokensIn ?? 0) + (run.tokensOut ?? 0),
    computeMs: computeMsFor(run.startedAt, run.finishedAt),
    storageBytes: sandbox?.bytesUsed ?? 0
  }

  await db
    .insert(usageLedger)
    .values({
      organizationId: run.organizationId,
      runId: run.id,
      tokens: usage.tokens,
      computeMs: usage.computeMs,
      storageBytes: usage.storageBytes
    })
    // The `where` is required, not decorative.
    //
    // `usage_run_unique_idx` is *partial* — it covers only rows where `run_id` is
    // not null — and Postgres will not infer a partial index from an `ON CONFLICT`
    // that does not repeat its predicate. Without this clause the insert fails
    // outright with "there is no unique or exclusion constraint matching the ON
    // CONFLICT specification", which means every metered run would throw rather
    // than deduplicate. Verified against Postgres rather than assumed; see
    // `scripts/probe-on-conflict-partial.ts`.
    .onConflictDoNothing({
      target: usageLedger.runId,
      where: sql`${usageLedger.runId} is not null`
    })

  return usage
}

/**
 * Milliseconds a run held a CPU, clamped at zero.
 *
 * The clamp is not defensive noise. `startedAt` and `finishedAt` are set by
 * different writers — one when the run starts, one when it settles — and a run
 * cancelled very quickly can settle in the same millisecond it started, or on a
 * clock that moved backwards underneath it. A negative `computeMs` would be a
 * credit on an invoice, which is not a thing this table should be able to produce.
 *
 * A run that never started bills zero compute rather than the age of the run.
 * Charging for a queued run that no CPU ever touched would make a stuck queue look
 * expensive, which is backwards.
 */
function computeMsFor(startedAt: Date | null, finishedAt: Date | null): number {
  if (startedAt === null || finishedAt === null) return 0
  return Math.max(0, finishedAt.getTime() - startedAt.getTime())
}

/** Totals across an organization's ledger, for the usage page header. */
export async function readUsageTotals(organizationId: string): Promise<{
  readonly tokens: number
  readonly computeMs: number
  readonly storageBytes: number
  readonly entries: number
}> {
  const db = getDb()

  const [row] = await db
    .select({
      tokens: sql<string>`coalesce(sum(${usageLedger.tokens}), 0)::bigint`,
      computeMs: sql<string>`coalesce(sum(${usageLedger.computeMs}), 0)::bigint`,
      storageBytes: sql<string>`coalesce(sum(${usageLedger.storageBytes}), 0)::bigint`,
      entries: sql<number>`count(*)::int`
    })
    .from(usageLedger)
    .where(eq(usageLedger.organizationId, organizationId))

  return {
    tokens: Number(row?.tokens ?? 0),
    computeMs: Number(row?.computeMs ?? 0),
    storageBytes: Number(row?.storageBytes ?? 0),
    entries: row?.entries ?? 0
  }
}