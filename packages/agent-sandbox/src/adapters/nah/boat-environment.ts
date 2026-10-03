import {
  createBoatSandboxRuntime,
  type BoatSandboxRuntime,
  type BoatSandboxRuntimeOptions,
} from "../../sandbox-fs/boat-sandbox-runtime.js";
import { createNahToolEnvironment, type NahToolEnvironment } from "./index.js";

/**
 * Boat-backed `ToolEnvironment` for NAH.
 *
 * Lives here rather than in `packages/nah/src/sandbox.ts` (where
 * `createBlaxelEnvironment` is) because `packages/agent-sandbox` is a **separate
 * pnpm workspace**: `nah` cannot import `@astracollab/agent-sandbox`, and adding
 * that edge means restructuring the build graph. Keeping the provider here means
 * the NAH adapter composes its own runtime and filesystem without a new
 * cross-workspace dependency. `packages/nah` can adopt it later by depending on
 * this package deliberately, not by accident.
 */

export type BoatEnvironmentOptions = BoatSandboxRuntimeOptions & {
  /**
   * Label for logs and the system prompt. Defaults to the sandbox id.
   *
   * This is **not** a lookup key, unlike Blaxel's `sandboxName`. Boat sandboxes
   * are addressed by id; naming one something does not let you find it later.
   */
  label?: string;
};

export type BoatEnvironment = {
  env: NahToolEnvironment;
  /** Human-readable label for `cwdLabel` in the system prompt. */
  sandboxName: string;
  /** The composed runtime, for callers that also want `fs` or lifecycle hooks. */
  runtime: BoatSandboxRuntime;
  destroy: () => Promise<void>;
};

/**
 * Build a NAH `ToolEnvironment` backed by one Boat sandbox.
 *
 * Returns the same `{ env, sandboxName, destroy }` shape as
 * `createBlaxelEnvironment`, so a caller that selects a provider does not branch
 * on provider for anything except the call itself.
 */
export const createBoatEnvironment = async (
  opts: BoatEnvironmentOptions,
): Promise<BoatEnvironment> => {
  const { label, ...runtimeOptions } = opts;
  const runtime = createBoatSandboxRuntime(runtimeOptions);

  // Fresh sandboxes have no repo dir, and every file tool resolves under it.
  // Best-effort: a template that already has the directory makes this a no-op,
  // and a sandbox that cannot `mkdir` will fail on the first real tool call
  // with a far clearer error than "no such file" on every subsequent one.
  await runtime
    .executeCommand!("bash", ["-lc", `mkdir -p ${shellQuote(runtime.fs.repoRoot)}`], {
      cwd: "/",
    })
    .catch(() => undefined);

  return {
    env: createNahToolEnvironment({ repoFs: runtime.fs, sandbox: runtime }),
    sandboxName: label ?? runtime.sandboxId,
    runtime,
    destroy: async () => {
      await runtime.destroy?.();
    },
  };
};

/**
 * Default repo root inside a Boat sandbox.
 *
 * Deliberately **not** `DEFAULT_CODING_SANDBOX_REPO_DIR`. That is
 * `/workspace/repo`, a Blaxel-shaped path, and Boat's server-side jail only
 * admits `/home/user` and `/tmp` — it answers anything else with
 * `400 invalid_path`. Concatenating the two would produce
 * `/home/user//workspace/repo`, which is inside the jail but is not where anyone
 * expects a clone to land. Override per call when a template uses another layout.
 */
export const DEFAULT_BOAT_REPO_DIR = "/home/user/repo";

/** Single-quote a path for `bash -lc`. The `'"'"'` idiom is the standard escape. */
const shellQuote = (value: string): string => `'${value.replace(/'/g, `'"'"'`)}'`;