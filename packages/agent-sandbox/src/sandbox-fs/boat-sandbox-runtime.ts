import type { SandboxRuntime } from "../types.js";
import {
  createBoatRepoSandboxFs,
  type BoatCommandRunner,
  type BoatFileApi,
  type BoatRepoFsOptions,
} from "./boat-repo-fs.js";
import type { RepoSandboxFs } from "./repo-fs-port.js";

/**
 * The Boat sandbox runtime: `SandboxRuntime` + the matching `RepoSandboxFs`.
 *
 * **Not verified against a live sandbox.** Written against the documented v1 shapes
 * in `@boatdev/sdk@1.5.0`. The `executeCommand` path in particular has never run
 * against a real machine; §5 Phase 0 of `docs/hosted-runtime-on-boat.md` is the
 * spike that is supposed to exercise it.
 */

/**
 * The slice of `@boatdev/sdk`'s `BoatApi` this runtime uses for commands.
 *
 * Declared structurally, type-only, for the same reason `BoatFileApi` is: the
 * package keeps **no runtime dependency** on the SDK. It is declared as its own
 * interface rather than widening `BoatFileApi` because the two endpoints have
 * genuinely different shapes, and a caller passing one real `BoatApi` object
 * satisfies both.
 */
export interface BoatCommandApi {
  executeCommand(request: {
    sandboxId: string;
    command: string;
    args?: string[];
    cwd?: string;
    env?: Record<string, string>;
    /**
     * Timeout in **seconds**, per the Boat API. Note `SandboxRuntime` takes
     * milliseconds — `executeCommand` below converts, because guessing wrong
     * means a 5ms timeout or a 5-hour hang.
     */
    timeout?: number;
    /** Run without waiting; poll the returned command id for output. */
    detached?: boolean;
    stream?: boolean;
  }): Promise<{
    ok?: boolean;
    success?: boolean;
    exitCode?: number;
    stdout?: string;
    stderr?: string;
    /** Some Boat responses carry the combined output here instead of `stdout`. */
    result?: string;
    commandId?: string;
  }>;
  /** Lifecycle. Optional so a caller can pass a command-only slice. */
  startSandbox?(request: { sandboxId: string }): Promise<unknown>;
  stopSandbox?(request: { sandboxId: string }): Promise<unknown>;
  deleteSandbox?(request: { sandboxId: string }): Promise<unknown>;
  getSandbox?(request: { sandboxId: string }): Promise<unknown>;
}

/**
 * Boat caps a single synchronous command at 600s.
 *
 * The agent loop is not bound by this (it is a systemd service in the Tier C
 * design), but a single `exec` is — and a caller asking for more gets a confusing
 * provider-side error rather than a clear one. Clamp to the cap and say so.
 */
const BOAT_MAX_SYNC_COMMAND_SECONDS = 600;

/** Default when the caller passes no timeout. Well inside the 600s cap. */
const DEFAULT_COMMAND_TIMEOUT_MS = 60_000;

/**
 * Convert the `SandboxRuntime` millisecond timeout to Boat's seconds, clamped.
 *
 * `timeout: 0` or a negative value would become `0` seconds, i.e. "expire
 * immediately" — almost certainly not what the caller meant, and a confusing
 * failure. Treat any non-positive value as "use the default".
 */
const toBoatTimeoutSeconds = (timeoutMs: number | undefined): number => {
  if (typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return Math.floor(DEFAULT_COMMAND_TIMEOUT_MS / 1000);
  }
  const seconds = Math.ceil(timeoutMs / 1000);
  return Math.min(seconds, BOAT_MAX_SYNC_COMMAND_SECONDS);
};

/**
 * Exit code, following the same rule the NAH adapter uses: prefer an explicit
 * code, else derive from `success`.
 *
 * Kept local rather than imported from the adapter — the adapter is NAH-facing
 * and this package must not make the provider layer depend on it.
 */
const normalizeExitCode = (result: { success?: boolean; exitCode?: number }): number => {
  if (typeof result.exitCode === "number") return result.exitCode;
  return result.success === false ? 1 : 0;
};

