import { eq } from "drizzle-orm"

import { getDb } from "@/server/db/client"
import { runs, sandboxes, type AgentConfig, type Run } from "@/server/db/schema"
import { getValidInstallationToken } from "@/server/github/installation-tokens"
import { requireSandboxProvider, SandboxNotFoundError } from "@/server/sandbox/provider"
import { stopSandbox } from "@/server/sandbox/lifecycle"

import { appendRunEvent, appendRunEvents, type RunEventKind } from "./events"
import { isTerminal, settleRun } from "./launcher"
import { resolveRunTimeoutMs } from "./policy"

/**
 * Executing a run on the sandbox, and turning the agent's NDJSON back into the
 * event log.
 *
 * One design rule governs this file: the *agent process* is the only writer of
 * transcript content, and this module is a faithful reader of it. Nothing here
 * invents assistant text or guesses statuses — `nah --mode json` emits a typed
 * stream, each line is mapped to a `run_events` row, and the run's terminal
 * status comes from the process's exit code. Where the reader has a choice
 * between clever and boring it picks boring, because a transcript that
 * misquotes what the agent did is worse than one with a gap in it.
 *
 * Durability comes from two mechanisms, deliberately both:
 *
 * 1. An in-process poll loop that follows a run it started. Zero extra
 *    infrastructure; good enough while the process lives.
 * 2. Reconcile-on-read: the run page ticks the same `tick()` on render, so a
 *    restart, a deploy, or a crashed loop is healed by someone looking at the
 *    page rather than by an admin noticing a stuck row.
 *
 * `stdoutOffset` on the run row is what makes (2) safe to combine with (1): the
 * offset only advances past *complete* NDJSON lines that have been appended to
 * the log, so two readers never fork the transcript — the second one resumes
 * exactly where the first stopped.
 */

/** One tick's worth of parsed transcript output. */
interface PendingEvents {
  readonly events: { kind: RunEventKind; payload: unknown }[]
  pendingText: string
  usage: { inputTokens: number; outputTokens: number } | null
}

const newPending = (): PendingEvents => ({ events: [], pendingText: "", usage: null })

const flushText = (pending: PendingEvents): void => {
  if (pending.pendingText) {
    pending.events.push({ kind: "text", payload: { text: pending.pendingText } })
    pending.pendingText = ""
  }
}

const errorText = (value: unknown): string => {
  if (value instanceof Error) return value.message
  if (typeof value === "string") return value
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>
    if (typeof record.message === "string") return record.message
  }
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

/** Map one harness NDJSON line onto run events. Returns false for unknown lines. */
const consumeLine = (line: string, pending: PendingEvents): boolean => {
  let event: unknown
  try {
    event = JSON.parse(line)
  } catch {
    return false
  }
  if (typeof event !== "object" || event === null) return false
  const e = event as Record<string, unknown>

  switch (e.type) {
    case "text-delta":
      if (typeof e.text === "string") pending.pendingText += e.text
      return true
    case "tool-call":
      flushText(pending)
      pending.events.push({
        kind: "tool_call",
        payload: {
          tool: typeof e.toolName === "string" ? e.toolName : "tool",
          toolCallId: e.toolCallId,
          input: e.input
        }
      })
      return true
    case "tool-result":
      flushText(pending)
      pending.events.push({
        kind: "tool_result",
        payload: {
          tool: typeof e.toolName === "string" ? e.toolName : "tool",
          // The harness already caps tool output before emitting this; the
          // extra clamp is for the transcript's own sanity, not the agent's.
          output: typeof e.output === "string" ? e.output.slice(0, 4000) : String(e.output ?? ""),
          isError: e.isError === true
        }
      })
      return true
    case "finish":
      flushText(pending)
      if (
        typeof e.usage === "object" &&
        e.usage !== null &&
        typeof (e.usage as Record<string, unknown>).inputTokens === "number"
      ) {
        const u = e.usage as { inputTokens: number; outputTokens: number }
        pending.usage = { inputTokens: u.inputTokens, outputTokens: u.outputTokens }
      }
      return true
    case "error":
      flushText(pending)
      pending.events.push({ kind: "error", payload: { text: errorText(e.error) } })
      return true
    default:
      // run-start, step-start, step-finish, wrap-up, approvals: lifecycle noise
      // the transcript either does not need or already covers through pairing
      // events. Explicitly ignored rather than unknown.
      return true
  }
}

