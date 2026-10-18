import { randomUUID } from "node:crypto"

/**
 * Boat's control API, in one place.
 *
 * Every HTTP detail of the vendor lives here and nowhere else — the bearer
 * token, the error envelope, the idempotency header, the confirm-delete header.
 * `provider.ts` wraps this in the provider-neutral interface the control plane
 * speaks, so a vendor swap replaces that pairing rather than touching anything
 * above it.
 *
 * Two rules the OpenAPI contract (docs.boat.dev) states explicitly and this
 * module must not paper over:
 *
 * 1. Command execution is never retried automatically. A 502
 *    `boat_direct_failed` means the command may already have run on the
 *    sandbox; resending it would run it twice. `BoatApiError.retryable` carries
 *    only the server's own hint ("provably never ran"), and each call site
 *    decides whether that hint applies to its operation.
 * 2. `Idempotency-Key` is what makes a create safe to retry after a lost
 *    response — the same account, key and body return the same sandbox for
 *    24 hours instead of minting a second billable machine.
 */

/** Boat's stable error envelope, flattened. `code` is the machine-readable half. */
export class BoatApiError extends Error {
  readonly status: number
  readonly code: string
  /** True only when the server says the request provably never took effect. */
  readonly retryable: boolean
  readonly details: Record<string, unknown> | null

  constructor(
    status: number,
    code: string,
    message: string,
    retryable = false,
    details: Record<string, unknown> | null = null
  ) {
    super(message)
    this.name = "BoatApiError"
    this.status = status
    this.code = code
    this.retryable = retryable
    this.details = details
  }
}

const baseUrl = (): string =>
  process.env.BOAT_BASE_URL?.trim() || "https://boat.dev/api/v1"

interface RequestOptions {
  readonly method?: "GET" | "POST" | "PUT" | "DELETE"
  readonly body?: unknown
  readonly headers?: Readonly<Record<string, string>>
  readonly timeoutMs: number
  readonly idempotencyKey?: string
}

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null

const request = async (path: string, options: RequestOptions): Promise<unknown> => {
  const token = process.env.BOAT_API_TOKEN?.trim()
  if (!token) {
    throw new BoatApiError(401, "missing_token", "Boat is not configured: set BOAT_API_TOKEN.", false)
  }

  const headers: Record<string, string> = {
    authorization: `Bearer ${token}`,
    accept: "application/json",
    ...(options.headers ?? {})
  }
  if (options.idempotencyKey) headers["idempotency-key"] = options.idempotencyKey

  let body: string | undefined
  if (options.body !== undefined) {
    headers["content-type"] = "application/json"
    body = JSON.stringify(options.body)
  }

  let response: Response
  try {
    response = await fetch(`${baseUrl()}${path}`, {
      method: options.method ?? "GET",
      headers,
      body,
      signal: AbortSignal.timeout(options.timeoutMs)
    })
  } catch (error) {
    // Status 0: the request may or may not have reached Boat. Safe to retry
    // only where an idempotency key or a read makes it so — the call site's call.
    const message = error instanceof Error ? error.message : String(error)
    throw new BoatApiError(0, "network", `Boat did not answer: ${message}`, true)
  }

  const text = await response.text().catch(() => "")
  let payload: unknown = null
  if (text) {
    try {
      payload = JSON.parse(text)
    } catch {
      payload = null
    }
  }

  if (!response.ok) {
    const envelope = asRecord(payload)
    const errorObject = envelope ? asRecord(envelope.error) : null
    const rawCode = envelope?.code ?? errorObject?.code
    const code = typeof rawCode === "string" && rawCode ? rawCode : `http_${response.status}`
    const rawMessage = envelope?.message ?? errorObject?.message
    const message =
      typeof rawMessage === "string" && rawMessage
        ? rawMessage
        : `Boat returned ${response.status} for ${options.method ?? "GET"} ${path}.`
    const details = errorObject ? asRecord(errorObject.details) : null
    const retryable =
      response.status === 409 && (code === "boat_starting" || code === "idempotency_in_progress")
    throw new BoatApiError(response.status, code, message, retryable, details)
  }

  return payload
}

/** The sandbox object, which both create and get nest under `sandbox`. */
export interface BoatSandbox {
  readonly id: string
  readonly state: string
  readonly error: string | null
  readonly ttlSeconds: number | null
}

