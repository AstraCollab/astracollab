import { and, asc, count, desc, eq, gte, sql, sum, type SQL } from "drizzle-orm"
import type { AnyPgColumn } from "drizzle-orm/pg-core"

import { getDb } from "@/server/db/client"
import { agents, runs, spans, traces } from "@/server/db/schema"

/**
 * The numbers the analytics page shows, computed from stored traces.
 *
 * Every query here is scoped by `organizationId` from the session — the same
 * tenancy seam the pages and actions use. There is deliberately no function in
 * this file that takes an organisation id as an argument: an analytics helper
 * that will accept any org id is one call site away from leaking.
 *
 * The aggregations run in Postgres rather than in JavaScript. A dashboard reads a
 * row count a database is good at and a JavaScript layer is bad at, and pulling
 * every span of the last thirty days into memory to count them in a `reduce` is
 * the thing that makes an analytics page slow exactly when someone cares about
 * it most.
 */

/**
 * Where the `sql` tags in this file are, and are not, unavoidable.
 *
 * Drizzle's builder covers filters, joins, ordering and plain aggregates. It does
 * not cover Postgres's *window and conditional* aggregates or its jsonb operators,
 * so those have to be written as SQL. Every one of them is written through the
 * ``sql`…` `` tag with columns interpolated as `${column}`, which means the table
 * name, column name and quoting still come from the schema rather than being typed
 * out by hand — the failure mode that bit this file once already.
 *
 * What each fragment is for, and why the builder has no answer:
 *
 * - `count(*)::int` — Drizzle has `count()`, but it emits a bare `count(*)`,
 *   which is `bigint` on the wire. `postgres` has no int8 parser, so it arrives as
 *   a JS *string*: `"42"`, not `42`. The `::int` is what makes it a number. Every
 *   aggregate here carries that cast, and it is the single most common piece of
 *   raw SQL in the file for exactly this reason.
 * - `count(*) filter (where …)` — conditional aggregate. No builder method models
 *   `FILTER`; the alternative is a self-join or a `sum(case when …)`, both of
 *   which scan more than this does.
 * - `percentile_cont(…) within group (order by …)` — medians and p95s. Drizzle
 *   ships no percentile function at all, and this is not one that can be built
 *   from the primitives it does have.
 * - `coalesce(sum(col), 0)` — Drizzle has `sum()`, used below, but not `coalesce`.
 *   The wrapper is what makes "no rows" read as `0` instead of `null`, which is
 *   the difference between a dashboard that renders and one that throws.
 * - `attributes->>'…'` — jsonb extraction. Drizzle 0.45 has no operator helper for
 *   it; the attributes blob is where the harness records the model and tool names,
 *   so it has to be read from there.
 * - `sum((attributes->>'…')::bigint)` — and the one precedence trap in this file.
 *   `::` binds tighter than `->>`, so writing the cast as
 *   `sum(${fragment}::bigint)` makes it the *key literal* that is cast, not the
 *   extracted value: Postgres reads `'gen_ai.usage.input_tokens'::bigint` and
 *   fails with `invalid input syntax for type bigint`. The parentheses around the
 *   fragment are load-bearing. `count(*)::int` is fine without them because
 *   `count(*)` is a function call and already an atom.
 * - `to_char(to_timestamp(…))` — the span timestamps are epoch milliseconds held
 *   in a `bigint`, not a `timestamp`, so they need converting before bucketing.
 *
 * Everything else — the `where`, `join`, `groupBy`, `orderBy` and `limit` on every
 * query below — is ordinary Drizzle, including the `organizationId` tenancy filter
 * on each one.
 */

/** The window the dashboard shows. Fixed, not a filter, for v1. */
export const ANALYTICS_WINDOW_DAYS = 30

/** `count(*)`, cast so it arrives as a number rather than a string. */
const rowCount = sql<number>`count(*)::int`

/** `count(*)` restricted to the rows matching a predicate. */
const countWhere = (predicate: SQL): SQL<number> =>
  sql<number>`count(*) filter (where ${predicate})::int`

/** `sum(col)` with the empty-set case folded to zero. */
const totalOf = (column: AnyPgColumn): SQL<string> =>
  sql`coalesce(${sum(column)}, 0)::bigint`

/** One point on the time series. Oldest first. */
export interface TimeseriesPoint {
  readonly day: string
  readonly traces: number
  readonly errors: number
  readonly costMicros: number
  readonly inputTokens: number
  readonly outputTokens: number
}

/** A tool, aggregated across every span that used it. */
export interface ToolStat {
  readonly tool: string
  readonly calls: number
  readonly errors: number
  readonly totalMs: number
  readonly p95Ms: number
}

