import type { RepoSandboxFs } from "../../sandbox-fs/repo-fs-port.js";
import { normalizeUnderRepoRoot } from "../../sandbox-fs/path-utils.js";
import type { SandboxRuntime } from "../../types.js";
import { createGlobResolver } from "./glob.js";
import { buildGrepCommand, filterGrepOutput, GREP_TIMEOUT_SECONDS } from "./shell.js";

export type NahToolEnvironmentOptions = {
  repoFs: RepoSandboxFs;
  sandbox: SandboxRuntime;
  /**
   * Default wall-clock cap for `exec` when the caller does not pass one, in seconds.
   * NAH's `bash` tool already defaults its schema to 120, but the harness also calls
   * `exec` directly and the sandbox provider has no timeout of its own. 120 matches
   * `createNodeEnvironment`.
   */
  defaultExecTimeoutSeconds?: number;
};

const DEFAULT_EXEC_TIMEOUT_SECONDS = 120;

/**
 * The subset of `not-another-harness`'s `ToolEnvironment` that this
 * adapter satisfies, declared structurally so the SDK keeps no compile-time dependency
 * on the harness.
 *
 * Kept field-for-field with the harness contract, including the two members the
 * previous version omitted — `glob` and `exec`'s `signal` — because their absence was
 * what disabled the `glob` tool and made aborts unable to stop a running command.
 */