export type BoatSandboxRuntimeOptions = {
  /**
   * Lazy accessor for the API, matching `BoatRepoFsOptions.getApi`. Lazy so a
   * caller can construct the runtime before it holds credentials, and so token
   * refresh is picked up without rebuilding the runtime.
   */
  getApi: () => BoatCommandApi & Partial<BoatFileApi>;
  /** Lazy sandbox id — the same sandbox for the life of this runtime. */
  getSandboxId: () => string;
  /** Repo root inside the sandbox. Boat jails paths to `/home/user` and `/tmp`. */
  repoRoot: string;
  /** Default working directory for commands that do not pass one. */
  defaultCwd?: string;
  /** Extra options forwarded to `createBoatRepoSandboxFs`. */
  repoFs?: Omit<BoatRepoFsOptions, "repoRoot" | "getApi" | "getSandboxId" | "runCommand">;
};

export type BoatSandboxRuntime = SandboxRuntime & {
  /**
   * The repo filesystem for this sandbox, with its directory operations already
   * bound to `executeCommand` below.
   */
  fs: RepoSandboxFs;
  executeCommand: NonNullable<SandboxRuntime["executeCommand"]>;
  sandboxId: string;
};

/**
 * Build a `SandboxRuntime` for one Boat sandbox, plus its `RepoSandboxFs`.
 *
 * The two halves are composed here rather than constructed separately because the
 * filesystem port needs a command runner and the only correct runner is *this*
 * sandbox's. `createBoatRepoSandboxFs` therefore receives `executeCommand` from
 * below as its `runCommand`, which is what makes `mkdir`/`rmdir`/`listDir` work
 * at all — Boat's file API has no endpoints for them.
 *
 * Returned as one object so the binding cannot be forgotten or crossed between
 * sandboxes.
 */
export const createBoatSandboxRuntime = (
  options: BoatSandboxRuntimeOptions
): BoatSandboxRuntime => {
  const { getApi, getSandboxId, repoRoot, defaultCwd } = options;

  const executeCommand: NonNullable<SandboxRuntime["executeCommand"]> = async (
    command,
    args = [],
    execOptions
  ) => {
    const sandboxId = getSandboxId();
    if (!sandboxId) {
      throw new Error("Boat sandbox runtime: no sandbox id. Create the sandbox before running commands.");
    }

    const request = {
      sandboxId,
      command,
      args,
      ...(execOptions?.cwd ?? defaultCwd ? { cwd: execOptions?.cwd ?? defaultCwd } : {}),
      ...(execOptions?.env ? { env: execOptions.env } : {}),
      timeout: toBoatTimeoutSeconds(execOptions?.timeout),
    };

    const result = await getApi().executeCommand(request);

    return {
      success: result.success ?? normalizeExitCode(result) === 0,
      exitCode: normalizeExitCode(result),
      stdout: result.stdout ?? result.result ?? "",
      stderr: result.stderr ?? "",
    };
  };

  // The single point where the two halves meet. `runCommand` is this runtime's
  // own `executeCommand`, so a `RepoSandboxFs` can never end up driving a
  // different sandbox's shell.
  const runCommand: BoatCommandRunner = (command, args, execOptions) =>
    executeCommand(command, args, execOptions);

  const fs = createBoatRepoSandboxFs({
    ...(options.repoFs ?? {}),
    repoRoot,
    getApi: getApi as () => BoatFileApi,
    getSandboxId,
    runCommand,
  });

  return {
    sandboxId: getSandboxId(),
    executeCommand,
    fs,
    start: options.getApi().startSandbox
      ? () => getApi().startSandbox!({ sandboxId: getSandboxId() })
      : undefined,
    destroy: options.getApi().deleteSandbox
      ? () => getApi().deleteSandbox!({ sandboxId: getSandboxId() })
      : undefined,
  };
};

export const __testing = { toBoatTimeoutSeconds, normalizeExitCode };