/** A model, and what it cost. */
export interface ModelStat {
  readonly model: string
  readonly calls: number
  readonly costMicros: number
  readonly inputTokens: number
  readonly outputTokens: number
}

/** The headline figures. */
export interface Summary {
  readonly traces: number
  readonly errors: number
  readonly costMicros: number
  readonly inputTokens: number
  readonly outputTokens: number
  readonly medianDurationMs: number
  readonly runs: number
}

/**
 * Totals over the window.
 *
 * `medianDurationMs` is computed in the database with `percentile_cont`. The
 * mean would be wrong here and visibly so: one agent that hung for twenty
 * minutes moves a mean far enough to make every other run look fast, and the
 * number on the dashboard would stop answering "how long does a run take".
 */
export async function readSummary(organizationId: string): Promise<Summary> {
  const db = getDb()
  const since = windowStart()

  const [row] = await db
    .select({
      traces: rowCount,
      errors: countWhere(eq(traces.status, "error")),
      costMicros: totalOf(traces.costUsd),
      inputTokens: totalOf(traces.inputTokens),
      outputTokens: totalOf(traces.outputTokens),
      medianDurationMs: sql<number>`coalesce(
        percentile_cont(0.5) within group (
          order by (${traces.endTime} - ${traces.startTime})::double precision
        ) filter (where ${traces.endTime} is not null),
        0
      )::float`
    })
    .from(traces)
    .where(and(eq(traces.organizationId, organizationId), gte(traces.startTime, since)))

  const [runsRow] = await db
    .select({ runs: rowCount })
    .from(runs)
    .where(eq(runs.organizationId, organizationId))

  return {
    traces: row?.traces ?? 0,
    errors: row?.errors ?? 0,
    costMicros: Number(row?.costMicros ?? 0),
    inputTokens: Number(row?.inputTokens ?? 0),
    outputTokens: Number(row?.outputTokens ?? 0),
    medianDurationMs: Math.round(row?.medianDurationMs ?? 0),
    runs: runsRow?.runs ?? 0
  }
}

/**
 * One bucket per day, oldest first.
 *
 * The zero-fill matters more than it looks. A gap in the returned rows means no
 * traces happened that day, and a chart that skips those days silently compresses
 * the time axis — a quiet Tuesday reads as a quiet weekend and the reader cannot
 * tell a flat week from a spike. So missing days are materialised as zeroes here,
 * not left to the caller.
 */
export async function readTimeseries(organizationId: string): Promise<readonly TimeseriesPoint[]> {
  const db = getDb()
  const since = windowStart()

  // Grouped by the same expression that is selected. Writing `group by 1` would
  // be shorter, but it makes the grouping depend on the column order of the
  // select list above — reordering that list for readability would silently
  // regroup the query.
  const day = sql<string>`to_char(
    to_timestamp(${traces.startTime} / 1000.0) at time zone 'utc',
    'YYYY-MM-DD'
  )`

  const rows = await db
    .select({
      day,
      traces: rowCount,
      errors: countWhere(eq(traces.status, "error")),
      costMicros: totalOf(traces.costUsd),
      inputTokens: totalOf(traces.inputTokens),
      outputTokens: totalOf(traces.outputTokens)
    })
    .from(traces)
    .where(and(eq(traces.organizationId, organizationId), gte(traces.startTime, since)))
    .groupBy(day)
    .orderBy(asc(day))

  const byDay = new Map(
    rows.map((row) => [
      row.day,
      {
        day: row.day,
        traces: row.traces,
        errors: row.errors,
        // `sum()` comes back as a string — see `totalOf`. The chart does
        // arithmetic on these, so they are converted here rather than at each of
        // the four places that read them.
        costMicros: Number(row.costMicros),
        inputTokens: Number(row.inputTokens),
        outputTokens: Number(row.outputTokens)
      }
    ])
  )
  const empty: TimeseriesPoint = {
    day: "",
    traces: 0,
    errors: 0,
    costMicros: 0,
    inputTokens: 0,
    outputTokens: 0
  }

  const out: TimeseriesPoint[] = []
  for (let offset = ANALYTICS_WINDOW_DAYS - 1; offset >= 0; offset -= 1) {
    const day = dayKey(nowMs() - offset * DAY_MS)
    out.push(byDay.get(day) ?? { ...empty, day })
  }
  return out
}

/**
 * Per-tool call counts and error rates.
 *
 * Read out of `spans.attributes` rather than a dedicated column because the
 * harness writes `nah.tool.name` there and that is the single source of truth. The
 * `->>` cast is what makes it queryable: without it Postgres compares the jsonb
 * value itself and finds nothing.
 *
 * p95 rather than the mean, for the same reason the summary uses a median — one
 * slow tool call should not redefine what "fast" means for that tool.
 */
