import type { SandboxRuntime } from "../types.js";

/**
 * RAII wrapper: starts the sandbox, runs `fn`, and destroys it after.
 *
 * Destroy is best-effort — errors from the cleanup phase are swallowed and
 * logged via `console.warn` so they don't mask the user's original error.
 */
export const withSandbox = async <S extends SandboxRuntime, T>(
  sandbox: S,
  fn: (sandbox: S) => Promise<T>,
): Promise<T> => {
  if (typeof sandbox.start === "function") {
    await sandbox.start();
  }
  try {
    return await fn(sandbox);
  } finally {
    if (typeof sandbox.destroy === "function") {
      try {
        await sandbox.destroy();
      } catch (error) {
        // eslint-disable-next-line no-console
        console.warn("[agent-sandbox] sandbox.destroy() failed", error);
      }
    }
  }
};
