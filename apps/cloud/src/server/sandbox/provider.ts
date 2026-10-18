/**
 * The seam between the control plane and whichever provider owns the machine.
 *
 * Everything above this file — lifecycle, the run state machine, the event log,
 * billing — is written against `CloudSandboxProvider` and nothing else. That is
 * the whole risk control for picking a vendor: swapping Boat for E2B, Fly or a
 * Durable Object is one new implementation of this interface, not a rewrite.
 * `docs/hosted-runtime-on-boat.md` §6.1 is explicit that a provider type must
 * never leak past this file.
 */

import * as boat from "./boat"
import { BoatApiError } from "./boat"

/** What a provision call needs. Secrets appear here and nowhere else. */
export interface ProvisionRequest {
  readonly organizationId: string
  readonly agentId: string
  /** vCPU count. Boat bills per second of it, so this is the cost dial. */
  readonly cpu: number
  readonly memoryMb: number
  /**
   * How long the machine may sit untouched before the provider reclaims it.
   *
   * Also applied on resume, so a reused sandbox gets a fresh allowance rather
   * than inheriting whatever is left of a previous one.
   */
  readonly ttlSeconds?: number
  /**
   * Per-sandbox environment, injected at provision time.
   *
   * Never inherited from the account and never baked into a template. A template
   * that carries our model key would bake it into every fork forever, which is
   * why `noEnv` is not a caller-tunable option anywhere in this codebase.
   */
  readonly env: Readonly<Record<string, string>>
}

export interface ProvisionedSandbox {
  /** The addressable provider id — the one every later call takes. */
  readonly providerSandboxId: string
  /** The runtime's HTTPS endpoint from `host <port> --private`, when reachable. */
  readonly runtimeUrl: string | null
}

export interface ExecResult {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
}

export interface ExecOptions {
  readonly cwd?: string
  readonly env?: Readonly<Record<string, string>>
  readonly timeoutMs?: number
}

export interface StartCommandRequest {
  readonly command: string
  readonly cwd?: string
}

/** Boat's handle onto a detached process: enough to poll it later. */
export interface StartedCommand {
  readonly processId: number
}

export interface CommandStatusOptions {
  /** Bytes of stdout already consumed; the provider returns only what is new. */
  readonly stdoutOffset?: number
  readonly stderrOffset?: number
}

export interface CommandStatus {
  readonly status: "running" | "exited" | "lost"
  readonly exitCode: number | null
  readonly oomKilled: boolean
  readonly stdout: string
  readonly stderr: string
  /** Where the returned stdout chunk starts. 0 means the log was replaced. */
  readonly stdoutOffset: number
  /** The absolute offset to persist and ask for next tick. */
  readonly stdoutNextOffset: number
  readonly stderrNextOffset: number
}

/**
 * A provider operation referenced a sandbox that does not exist.
 *
 * Exported so callers can distinguish "this machine is gone" from "the vendor
 * had a bad day" without naming a vendor: a 404 from any provider surfaces as
 * this type, and every caller's reaction is the same — treat the row as drift.
 */
export class SandboxNotFoundError extends Error {
  readonly providerSandboxId: string

  constructor(providerSandboxId: string) {
    super(`Sandbox ${providerSandboxId} no longer exists at the provider.`)
    this.name = "SandboxNotFoundError"
    this.providerSandboxId = providerSandboxId
  }
}

/**
 * A provider that is not configured is a normal state, not a crash.
 *
 * A developer running the dashboard locally has no Boat account. If that threw an
 * opaque `undefined is not a function` from three frames down, the dashboard would
 * look broken rather than unconfigured, and the fix — set the env vars — would be
 * invisible. Every entry point checks `isConfigured` first and reports the missing
 * variable by name.
 */
export class ProviderUnavailableError extends Error {
  readonly missing: readonly string[]

  constructor(providerName: string, missing: readonly string[]) {
    super(
      `Sandbox provider "${providerName}" is not configured. Set ${missing.join(", ")}.`
    )
    this.name = "ProviderUnavailableError"
    this.missing = missing
  }
}

/**
 * The minimum a provider must do for hosted agents to work.
 *
 * Deliberately not the full `SandboxRuntime` from `@astracollab/agent-sandbox`:
 * that port describes an agent's *view* of a machine (readFile, grep, exec), which
 * the agent gets for free once the runtime is reachable. What the control plane
 * needs is the operator's view — make a machine, talk to it, bill it, throw it
 * away — and conflating the two is how a vendor's file-locking type ends up
 * threaded through every page.
 */