export interface NahToolEnvironment {
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
  deleteFile(path: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  readdir(path: string): Promise<Array<{ name: string; type: "file" | "directory" }>>;
  grep(options: {
    pattern: string;
    path?: string;
    ignoreCase?: boolean;
    maxPerFile?: number;
    includeHidden?: boolean;
  }): Promise<string>;
  exec(
    command: string,
    options?: { timeoutSeconds?: number; signal?: AbortSignal },
  ): Promise<{ stdout: string; stderr: string; exitCode: number }>;
  glob(options: {
    pattern: string;
    path?: string;
    includeHidden?: boolean;
    limit?: number;
  }): Promise<string[]>;
}

/** Raised only when a caller passes a signal the sandbox provider cannot accept. */
const normalizeExitCode = (result: {
  success?: boolean;
  exitCode?: number;
}): number => {
  if (typeof result.exitCode === "number") return result.exitCode;
  return result.success === false ? 1 : 0;
};

/** Adapt the shared repo filesystem and sandbox command runner to NAH's ToolEnvironment. */
export const createNahToolEnvironment = ({
  repoFs,
  sandbox,
  defaultExecTimeoutSeconds = DEFAULT_EXEC_TIMEOUT_SECONDS,
}: NahToolEnvironmentOptions): NahToolEnvironment => {
  if (typeof sandbox.executeCommand !== "function") {
    throw new Error("createNahToolEnvironment requires a sandbox with executeCommand().");
  }
  const executeCommand = sandbox.executeCommand.bind(sandbox);
  const resolve = (path: string) => normalizeUnderRepoRoot(repoFs.repoRoot, path);
  const relative = (absolutePath: string) =>
    absolutePath === repoFs.repoRoot ? "." : absolutePath.slice(repoFs.repoRoot.length + 1);
  const glob = createGlobResolver(repoFs);

  return {
    // Each method is `async` so a `RepoPathError` from `resolve` surfaces as a rejected
    // promise rather than a synchronous throw. NAH's `ToolEnvironment` is Promise-based,
    // and a host chaining `.catch()` on the result would otherwise miss it.
    readFile: async (path) => repoFs.readText(resolve(path)),
    writeFile: async (path, content) => {
      await repoFs.writeText(resolve(path), content, { recursive: true });
    },
    // `force` so removing an already-removed file is a no-op rather than a tool error.
    // `recursive: false` keeps this a file tool — NAH has no recursive-delete verb.
    deleteFile: async (path) => {
      await repoFs.deletePath(resolve(path), { recursive: false, force: true });
    },
    exists: async (path) => repoFs.exists(resolve(path)),
    readdir: async (path) => {
      const entries = await repoFs.listDir(resolve(path));
      return [...entries]
        .sort((a, b) => {
          if (a.type !== b.type) return a.type === "directory" ? -1 : 1;
          return a.name.localeCompare(b.name);
        })
        .map((entry) => ({ name: entry.name, type: entry.type }));
    },
    grep: async ({ pattern, path, ignoreCase, maxPerFile, includeHidden }) => {
      const command = buildGrepCommand({
        pattern,
        target: path?.trim() || undefined,
        ignoreCase,
        maxPerFile,
      });
      // Run from the repo root so the output paths are repo-relative.
      const result = await executeCommand("bash", ["-lc", command], {
        cwd: repoFs.repoRoot,
        timeout: GREP_TIMEOUT_SECONDS * 1000,
      });
      return filterGrepOutput(result.stdout ?? result.result ?? "", { includeHidden });
    },
    exec: async (command, options) => {
      const signal = options?.signal;
      if (signal?.aborted) {
        return { stdout: "", stderr: "aborted before start", exitCode: 130 };
      }

      const timeoutMs = (options?.timeoutSeconds ?? defaultExecTimeoutSeconds) * 1000;
      const started = executeCommand("bash", ["-lc", command], {
        cwd: repoFs.repoRoot,
        timeout: timeoutMs,
        // Providers that can cancel an in-flight command should honour this. The
        // `SandboxRuntime` contract predates it, so it is additive and older providers
        // simply ignore it.
        ...(signal ? { signal } : {}),
      } as Parameters<typeof executeCommand>[2]);

      if (!signal) {
        const result = await started;
        return {
          stdout: result.stdout ?? result.result ?? "",
          stderr: result.stderr ?? "",
          exitCode: normalizeExitCode(result),
        };
      }

      // The sandbox keeps running the command after we stop waiting for it, so the
      // losing branch must not surface as an unhandled rejection.
      started.catch(() => undefined);

      // Race the abort so the harness never blocks on a command the sandbox keeps
      // running after the model stream is torn down. Exit 130 is the shell convention
      // for SIGINT, and 124 for `timeout`, matching GNU coreutils.
      type Outcome =
        | { kind: "done"; result: Awaited<typeof started> }
        | { kind: "aborted" }
        | { kind: "timeout" };

      const aborted = new Promise<Outcome>((resolveRace) => {
        signal.addEventListener("abort", () => resolveRace({ kind: "aborted" }), { once: true });
      });
      const timedOut = new Promise<Outcome>((resolveRace) => {
        const timer = setTimeout(
          () => resolveRace({ kind: "timeout" }),
          timeoutMs,
        );
        // Never hold the event loop open for a timeout nobody is waiting on.
        timer.unref?.();
      });

      const outcome = await Promise.race<Outcome>([
        started.then((result) => ({ kind: "done", result })),
        aborted,
        timedOut,
      ]);

      if (outcome.kind === "aborted") {
        return { stdout: "", stderr: "command aborted", exitCode: 130 };
      }
      if (outcome.kind === "timeout") {
        return {
          stdout: "",
          stderr: `command timed out after ${timeoutMs}ms`,
          exitCode: 124,
        };
      }
      return {
        stdout: outcome.result.stdout ?? outcome.result.result ?? "",
        stderr: outcome.result.stderr ?? "",
        exitCode: normalizeExitCode(outcome.result),
      };
    },
    glob,
  };
};

/**
 * Not implemented, by design.
 *
 * NAH's `ToolEnvironment` also offers optional `snapshot()` / `restoreSnapshot()` for
 * per-step undo. Both need the full file tree with base64 contents, which over the
 * Blaxel port is one RPC per file — far too expensive to run after every agent step.
 * NAH's harness never calls them (only the `nah` CLI does, to build its own undo
 * history), so omitting them keeps every agent turn cheap. A host that wants step-level
 * undo should add them on top of the returned object; the two optional methods are part
 * of the harness's structural type, so adding them later is not a breaking change.
 */

export { createGlobResolver, globStaticPrefix } from "./glob.js";
export {
  buildGrepCommand,
  filterGrepOutput,
  isHiddenPath,
  parseGrepLine,
  shellQuote,
  GREP_TIMEOUT_SECONDS,
} from "./shell.js";
export type { RepoSandboxFs } from "../../sandbox-fs/repo-fs-port.js";