/**
 * Build the script the sandbox runs.
 *
 * Every dynamic value — prompt, tokens, env — enters the script as base64 and
 * is decoded inside it. That is not obfuscation (the VM is legitimately trusted
 * with these values) but quoting hygiene: a prompt containing `'`, `$(...)` or a
 * newline must not be able to change which shell command runs. There is no
 * interpolation context where that can happen with base64.
 */
export interface RunnerScriptInput {
  readonly runId: string
  readonly agentName: string
  /** `owner/repo`, or empty for no clone. */
  readonly repository: string
  /** GitHub installation token for the clone, or null when not connected. */
  readonly cloneToken: string | null
  readonly prompt: string
  readonly env: Readonly<Record<string, string>>
  /** `provider:model`, or null to let the agent resolve its default. */
  readonly model: string | null
  /** The cloud base URL — where studio.json points telemetry at. */
  readonly cloudUrl: string
  /** The per-run API key. Lives in studio.json on the VM, never in argv. */
  readonly runnerKey: string
}

const b64 = (value: string): string => Buffer.from(value, "utf8").toString("base64")

/** `https://github.com/owner/repo.git` → `owner/repo`; anything else passes through trimmed. */
export const normalizeRepository = (repository: string): string => {
  const trimmed = repository.trim().replace(/\.git$/, "")
  const match = trimmed.match(/^(?:https?:\/\/[^/]+\/|git@[^:]+:)(.+)$/)
  const path = match ? match[1]! : trimmed
  return path.replace(/^\/+|\/+$/g, "")
}

export const buildRunnerScript = (input: RunnerScriptInput): string => {
  const envLines: string[] = []
  for (const [key, value] of Object.entries(input.env)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(key)) continue
    envLines.push(`export ${key}="$(b64d '${b64(value)}')"`)
  }

  const modelArg = input.model ? ` -m "$(b64d '${b64(input.model)}')"` : ""
  const cloneBlock = input.repository
    ? `
WORK="/home/user/work/${input.runId}"
mkdir -p "$WORK"
${
  input.cloneToken
    ? `printf '%s' "$(b64d '${b64(input.cloneToken)}')" > /home/user/.gh-token
if git clone --depth 50 "https://x-access-token:$(cat /home/user/.gh-token)@github.com/${input.repository}.git" "$WORK" 1>&2; then
  echo "nah-cloud: cloned ${input.repository}" 1>&2
else
  echo "nah-cloud: clone failed; continuing in an empty workspace" 1>&2
fi
rm -f /home/user/.gh-token`
    : `echo "nah-cloud: no repository clone; continuing in an empty workspace" 1>&2`
}
`
    : `
WORK="/home/user/work/${input.runId}"
mkdir -p "$WORK"
`

  return `#!/usr/bin/env bash
# Generated by nah-cloud for run ${input.runId}. Recreated per run; do not edit.
set -u

b64d() { printf '%s' "$1" | base64 -d; }

PROMPT="$(b64d '${b64(input.prompt)}')"
AGENT_NAME="$(b64d '${b64(input.agentName)}')"
CLOUD_URL="$(b64d '${b64(input.cloudUrl)}')"
RUNNER_KEY="$(b64d '${b64(input.runnerKey)}')"
${envLines.join("\n")}

cleanup() {
  rm -f /home/user/.nah-run.sh /home/user/.gh-token 2>/dev/null || true
}
trap cleanup EXIT

# studio.json is what the harness's telemetry sink reads to find the cloud and
# authenticate to it. pid must be a live process in this VM, and it is: the
# exec below keeps this same shell's pid.
mkdir -p /home/user/.nah
printf '{"url":"%s","token":"%s","pid":%s,"startedAt":%s}' \\
  "$CLOUD_URL" "$RUNNER_KEY" "$$" "$(date +%s%3N)" \\
  > /home/user/.nah/studio.json
${cloneBlock}
# --prefix install: the sandbox user does not own npm's global directory, and
# a failed install is the single most common way a run would die before the
# agent ever started. Binary lands in ~/.local/bin.
npm i -g --prefix /home/user/.local nah-ai@latest 1>&2
export PATH="/home/user/.local/bin:$PATH"
export NAH_AGENT_NAME="$AGENT_NAME"

cd "$WORK"
exec nah --no-tui --no-session --mode json -y --cwd "$WORK"${modelArg} -- "$PROMPT"
`
}