const toSandbox = (payload: unknown): BoatSandbox => {
  const envelope = asRecord(payload)
  const record = (envelope ? asRecord(envelope.sandbox) : null) ?? envelope
  const id = record?.id
  if (typeof id !== "string" || !id) {
    throw new BoatApiError(502, "bad_response", "Boat answered without a sandbox id.", false)
  }
  return {
    id,
    state: typeof record.state === "string" ? record.state : "unknown",
    error: typeof record.error === "string" ? record.error : null,
    ttlSeconds: typeof record.ttlSeconds === "number" ? record.ttlSeconds : null
  }
}

export type BoatMachineType = "small" | "default" | "large" | "xlarge"

export interface CreateSandboxInput {
  readonly type: BoatMachineType
  readonly ttlSeconds: number
  readonly env: Readonly<Record<string, string>>
}

export const createSandbox = async (input: CreateSandboxInput): Promise<BoatSandbox> => {
  const hasEnv = Object.keys(input.env).length > 0
  const payload = await request("/sandboxes", {
    method: "POST",
    // Fresh key per attempt: the body is deterministic, so a retry after a lost
    // response binds to the first sandbox instead of creating a second one.
    idempotencyKey: randomUUID(),
    // failFast makes a create answer in ~1.5s with 202 or 503 rather than
    // queueing for a machine — which turns "no capacity" into an actionable
    // message now instead of a run that stalls for minutes.
    timeoutMs: 45_000,
    body: {
      type: input.type,
      ttlSeconds: input.ttlSeconds,
      noEnv: true,
      failFast: true,
      ...(hasEnv ? { env: input.env } : {})
    }
  })
  return toSandbox(payload)
}

export const getSandbox = async (sandboxId: string): Promise<BoatSandbox> => {
  const payload = await request(`/sandboxes/${sandboxId}`, { timeoutMs: 15_000 })
  return toSandbox(payload)
}

/** 202: the stop runs asynchronously. The dashboard does not wait for archival. */
export const stopSandbox = async (sandboxId: string): Promise<void> => {
  await request(`/sandboxes/${sandboxId}/stop`, { method: "POST", timeoutMs: 20_000 })
}

/** 202. Omitting `ttlSeconds` keeps the TTL the sandbox already had. */
export const resumeSandbox = async (
  sandboxId: string,
  options: { readonly ttlSeconds?: number } = {}
): Promise<void> => {
  await request(`/sandboxes/${sandboxId}/resume`, {
    method: "POST",
    timeoutMs: 60_000,
    ...(options.ttlSeconds !== undefined ? { body: { ttlSeconds: options.ttlSeconds } } : {})
  })
}

/**
 * Delete — the only call that frees the disk.
 *
 * Refused without the confirm header, and answered 404 for a sandbox that is
 * already gone. Deletion is idempotent by design: the caller's own row state is
 * what matters, and "already deleted" is success.
 */
export const deleteSandbox = async (sandboxId: string): Promise<void> => {
  try {
    await request(`/sandboxes/${sandboxId}`, {
      method: "DELETE",
      headers: { "x-ascii-confirm-delete": sandboxId },
      timeoutMs: 30_000
    })
  } catch (error) {
    if (error instanceof BoatApiError && error.status === 404) return
    throw error
  }
}

export interface RunCommandInput {
  readonly command: string
  readonly cwd?: string
  /** Seconds, clamped to Boat's 1–600 window by the caller. */
  readonly timeoutSeconds: number
}

export interface BoatCommandResult {
  readonly exitCode: number | null
  readonly stdout: string
  readonly stderr: string
  readonly timedOut: boolean
  readonly oomKilled: boolean
}

/** Synchronous execution. One request that Boat holds open until the exit. */
export const runCommand = async (
  sandboxId: string,
  input: RunCommandInput
): Promise<BoatCommandResult> => {
  const payload = await request(`/sandboxes/${sandboxId}/commands`, {
    method: "POST",
    // The command itself is capped at timeoutSeconds; the extra 20s is for the
    // round trip and Boat's own bookkeeping, not more waiting on the process.
    timeoutMs: (input.timeoutSeconds + 20) * 1000,
    body: {
      command: input.command,
      ...(input.cwd ? { cwd: input.cwd } : {}),
      timeoutSeconds: input.timeoutSeconds
    }
  })
  const record = asRecord(payload) ?? {}
  const exitCode = typeof record.exitCode === "number" ? record.exitCode : null
  return {
    exitCode,
    stdout: typeof record.stdout === "string" ? record.stdout : "",
    stderr: typeof record.stderr === "string" ? record.stderr : "",
    timedOut: record.timedOut === true,
    oomKilled: record.oomKilled === true
  }
}

export interface StartCommandInput {
  readonly command: string
  readonly cwd?: string
}