export interface CloudSandboxProvider {
  /** Matches `ProviderName` in the sandbox SDK. */
  readonly name: string
  /** Env vars that must be set for this provider to work. */
  readonly requiredEnv: readonly string[]
  isConfigured(): boolean

  provision(request: ProvisionRequest): Promise<ProvisionedSandbox>
  /** Resolves the daemon URL, waiting for the sandbox to accept a connection. */
  waitForRuntime(sandboxId: string): Promise<string | null>
  exec(
    sandboxId: string,
    command: string,
    args: readonly string[],
    options?: ExecOptions
  ): Promise<ExecResult>

  /** Write a file on the sandbox — how secrets reach a VM without a log line. */
  putFile(sandboxId: string, path: string, content: string): Promise<void>
  /** Start a detached command; the handle is polled with `commandStatus`. */
  startCommand(sandboxId: string, request: StartCommandRequest): Promise<StartedCommand>
  commandStatus(
    sandboxId: string,
    processId: number,
    options?: CommandStatusOptions
  ): Promise<CommandStatus>

  /** Snapshot + pause billing. Not a teardown — the disk survives. */
  stop(sandboxId: string): Promise<void>
  resume(sandboxId: string, options?: { readonly ttlSeconds?: number }): Promise<void>
  /** The only call that frees the disk, and the only terminal transition. */
  destroy(sandboxId: string): Promise<void>
}

let installed: CloudSandboxProvider | null = null

/**
 * Register the provider. Called once, from the composition root.
 *
 * Exists so the control plane can be exercised end to end — launch, settle,
 * meter — without a provider account, which is the only way this can be tested in
 * CI at all.
 */
export const installSandboxProvider = (provider: CloudSandboxProvider): void => {
  installed = provider
}

/** The active provider, or `null` when none is configured. */
export const getSandboxProvider = (): CloudSandboxProvider | null => {
  if (installed) return installed
  if (!process.env.BOAT_API_TOKEN) return null
  return createBoatProvider()
}

/** The active provider, or a `ProviderUnavailableError` naming what is missing. */
export const requireSandboxProvider = (): CloudSandboxProvider => {
  const provider = getSandboxProvider()
  if (!provider) throw new ProviderUnavailableError("boat", ["BOAT_API_TOKEN"])
  if (!provider.isConfigured()) {
    throw new ProviderUnavailableError(provider.name, provider.requiredEnv)
  }
  return provider
}

const toSandboxNotFound = (sandboxId: string, error: unknown): SandboxNotFoundError | null =>
  error instanceof BoatApiError && error.status === 404
    ? new SandboxNotFoundError(sandboxId)
    : null

const throwMapped = (sandboxId: string, error: unknown): never => {
  const notFound = toSandboxNotFound(sandboxId, error)
  if (notFound) throw notFound
  throw error
}

/**
 * Quote a value for POSIX single-quoted shell syntax.
 *
 * Only used to assemble `exec`'s env prefix; the runner path never builds shell
 * strings — it writes a script file whose dynamic content is base64, precisely
 * so quoting cannot be the bug.
 */