type AgentRow = typeof import("@/server/db/schema").agents.$inferSelect

const cloudUrl = (): string =>
  (process.env.NAH_CLOUD_URL?.trim() ||
    process.env.BETTER_AUTH_URL?.trim() ||
    "http://localhost:3000").replace(/\/+$/, "")

/**
 * Prepare the sandbox and start the agent process.
 *
 * Called by `launchRun` with the run already `running`. Any throw here is
 * caught by the launcher, which settles the run — so this function's contract
 * is "the run has not started yet, and I may fail loudly".
 */
export const startRunExecution = async (run: Run, agent: AgentRow): Promise<void> => {
  const provider = requireSandboxProvider()
  if (!run.sandboxId) throw new Error(`Run ${run.id} has no sandbox to execute on.`)

  const config = (agent.config ?? {}) as AgentConfig

  // The installation token is short-lived (about an hour). A run that outlives
  // it can still work — only the clone needs the token, and the clone happens
  // in the first seconds — so a missing connection degrades to an empty
  // workspace rather than a failed run.
  const clone = await getValidInstallationToken(run.organizationId).catch(() => null)

  const script = buildRunnerScript({
    runId: run.id,
    agentName: agent.name,
    repository: normalizeRepository(agent.repository),
    cloneToken: clone?.token ?? null,
    prompt: withInstructions(agent.instructions, run.prompt),
    env: config.env ?? {},
    model: config.model ?? null,
    cloudUrl: cloudUrl(),
    runnerKey: (await loadRunnerKey(run)) ?? ""
  })

  if (script.includes('RUNNER_KEY=""')) {
    // A run without a key cannot report telemetry or resolve its traces. The
    // agent would still run, but the run would be unaccountable — fail instead.
    throw new Error(`Run ${run.id} has no runner key; telemetry and trace linking would be blind.`)
  }

  // Secrets go in a file written over the provider's file API, never in the
  // command string: a command is echoed back in status responses and logs.
  await provider.putFile(run.sandboxId, "/home/user/.nah-run.sh", script)

  // The sandbox may have just been resumed and still be waking up — the
  // provider answers 409 `boat_starting` for exactly that window, and it is
  // provably safe to retry because the command never ran.
  let processId: number | null = null
  let lastError: unknown = null
  for (let attempt = 0; attempt < 4 && processId === null; attempt += 1) {
    if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 2_000 * attempt))
    try {
      const started = await provider.startCommand(run.sandboxId, {
        command: "bash /home/user/.nah-run.sh",
        cwd: "/home/user"
      })
      processId = started.processId
    } catch (error) {
      lastError = error
      // Anything that is not provably "not started yet" is final: resending a
      // command that may have run would execute the agent twice.
      const retryable =
        typeof error === "object" &&
        error !== null &&
        (error as { retryable?: unknown }).retryable === true &&
        (error as { status?: unknown }).status === 409
      if (!retryable) throw error
    }
  }
  if (processId === null) {
    throw lastError instanceof Error ? lastError : new Error("Could not start the agent process.")
  }

  const db = getDb()
  await db.update(runs).set({ commandId: processId }).where(eq(runs.id, run.id))

  await appendRunEvent({ runId: run.id, kind: "prompt", payload: { text: run.prompt } })

  ensureRunPolling(run.id)
}

const withInstructions = (instructions: string | null | undefined, prompt: string): string => {
  const trimmed = instructions?.trim()
  return trimmed ? `${trimmed}\n\n${prompt}` : prompt
}

/**
 * Read the per-run key back for the script.
 *
 * Better Auth returns the plaintext exactly once, at creation — the launcher
 * mints it and stores only the row id. This second read is a database lookup of
 * that id's *hash-free* representation... which does not exist: verification
 * hashes are one-way. So the key itself is passed through the launch sequence
 * instead of re-derived here — see `launchRun`, which writes it onto the run
 * row's in-memory copy. This stub exists so the seam is one function.
 */
let runnerKeyOverride: { runId: string; key: string } | null = null