export interface BoatCommandStarted {
  readonly processId: number
  readonly commandId: string | null
}

/** Detached: one request that returns a process id immediately, no timeout cap. */
export const startCommand = async (
  sandboxId: string,
  input: StartCommandInput
): Promise<BoatCommandStarted> => {
  const payload = await request(`/sandboxes/${sandboxId}/commands`, {
    method: "POST",
    timeoutMs: 30_000,
    body: {
      command: input.command,
      ...(input.cwd ? { cwd: input.cwd } : {}),
      detached: true
    }
  })
  const record = asRecord(payload) ?? {}
  const processId = record.processId
  if (typeof processId !== "number") {
    throw new BoatApiError(502, "bad_response", "Boat started a command without a process id.", false)
  }
  return {
    processId,
    commandId: typeof record.commandId === "string" ? record.commandId : null
  }
}

export interface CommandStatusOptions {
  /** Ask for output written since this byte offset — Boat does the tailing. */
  readonly stdoutOffset?: number
  readonly stderrOffset?: number
  /** Cap per-log tail size when no offsets are given. Boat caps at 8 MiB. */
  readonly tailBytes?: number
}

export interface BoatCommandStatus {
  readonly status: "running" | "exited" | "lost"
  readonly exitCode: number | null
  readonly oomKilled: boolean
  readonly stdout: string
  readonly stderr: string
  /** Where the returned stdout chunk starts; 0 means the log was replaced. */
  readonly stdoutOffset: number
  readonly stdoutNextOffset: number
  readonly stderrNextOffset: number
  /** More output is already written — read again without waiting. */
  readonly more: boolean
}

export const getCommandStatus = async (
  sandboxId: string,
  processId: number,
  options: CommandStatusOptions = {}
): Promise<BoatCommandStatus> => {
  const query = new URLSearchParams()
  if (options.stdoutOffset !== undefined) query.set("stdoutOffset", String(options.stdoutOffset))
  if (options.stderrOffset !== undefined) query.set("stderrOffset", String(options.stderrOffset))
  if (options.tailBytes !== undefined) query.set("tailBytes", String(options.tailBytes))
  const qs = query.toString()

  const payload = await request(
    `/sandboxes/${sandboxId}/commands/${processId}${qs ? `?${qs}` : ""}`,
    { timeoutMs: 15_000 }
  )
  const record = asRecord(payload) ?? {}
  const rawStatus = record.status
  const status =
    rawStatus === "running" || rawStatus === "exited" || rawStatus === "lost"
      ? rawStatus
      : "lost"

  return {
    status,
    exitCode: typeof record.exitCode === "number" ? record.exitCode : null,
    oomKilled: record.oomKilled === true,
    stdout: typeof record.stdout === "string" ? record.stdout : "",
    stderr: typeof record.stderr === "string" ? record.stderr : "",
    stdoutOffset: typeof record.stdoutOffset === "number" ? record.stdoutOffset : 0,
    stdoutNextOffset:
      typeof record.stdoutNextOffset === "number"
        ? record.stdoutNextOffset
        : typeof record.stdoutOffset === "number"
          ? record.stdoutOffset
          : 0,
    stderrNextOffset:
      typeof record.stderrNextOffset === "number"
        ? record.stderrNextOffset
        : typeof record.stderrOffset === "number"
          ? record.stderrOffset
          : 0,
    more: record.more === true
  }
}

/**
 * Write a file on the sandbox.
 *
 * Boat path-jails this to /home/user and /tmp and rejects `..`; the guard here
 * fails earlier and locally so a path bug surfaces as our own error rather than
 * a 400 from a vendor. 5 MiB is Boat's cap for this endpoint.
 */
export const writeFile = async (
  sandboxId: string,
  path: string,
  content: string
): Promise<void> => {
  const underHome = path === "/home/user" || path.startsWith("/home/user/")
  const underTmp = path === "/tmp" || path.startsWith("/tmp/")
  if ((!underHome && !underTmp) || path.split("/").includes("..")) {
    throw new Error(`Refusing to write ${path}: Boat only accepts paths under /home/user or /tmp.`)
  }
  if (Buffer.byteLength(content, "utf8") > 5 * 1024 * 1024) {
    throw new Error(`Refusing to write ${path}: exceeds Boat's 5 MiB single-file limit.`)
  }
  await request(`/sandboxes/${sandboxId}/files`, {
    method: "PUT",
    timeoutMs: 30_000,
    body: { path, content, encoding: "utf8" }
  })
}