export async function readToolStats(
  organizationId: string
): Promise<readonly ToolStat[]> {
  const db = getDb()
  const since = windowStart()

  // Written with the query builder and interpolated columns rather than as a raw
  // `sql` string. The physical table is `nah_spans` — the schema prefixes every
  // table — so a hand-written `spans.attributes` in a raw fragment resolves to a
  // relation that does not exist, and it fails at runtime rather than at compile
  // time. Interpolating `${spans.attributes}` makes Drizzle emit the qualified
  // name, so the query survives the prefix being renamed.
  const tool = sql<string>`${spans.attributes}->>'nah.tool.name'`

  const rows = await db
    .select({
      tool,
      calls: rowCount,
      errors: countWhere(eq(spans.status, "error")),
      totalMs: sql<number>`coalesce(
        sum(${spans.endTime} - ${spans.startTime}) filter (where ${spans.endTime} is not null),
        0
      )::bigint`,
      p95Ms: sql<number>`coalesce(
        percentile_cont(0.95) within group (
          order by (${spans.endTime} - ${spans.startTime})::double precision
        ) filter (where ${spans.endTime} is not null),
        0
      )::float`
    })
    .from(spans)
    .where(
      and(
        eq(spans.organizationId, organizationId),
        eq(spans.kind, "tool"),
        gte(spans.startTime, since),
        sql`${tool} is not null`
      )
    )
    .groupBy(tool)
    .orderBy(desc(sql`count(*)`))
    .limit(25)

  return rows.map((row) => ({
    tool: row.tool,
    calls: row.calls,
    errors: row.errors,
    totalMs: Number(row.totalMs),
    p95Ms: Math.round(row.p95Ms)
  }))
}

/** Per-model spend, from the `model` spans' attributes. */
export async function readModelStats(organizationId: string): Promise<readonly ModelStat[]> {
  const db = getDb()
  const since = windowStart()

  const model = sql<string>`${spans.attributes}->>'gen_ai.request.model'`
  const inputTokens = sql<string>`${spans.attributes}->>'gen_ai.usage.input_tokens'`
  const outputTokens = sql<string>`${spans.attributes}->>'gen_ai.usage.output_tokens'`

  const rows = await db
    .select({
      model,
      calls: rowCount,
      costMicros: totalOf(spans.costUsdMicros),
      inputTokens: sql<number>`coalesce(sum((${inputTokens})::bigint), 0)::bigint`,
      outputTokens: sql<number>`coalesce(sum((${outputTokens})::bigint), 0)::bigint`
    })
    .from(spans)
    .where(
      and(
        eq(spans.organizationId, organizationId),
        eq(spans.kind, "model"),
        gte(spans.startTime, since),
        sql`${model} is not null`
      )
    )
    .groupBy(model)
    .orderBy(desc(totalOf(spans.costUsdMicros)))
    .limit(15)

  return rows.map((row) => ({
    model: row.model,
    calls: row.calls,
    costMicros: Number(row.costMicros),
    inputTokens: Number(row.inputTokens),
    outputTokens: Number(row.outputTokens)
  }))
}

/** Per-agent activity, so the page can say which agent is costing the most. */
export async function readAgentStats(
  organizationId: string
): Promise<readonly { agentId: string; name: string; traces: number; costMicros: number }[]> {
  const db = getDb()
  const since = windowStart()

  const rows = await db
    .select({
      agentId: agents.id,
      name: agents.name,
      traces: sql<number>`${count(traces.id)}::int`,
      costMicros: totalOf(traces.costUsd)
    })
    .from(agents)
    // The window filter lives in the JOIN condition, not the WHERE clause.
    //
    // Putting `traces.start_time >= since` in the WHERE would silently turn this
    // LEFT JOIN into an inner one: an agent with no traces in the window
    // contributes a NULL `start_time`, `NULL >= since` is NULL rather than true,
    // and the row is dropped. The agent then vanishes from the table entirely
    // precisely when it has been quiet — which is the one time a reader most wants
    // to see it sitting there at zero.
    .leftJoin(
      traces,
      and(eq(traces.agentId, agents.id), gte(traces.startTime, since))
    )
    .where(eq(agents.organizationId, organizationId))
    .groupBy(agents.id, agents.name)
    .orderBy(desc(sql`count(${traces.id})`))

  return rows.map((row) => ({
    agentId: row.agentId,
    name: row.name,
    traces: row.traces,
    costMicros: Number(row.costMicros)
  }))
}

const DAY_MS = 86_400_000

function nowMs(): number {
  return Date.now()
}

function windowStart(): number {
  return nowMs() - ANALYTICS_WINDOW_DAYS * DAY_MS
}

/** UTC day key, matching the `to_char(..., 'YYYY-MM-DD')` in the query above. */
function dayKey(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10)
}