import { and, eq, sql } from "drizzle-orm"

import { verifyApiKey } from "@/server/auth/better-auth"
import { getDb } from "@/server/db/client"
import { runs, spans, traces, type SpanError, type SpanStatus } from "@/server/db/schema"

/**
 * Trace ingest.
 *
 * The other half of the harness's `TelemetrySink`. An agent running anywhere — a
 * sandbox, a laptop, a CI job — posts `{ trace, spans }` here and the dashboard
 * can show what it did. This is the same payload `nah-studio` accepts
 * (`IngestPayload` in its `src/wire.ts`), deliberately: the harness ships one
 * writer, and if the cloud spoke a different dialect it would need a second
 * emitter in the agent and every user would have to choose which to configure.
 *
 * Authenticated by API key, never by session. A machine reporting telemetry has
 * no session and cannot have one, and the tenancy comes from
 * `verifyApiKey` — which resolves the key to exactly one `organizationId` and
 * nothing else. That returned org id is the *only* thing written; an
 * `organizationId` in the request body would be ignored, because a body field is
 * user input and the whole point is that it is not trusted.
 */
export async function ingestTelemetry(request: Request): Promise<Response> {
  const key = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? null
  const verified = await verifyApiKey(key, "runner")
  if (!verified) {
    return json({ error: "Unauthorized" }, 401)
  }
  let payload: unknown
  try {
    payload = await request.json()
  } catch {
    return json({ error: "Body must be JSON." }, 400)
  }
  const parsed = parseIngest(payload)
  if (!parsed) {
    return json({ error: "Expected { trace, spans: [] }." }, 400)
  }
  try {
    await ingest(verified.organizationId, verified.keyId, parsed)
  } catch (error) {
    console.error("nah-cloud: trace ingest failed", error)
    return json({ error: "Could not store that trace." }, 500)
  }
  return json({ ok: true }, 202)
}

export const POST = ingestTelemetry

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  })
}

/** A trace plus its spans, after validation. */
interface Ingest {
  readonly trace: {
    readonly id: string
    readonly name: string
    readonly startTime: number
    readonly endTime: number | null
    readonly rootSpanId: string
    readonly status: string
    readonly tags: string[]
    readonly metadata: Record<string, unknown>
    readonly error: unknown
  }
  readonly spans: readonly {
    readonly id: string
    readonly parentId: string | null
    readonly name: string
    readonly kind: string
    readonly startTime: number
    readonly endTime: number | null
    readonly status: string
    readonly attributes: Record<string, unknown>
    readonly input: unknown
    readonly output: unknown
    readonly error: unknown
  }[]
  readonly runId: string | null
}

/**
 * Validate the body.
 *
 * Hand-written rather than a schema library, and the reason is what a bad payload
 * costs. This endpoint is on the path of an agent's telemetry, not its work: the
 * worst outcome of a malformed trace is a row nobody sees, and a wrong-but-
 * accepted trace — a status of "ok" on a failed run, a span with no parent — is
 * a dashboard that lies. So everything is narrowed, and anything that cannot be
 * narrowed returns `null` rather than a best guess.
 *
 * Unknown fields are kept, not dropped. The harness adds attributes
 * (`SpanAttributes` is deliberately open) and this store should not be the thing
 * that discards them.
 */
