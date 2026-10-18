import { and, eq, sql } from "drizzle-orm"

import { getDb } from "@/server/db/client"
import { runEvents } from "@/server/db/schema"

/**
 * The run event log.
 *
 * The terminal UI is a pure function of this table: replay the rows for a run and
 * you redraw the screen. That is what lets a TUI attach to a run that started in a
 * browser tab which has since closed, and it is why nothing here is ever updated
 * or deleted — a transcript that can be rewritten is not evidence of what the
 * agent did.
 *
 * `sequence` is monotonic *per run*, and `run_events_seq_idx` is unique on
 * `(run_id, sequence)`. That unique index is what makes the log safe to write
 * from more than one place: the agent's stdout pump and the completion webhook can
 * both append, and the second one to lose the race drops its row rather than
 * forking the sequence.
 */

export type RunEventKind =
  | "run.queued"
  | "run.started"
  | "run.settled"
  | "run.failed"
  | "sandbox.provisioned"
  | "sandbox.ready"
  | "agent.output"
  | "agent.error"
  | "trace.completed"
  | "prompt"
  | "text"
  | "tool_call"
  | "tool_result"
  | "error"

export interface AppendRunEvent {
  readonly runId: string
  readonly kind: RunEventKind
  readonly payload: unknown
  /**
   * An explicit sequence, for replaying a transcript whose numbering is already
   * fixed. Omit it to append at the end.
   */
  readonly sequence?: number
}

/** The next sequence number for a run. */
const nextSequence = async (runId: string): Promise<number> => {
  const db = getDb()
  const [row] = await db
    .select({ next: sql<number>`coalesce(max(${runEvents.sequence}), -1) + 1` })
    .from(runEvents)
    .where(eq(runEvents.runId, runId))

  return row?.next ?? 0
}

/**
 * Append one event. Returns `null` if the sequence was already taken.
 *
 * `onConflictDoNothing` rather than an upsert is deliberate. A duplicate sequence
 * means either a redelivered frame from the runtime or two writers racing; both
 * mean the row is already in the table, and the second write has nothing to add.
 * Overwriting would let a late duplicate replace a richer earlier payload with a
 * truncated one.
 */
export const appendRunEvent = async (
  input: AppendRunEvent
): Promise<{ readonly sequence: number } | null> => {
  const db = getDb()
  const sequence = input.sequence ?? (await nextSequence(input.runId))

  const [row] = await db
    .insert(runEvents)
    .values({
      runId: input.runId,
      sequence,
      kind: input.kind,
      payload: (input.payload ?? null) as Record<string, unknown>
    })
    .onConflictDoNothing({ target: [runEvents.runId, runEvents.sequence] })
    .returning({ sequence: runEvents.sequence })

  return row ? { sequence: row.sequence } : null
}

/**
 * Append a batch, allocating one sequence for the whole batch.
 *
 * A run's output arrives in bursts, and allocating per event would interleave a
 * concurrent writer's row between two events that were emitted together — the
 * transcript would read as though a different thing happened in between. Allocated
 * up front and written in order, the batch is contiguous.
 */
export const appendRunEvents = async (
  runId: string,
  events: readonly { readonly kind: RunEventKind; readonly payload: unknown }[]
): Promise<number> => {
  if (events.length === 0) return 0

  const db = getDb()
  const start = await nextSequence(runId)

  await db
    .insert(runEvents)
    .values(
      events.map((event, offset) => ({
        runId,
        sequence: start + offset,
        kind: event.kind,
        payload: (event.payload ?? null) as Record<string, unknown>
      }))
    )
    .onConflictDoNothing({ target: [runEvents.runId, runEvents.sequence] })

  return events.length
}

/** Every event for a run, in order. This is what redraws the TUI. */
export const readRunEvents = async (
  runId: string
): Promise<readonly { sequence: number; kind: string; payload: unknown; createdAt: Date }[]> => {
  const db = getDb()
  return db
    .select({
      sequence: runEvents.sequence,
      kind: runEvents.kind,
      payload: runEvents.payload,
      createdAt: runEvents.createdAt
    })
    .from(runEvents)
    .where(eq(runEvents.runId, runId))
    .orderBy(runEvents.sequence)
}

/**
 * Drop the event log for a run.
 *
 * The one exception to "never deleted", and it is a privacy deletion rather than a
 * transcript edit: the run row goes with it via `on delete cascade`. Exposed
 * separately so the intent has to be stated at the call site.
 */
export const deleteRunEvents = async (runId: string): Promise<number> => {
  const db = getDb()
  const rows = await db
    .delete(runEvents)
    .where(and(eq(runEvents.runId, runId)))
    .returning({ sequence: runEvents.sequence })
  return rows.length
}
