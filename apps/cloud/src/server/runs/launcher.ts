import { and, eq, inArray } from "drizzle-orm"

import { meterRun } from "@/server/billing/meter"
import { getAuth } from "@/server/auth/better-auth"
import { headers } from "next/headers"
import { getDb } from "@/server/db/client"
import { agents, runs, sandboxes, type AgentConfig, type Run } from "@/server/db/schema"
import type { RunStatus } from "@/server/domain/errors"
import { acquireSandbox, stopSandbox } from "@/server/sandbox/lifecycle"
import { requireSandboxProvider } from "@/server/sandbox/provider"

import { appendRunEvent } from "./events"
import { setRunnerKeyForRun, startRunExecution } from "./runner"

const TERMINAL: readonly RunStatus[] = ["succeeded", "failed", "cancelled"]

export const isTerminal = (status: RunStatus): boolean => TERMINAL.includes(status)

export interface LaunchRunInput {
  readonly organizationId: string
  readonly agentId: string
  readonly prompt: string
}

export class LaunchRunError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = "LaunchRunError"
    this.code = code
  }
}

export const launchRun = async (input: LaunchRunInput): Promise<Run> => {
  const db = getDb()

  const [agent] = await db
    .select()
    .from(agents)
    .where(and(eq(agents.id, input.agentId), eq(agents.organizationId, input.organizationId)))

  if (!agent) {
    throw new LaunchRunError("AGENT_NOT_FOUND", "That agent does not exist in this organisation.")
  }

  const [created] = await db
    .insert(runs)
    .values({
      agentId: input.agentId,
      organizationId: input.organizationId,
      prompt: input.prompt,
      status: "queued"
    })
    .returning()

  if (!created) throw new LaunchRunError("RUN_NOT_CREATED", "Could not create the run.")

  await appendRunEvent({ runId: created.id, kind: "run.queued", payload: { prompt: input.prompt } })

  try {
    const config: AgentConfig = (agent.config ?? {}) as AgentConfig
    const sandbox = await acquireSandbox(input.organizationId, input.agentId, config)

    await appendRunEvent({
      runId: created.id,
      kind: "sandbox.ready",
      payload: { sandboxId: sandbox.id, runtimeUrl: sandbox.runtimeUrl }
    })

    const [started] = await db
      .update(runs)
      .set({ status: "running", sandboxId: sandbox.boatSandboxId, startedAt: new Date() })
      .where(and(eq(runs.id, created.id), eq(runs.status, "queued")))
      .returning()

    if (!started) {
      await stopSandbox(sandbox.id)
      throw new LaunchRunError("RUN_CANCELLED", "The run was cancelled before it started.")
    }

    await appendRunEvent({ runId: created.id, kind: "run.started", payload: { sandboxId: sandbox.id } })

    let runnerKey: string | null = null
    try {
      const keyResult = await getAuth().api.createApiKey({
        body: { configId: "runner", name: `run-${created.id}`, organizationId: input.organizationId },
        headers: await headers()
      })
      runnerKey = keyResult.key ?? null
      const keyId = (keyResult as { id?: string | null }).id ?? null
      if (runnerKey) {
        setRunnerKeyForRun(created.id, runnerKey)
      }
      if (keyId) {
        await db.update(runs).set({ runnerKeyId: keyId }).where(eq(runs.id, created.id))
      }
    } catch (error) {
      console.error("nah-cloud: failed to mint runner key", error)
    }

    await startRunExecution(started, agent)

    return started
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await settleRun(created.id, "failed", { error: message })
    if (error instanceof LaunchRunError) throw error
    throw new LaunchRunError("LAUNCH_FAILED", message)
  }
}

export interface SettleOptions {
  readonly error?: string | null
  readonly exitCode?: number | null
  readonly tokensIn?: number | null
  readonly tokensOut?: number | null
}

export const settleRun = async (
  runId: string,
  status: Exclude<RunStatus, "queued" | "running">,
  options: SettleOptions = {}
): Promise<Run | null> => {
  const db = getDb()

  const [settled] = await db
    .update(runs)
    .set({
      status,
      error: options.error ?? null,
      exitCode: options.exitCode ?? null,
      tokensIn: options.tokensIn ?? null,
      tokensOut: options.tokensOut ?? null,
      finishedAt: new Date()
    })
    .where(and(eq(runs.id, runId), inArray(runs.status, ["queued", "running"])))
    .returning()

  if (!settled) return null

  await appendRunEvent({
    runId,
    kind: status === "failed" ? "run.failed" : "run.settled",
    payload: {
      status,
      error: options.error ?? null,
      exitCode: options.exitCode ?? null,
      tokensIn: options.tokensIn ?? null,
      tokensOut: options.tokensOut ?? null
    }
  })

  await meterRun(runId)
  return settled
}

export const cancelRun = async (runId: string): Promise<Run | null> => {
  const db = getDb()
  const [current] = await db.select().from(runs).where(eq(runs.id, runId))
  if (!current || isTerminal(current.status)) return null

  if (current.sandboxId) {
    try {
      requireSandboxProvider()
      const [sandbox] = await db
        .select({ id: sandboxes.id })
        .from(sandboxes)
        .where(eq(sandboxes.boatSandboxId, current.sandboxId))
      if (sandbox) await stopSandbox(sandbox.id)
    } catch {
      // ignore
    }
  }

  return settleRun(runId, "cancelled")
}