function parseIngest(body: unknown): Ingest | null {
  if (typeof body !== "object" || body === null) return null
  const input = body as Record<string, unknown>

  const rawTrace = input.trace
  if (typeof rawTrace !== "object" || rawTrace === null) return null
  const t = rawTrace as Record<string, unknown>

  if (typeof t.id !== "string" || t.id.length === 0) return null
  if (typeof t.name !== "string") return null
  if (typeof t.startTime !== "number" || !Number.isFinite(t.startTime)) return null
  if (typeof t.rootSpanId !== "string") return null

  if (!Array.isArray(input.spans)) return null
  const rawSpans: Record<string, unknown>[] = []
  for (const candidate of input.spans) {
    if (typeof candidate !== "object" || candidate === null) return null
    rawSpans.push(candidate as Record<string, unknown>)
  }

  const spansOut: Ingest["spans"][number][] = []
  for (const s of rawSpans) {
    if (typeof s.id !== "string" || s.id.length === 0) return null
    if (typeof s.name !== "string") return null
    if (typeof s.startTime !== "number" || !Number.isFinite(s.startTime)) return null
    spansOut.push({
      id: s.id,
      parentId: typeof s.parentId === "string" ? s.parentId : null,
      name: s.name,
      kind: typeof s.kind === "string" ? s.kind : "step",
      startTime: s.startTime,
      endTime: typeof s.endTime === "number" ? s.endTime : null,
      status: typeof s.status === "string" ? s.status : "unset",
      attributes: isRecord(s.attributes) ? s.attributes : {},
      input: s.input,
      output: s.output,
      error: s.error
    })
  }

  return {
    trace: {
      id: t.id,
      name: t.name,
      startTime: t.startTime,
      endTime: typeof t.endTime === "number" ? t.endTime : null,
      rootSpanId: t.rootSpanId,
      status: typeof t.status === "string" ? t.status : "unset",
      tags: Array.isArray(t.tags) ? t.tags.filter((tag): tag is string => typeof tag === "string") : [],
      metadata: isRecord(t.metadata) ? t.metadata : {},
      error: t.error
    },
    spans: spansOut,
    // Optional and untrusted: it is a convenience for the agent that knows which
    // run it is executing, not a tenancy claim. `ingest` checks it against the
    // same organization before it is written.
    runId: typeof input.runId === "string" ? input.runId : null
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** Statuses the store will accept. An unknown one becomes `unset`. */
function status(value: string): SpanStatus {
  return value === "ok" || value === "error" || value === "interrupted" ? value : "unset"
}

/** Errors are stored whole; anything that is not one becomes a message. */
function spanError(value: unknown): SpanError | null {
  if (!isRecord(value)) return null
  const name = typeof value.name === "string" ? value.name : "Error"
  const message = typeof value.message === "string" ? value.message : "Unknown error"
  return typeof value.stack === "string" ? { name, message, stack: value.stack } : { name, message }
}

/** USD to integer micros, so money never round-trips through a float column. */
function micros(usd: unknown): number | null {
  return typeof usd === "number" && Number.isFinite(usd) ? Math.round(usd * 1_000_000) : null
}

async function ingest(
  organizationId: string,
  keyId: string,
  payload: Ingest
): Promise<void> {
  const db = getDb()
  const { trace } = payload

  // A run link is only honoured when that run belongs to this tenant. Checking is
  // the whole point: an attacker with their own valid key could otherwise point
  // their trace at another org's run id and have it rendered inside it.
  let runId: string | null = null
  if (payload.runId) {
    const [owned] = await db
      .select({ id: runs.id })
      .from(runs)
      .where(and(eq(runs.id, payload.runId), eq(runs.organizationId, organizationId)))
      .limit(1)
    if (owned) runId = owned.id
  }

  const root = payload.spans.find((s) => s.id === trace.rootSpanId)
  const attributes = root?.attributes ?? {}

  // Upsert, not insert. A trace arrives at least twice — once while running, once
  // when it finishes — and a second insert would either duplicate the trace in
  // the list or fail on the primary key and lose the completed version, which is
  // the one with an end time and a real status.
  await db
    .insert(traces)
    .values({
      id: trace.id,
      organizationId,
      runId,
      name: trace.name,
      startTime: trace.startTime,
      endTime: trace.endTime,
      rootSpanId: trace.rootSpanId,
      status: status(trace.status),
      tags: trace.tags,
      metadata: trace.metadata,
      error: spanError(trace.error),
      costUsd: micros(attributes["nah.cost.usd"]),
      inputTokens: numberOrNull(attributes["gen_ai.usage.input_tokens"]),
      outputTokens: numberOrNull(attributes["gen_ai.usage.output_tokens"])
    })
    .onConflictDoUpdate({
      target: traces.id,
      set: {
        endTime: trace.endTime,
        status: status(trace.status),
        error: spanError(trace.error),
        costUsd: micros(attributes["nah.cost.usd"]),
        inputTokens: numberOrNull(attributes["gen_ai.usage.input_tokens"]),
        outputTokens: numberOrNull(attributes["gen_ai.usage.output_tokens"])
      }
    })

  // Spans are replace-not-merge: a re-sent trace carries every span again, and
  // upserting on the primary key means a span that was open (`endTime: null`) and
  // is now closed gets its end time rather than being duplicated.
  if (payload.spans.length > 0) {
    await db
      .insert(spans)
      .values(
        payload.spans.map((s) => ({
          id: `${trace.id}:${s.id}`,
          traceId: trace.id,
          organizationId,
          parentId: s.parentId,
          name: s.name,
          kind: s.kind as (typeof spans.$inferInsert)["kind"],
          startTime: s.startTime,
          endTime: s.endTime,
          status: status(s.status),
          attributes: s.attributes,
          input: s.input,
          output: s.output,
          error: spanError(s.error),
          metadata: {},
          costUsdMicros: micros(s.attributes["nah.cost.usd"])
        }))
      )
      .onConflictDoUpdate({
        target: spans.id,
        set: {
          endTime: sql`excluded.${spans.endTime}`,
          status: sql`excluded.${spans.status}`,
          attributes: sql`excluded.${spans.attributes}`,
          error: sql`excluded.${spans.error}`
        }
      })
  }

  // The run is not touched here. `runs` has no `updatedAt` — its lifecycle columns
  // are `startedAt` and `finishedAt`, and writing either from a telemetry POST
  // would mean a reporter could mark its own run as finished before it had. The
  // trace link is the only thing telemetry contributes to a run.
  //
  // `keyId` is accepted and unused today. It is named so the seam exists: when
  // per-key rate limiting or an audit table lands, the identifier is already here
  // rather than being reconstructed from a header later.
  void keyId
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null
}