const shellQuote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`

/**
 * Boat-backed provider.
 *
 * `getSandboxProvider` only constructs this when `BOAT_API_TOKEN` is present, so
 * importing this module costs nothing for a local dashboard.
 */
export function createBoatProvider(): CloudSandboxProvider {
  const requiredEnv = ["BOAT_API_TOKEN"] as const
  const token = (): string => {
    const value = process.env.BOAT_API_TOKEN?.trim()
    if (!value) throw new ProviderUnavailableError("boat", requiredEnv)
    return value
  }

  return {
    name: "boat",
    requiredEnv,
    isConfigured: () => Boolean(process.env.BOAT_API_TOKEN?.trim()),

    async provision(request) {
      token()
      // The size tier is the smallest that satisfies the request: cpu is a real
      // dial, memoryMb is a floor only, because Boat sells memory in machine
      // sizes and there is no point asking for less than the tier provides.
      const type: boat.BoatMachineType =
        request.cpu <= 2 && request.memoryMb <= 4096
          ? "small"
          : request.cpu <= 4 && request.memoryMb <= 8192
            ? "default"
            : request.cpu <= 8 && request.memoryMb <= 16384
              ? "large"
              : "xlarge"

      try {
        const created = await boat.createSandbox({
          type,
          ttlSeconds: request.ttlSeconds ?? 3600,
          env: request.env
        })
        return { providerSandboxId: created.id, runtimeUrl: null }
      } catch (error) {
        // Nothing to map: a create that 404s has no id to be missing, and the
        // envelope's own code is already the actionable message.
        throw error
      }
    },

    async waitForRuntime(sandboxId) {
      token()
      // failFast means the create already answered with a real state; this poll
      // only covers the window between `creating` and the machine accepting
      // commands. 180s is the cold-start ceiling — past it, a failure is
      // structural (no capacity, bad image), not a wait, and must surface.
      const deadline = Date.now() + 180_000
      for (;;) {
        let sandbox: boat.BoatSandbox
        try {
          sandbox = await boat.getSandbox(sandboxId)
        } catch (error) {
          throwMapped(sandboxId, error)
          throw error
        }

        const state = sandbox.state.toLowerCase()
        if (state === "ready" || state === "idle" || state === "running") {
          return null
        }
        if (state === "error" || state === "cancelled" || state === "archived" || state === "archiving") {
          throw new Error(
            `Sandbox ${sandboxId} is "${state}"${sandbox.error ? `: ${sandbox.error}` : "."}`
          )
        }
        if (Date.now() >= deadline) {
          throw new Error(`Sandbox ${sandboxId} never became ready (last state "${sandbox.state}").`)
        }
        await new Promise((resolve) => setTimeout(resolve, 3000))
      }
    },

    async exec(sandboxId, command, args, options = {}) {
      token()
      const parts = [command, ...args.map(shellQuote)]
      let script = parts.join(" ")
      const envEntries = Object.entries(options.env ?? {})
      if (envEntries.length > 0) {
        const exports = envEntries.map(([key, value]) => `export ${key}=${shellQuote(value)}`)
        script = `${exports.join("; ")}; ${script}`
      }
      if (options.cwd) script = `cd ${shellQuote(options.cwd)} && ${script}`

      const timeoutMs = options.timeoutMs ?? 30_000
      // Boat clamps timeoutSeconds to 1..600; anything longer belongs on a
      // detached command, not a synchronous one.
      const timeoutSeconds = Math.min(600, Math.max(1, Math.ceil(timeoutMs / 1000)))

      try {
        const result = await boat.runCommand(sandboxId, { command: script, timeoutSeconds })
        if (result.exitCode === null) {
          throw new Error(
            `Command on ${sandboxId} ended without an exit code${result.timedOut ? " (timed out)" : result.oomKilled ? " (killed)" : ""}.`
          )
        }
        return {
          exitCode: result.exitCode,
          stdout: result.stdout,
          stderr: result.stderr
        } as ExecResult
      } catch (error) {
        throwMapped(sandboxId, error)
        throw error
      }
    },

    async putFile(sandboxId, path, content) {
      token()
      try {
        await boat.writeFile(sandboxId, path, content)
      } catch (error) {
        throwMapped(sandboxId, error)
        throw error
      }
    },

    async startCommand(sandboxId, request) {
      token()
      try {
        const started = await boat.startCommand(sandboxId, {
          command: request.command,
          ...(request.cwd ? { cwd: request.cwd } : {})
        })
        return { processId: started.processId } as StartedCommand
      } catch (error) {
        throwMapped(sandboxId, error)
        throw error
      }
    },

    async commandStatus(sandboxId, processId, options = {}) {
      token()
      try {
        const status = await boat.getCommandStatus(sandboxId, processId, options)
        return {
          status: status.status,
          exitCode: status.exitCode,
          oomKilled: status.oomKilled,
          stdout: status.stdout,
          stdoutOffset: status.stdoutOffset,
          stdoutNextOffset: status.stdoutNextOffset,
          stderrNextOffset: status.stderrNextOffset,
          stderr: status.stderr
        } as CommandStatus
      } catch (error) {
        throwMapped(sandboxId, error)
        throw error
      }
    },

    async stop(sandboxId) {
      token()
      try {
        await boat.stopSandbox(sandboxId)
      } catch (error) {
        // A machine that is already gone is a machine that is not billing.
        // That is the outcome stop is for, so a 404 is success here.
        if (!(error instanceof BoatApiError && error.status === 404)) throw error
      }
    },

    async resume(sandboxId, options = {}) {
      token()
      try {
        await boat.resumeSandbox(sandboxId, options)
      } catch (error) {
        throwMapped(sandboxId, error)
        throw error
      }
    },

    async destroy(sandboxId) {
      token()
      // deleteSandbox already treats 404 as success; the map here is for any
      // other shape so destroy stays the one call that cannot fail on absence.
      try {
        await boat.deleteSandbox(sandboxId)
      } catch (error) {
        throwMapped(sandboxId, error)
      }
    }
  }
}