/** Called by the launcher right after minting, before `startRunExecution`. */
export const setRunnerKeyForRun = (runId: string, key: string): void => {
  runnerKeyOverride = { runId, key }
}

const loadRunnerKey = async (run: Run): Promise<string | null> => {
  if (runnerKeyOverride?.runId === run.id) return runnerKeyOverride.key
  return null
}

/** Runs with an active poll loop in this process. */
const looping = new Set<string>()
/** A tick in flight for a run — the guard against two readers forking the log. */
const ticking = new Set<string>()

const POLL_INTERVAL_MS = 4_000
const BACKOFF_MAX_MS = 30_000
/** After this long of continuous provider failure, stop and let read-reconcile take over. */
const GIVE_UP_AFTER_MS = 5 * 60_000

/** Start following a run in the background, if this process is not already. */
export const ensureRunPolling = (runId: string): void => {
  if (looping.has(runId)) return
  looping.add(runId)

  void (async () => {
    let failures = 0
    let firstFailureAt = 0
    try {
      for (;;) {
        let done = false
        try {
          done = await tick(runId)
          failures = 0
        } catch (error) {
          if (error instanceof SandboxNotFoundError) {
            // The machine is provably gone. Settle so the run does not spin,
            // then stop — nothing left to poll.
            await settleRun(runId, "failed", {
              error: "The sandbox disappeared while the run was in flight."
            }).catch(() => null)
            done = true
          } else {
            failures += 1
            const now = Date.now()
            if (failures === 1) firstFailureAt = now
            if (now - firstFailureAt > GIVE_UP_AFTER_MS) {
              // Not a terminal state for the run: reconcile-on-read will tick it
              // again when someone opens the page, and the run may well still
              // be healthy — only this loop's luck has run out.
              console.error(`nah-cloud: giving up polling run ${runId}`, error)
              done = true
            }
          }
        }
        if (done) break
        const delay =
          failures > 0
            ? Math.min(BACKOFF_MAX_MS, POLL_INTERVAL_MS * 2 ** Math.min(failures, 4))
            : POLL_INTERVAL_MS
        await new Promise((resolve) => setTimeout(resolve, delay))
      }
    } finally {
      looping.delete(runId)
    }
  })()
}

/**
 * One reconcile pass. Safe to call from anywhere; `false` means "still going".
 *
 * This is the single implementation behind the poll loop *and* the run page's
 * reconcile-on-read — one reader, so there is exactly one place where stdout is
 * parsed, offsets advance, and runs settle.
 */
export const tick = async (runId: string): Promise<boolean> => {
  if (ticking.has(runId)) return false
  ticking.add(runId)
  try {
    return await tickInner(runId)
  } finally {
    ticking.delete(runId)
  }
}

