/**
 * Choosing the memory backend at startup.
 *
 * One decision, in one place: is this session using the in-process engine or the
 * hosted service? `/cogmem` makes the same decision later, mid-session, and two
 * copies of it would eventually disagree about what "enabled but no key" means.
 *
 * The fallback is the important part. Hosted memory that cannot be reached — no
 * key, a revoked key, a service that is down — is not an error that stops the
 * CLI; it is local memory plus a line saying why, because an agent that forgets
 * everything is worse than one that remembers slightly less.
 */
import { createMemoryReconciler, createTurnExtractor, prepareMemory, type MemoryOptions } from "./memory.js";
import { localMemory, type SessionMemory } from "./memory-backend.js";
import { hostedMemory } from "./memory-hosted.js";
import { loadCogmemConfig, resolveCogmemBaseUrl, resolveCogmemKey } from "./cogmem-config.js";
import type { CogmemConfig } from "./nah-config.js";

export type MemorySelection = {
  memory: SessionMemory;
  /**
   * Why the requested backend was not used, or a note worth printing.
   *
   * Printed once at startup so a user who enabled hosted memory is never quietly
   * running on the local store without knowing it.
   */
  note?: string;
};

/** Build whichever backend the config asks for, falling back to local. */
export const selectMemory = async (options: {
  cwd: string;
  persist: boolean;
  /** Null when no model is configured, which only the local backend can use. */
  model: Parameters<typeof createTurnExtractor>[0] | null;
  config?: CogmemConfig;
}): Promise<MemorySelection> => {
  const config = options.config ?? (await loadCogmemConfig());

  const local = async (note?: string): Promise<MemorySelection> => {
    const prepared = await prepareMemory({
      cwd: options.cwd,
      persist: options.persist,
      extractor: options.model ? createTurnExtractor(options.model) : null,
      reconciler: options.model ? createMemoryReconciler(options.model) : null,
    } satisfies MemoryOptions);
    return {
      memory: localMemory({
        memory: prepared.memory,
        location: prepared.path,
        restored: prepared.restored,
        ...(prepared.importedFrom === undefined ? {} : { importedFrom: prepared.importedFrom }),
      }),
      ...(note === undefined ? {} : { note }),
    };
  };

  if (!config.enabled) return local();

  const { key, source } = await resolveCogmemKey(config);
  if (!key) {
    return local(
      config.keySource === "env"
        ? "hosted memory is enabled but COGNITIVE_MEMORY_KEY is not set — using the local store"
        : "hosted memory is enabled but no API key is stored — run /cogmem setup",
    );
  }

  const baseUrl = resolveCogmemBaseUrl(config);
  return {
    memory: hostedMemory({ apiKey: key, baseUrl }),
    note: `memory → hosted · ${baseUrl} · key from ${source === "env" ? "COGNITIVE_MEMORY_KEY" : "the credential store"}`,
  };
};