const tickInner = async (runId: string): Promise<boolean> => {
  const db = getDb()
  const provider = requireSandboxProvider()

  const [run] = await db.select().from(runs).where(eq(runs.id, runId)).limit(1)
  if (!run || isTerminal(run.status)) return true
  if (!run.sandboxId || run.commandId === null) return false // not started yet

  const [agent] = await db
    .select()
    .from((await import("@/server/db/schema")).agents)
    .where(eq((await import("@/server/db/schema")).agents.id, run.agentId))
    .limit(1)
  const config = (agent?.config ?? {}) as AgentConfig

  const storedOffset = run.stdoutOffset ?? 0
  const status = await provider.commandStatus(run.sandboxId, run.commandId, {
    stdoutOffset: storedOffset
  })

  const pending = newPending()
  let nextOffset = storedOffset

  if (status.stdout) {
    let buffer = Buffer.from(status.stdout, "utf8")
    // Boat's `stdoutOffset` is where this chunk starts. A value below what we
    // asked for means the stream restarted (log replaced) — drop the prefix we
    // have already consumed rather than replaying it into the transcript. A
    // value above means bytes were skipped; resume from what arrived.
    const chunkStart = Math.max(status.stdoutOffset, storedOffset)
    if (chunkStart > status.stdoutOffset) {
      buffer = buffer.subarray(chunkStart - status.stdoutOffset)
    }

    const lastNewline = buffer.lastIndexOf(0x0a)
    const complete = lastNewline >= 0 ? buffer.subarray(0, lastNewline + 1) : Buffer.alloc(0)
    if (complete.length > 0) {
      for (const line of complete.toString("utf8").split("\n")) {
        if (line.trim()) consumeLine(line, pending)
      }
      nextOffset = chunkStart + complete.length
    }

    // On exit there is no future read to pick up a torn final line — the
    // writer is gone. Parse whatever remains as a last-ditch line.
    if (status.status !== "running") {
      const remainder = buffer.subarray(complete.length).toString("utf8").trim()
      if (remainder) consumeLine(remainder, pending)
    }
  }

  if (pending.events.length > 0 || pending.pendingText) {
    flushText(pending)
    if (pending.events.length > 0) {
      await appendRunEvents(runId, pending.events)
    }
  }
  if (nextOffset !== storedOffset) {
    await db.update(runs).set({ stdoutOffset: nextOffset }).where(eq(runs.id, runId))
  }

  if (pending.usage) {
    // Tokens are persisted the moment they are known, not at settle: a run that
    // finishes streaming and then hangs for minutes still shows its usage, and
    // settle reads them back rather than needing them passed in.
    await db
      .update(runs)
      .set({ tokensIn: pending.usage.inputTokens, tokensOut: pending.usage.outputTokens })
      .where(eq(runs.id, runId))
  }

  if (status.status === "running") {
    const timeoutMs = resolveRunTimeoutMs(config)
    const deadline = (run.startedAt?.getTime() ?? Date.now()) + timeoutMs
    if (Date.now() > deadline) {
      const message = `Run timed out after ${Math.round(timeoutMs / 1000)}s.`
      await appendRunEvent({ runId, kind: "error", payload: { text: message } })
      await settleRun(runId, "failed", { error: message }).catch(() => null)
      await stopRunSandbox(run.sandboxId)
      return true
    }
    return false
  }

  // exited or lost: the process's own exit is the verdict.
  const exitCode = status.status === "exited" ? status.exitCode : null
  const lost = status.status === "lost"
  const failed = lost || exitCode !== 0

  let errorMessage: string | null = null
  if (failed) {
    const stderr = status.stderr?.trim()
    errorMessage = lost
      ? "The agent process was lost on the sandbox."
      : `The agent exited with code ${exitCode ?? "?"}.`
    if (stderr) errorMessage += `\n${stderr.slice(-2000)}`
    await appendRunEvent({ runId, kind: "error", payload: { text: errorMessage } })
  }

  const [fresh] = await db
    .select({ tokensIn: runs.tokensIn, tokensOut: runs.tokensOut })
    .from(runs)
    .where(eq(runs.id, runId))
    .limit(1)

  await settleRun(runId, failed ? "failed" : "succeeded", {
    exitCode: exitCode ?? (lost ? -1 : null),
    error: errorMessage,
    tokensIn: pending.usage?.inputTokens ?? fresh?.tokensIn ?? null,
    tokensOut: pending.usage?.outputTokens ?? fresh?.tokensOut ?? null
  }).catch(() => null)

  // Stop after settling, not before: the verdict is durable first, and a stop
  // that throws must not leave the run un-settled. Stop (not destroy) keeps the
  // disk and the warmed npm/git state for the agent's next run.
  await stopRunSandbox(run.sandboxId)
  return true
}

const stopRunSandbox = async (boatSandboxId: string): Promise<void> => {
  try {
    const db = getDb()
    const [sandbox] = await db
      .select({ id: sandboxes.id })
      .from(sandboxes)
      .where(eq(sandboxes.boatSandboxId, boatSandboxId))
      .limit(1)
    if (sandbox) await stopSandbox(sandbox.id)
  } catch {
    // Best effort: the run is already terminal, and a stop that failed will be
    // retried by reconcile or reclaimed by the provider's own TTL.
  }
}

/**
 * Reconcile a run when its page is read.
 *
 * The heal for every "the poll loop died" case: a deploy, a crash, a loop that
 * backed off and gave up. Called from the run page before it renders, so what
 * the user sees includes everything the agent has produced so far — and the
 * background loop restarts so the transcript keeps moving without a reload.
 */
export const reconcileRun = async (runId: string): Promise<void> => {
  try {
    await tick(runId)
  } catch {
    // A provider hiccup during a page read is not a page failure; the render
    // shows what is already in the log and the background loop retries.
  }
  ensureRunPolling(runId)
}
