/**
 * Connecting the CLI to the hosted Cognitive Memory service.
 *
 * Three ways to end up with a key, in the order they are consulted:
 *
 * 1. `COGNITIVE_MEMORY_KEY` in the environment.
 * 2. The platform credential store, if `/cogmem setup` chose that.
 *
 * The environment wins because it is the more explicit statement of intent — it
 * was typed into this shell — and because a key in a CI environment has no
 * keychain to live in. Choosing "env" in setup records that choice, so a key
 * saved earlier cannot quietly take over a session that asked for the
 * environment instead.
 *
 * The base URL follows the same idea: `COGNITIVE_MEMORY_URL` overrides the
 * stored value, which is what makes a self-hosted deployment or a local service
 * one env var away.
 */
import { getStoredSecret } from "./credentials.js";
import { readConfig, updateConfig, type CogmemConfig, type CogmemKeySource } from "./nah-config.js";

/** The account name inside the credential store. One key per install. */
export const COGMEM_ACCOUNT = "default";

/**
 * The hosted service.
 *
 * The SDK's own default is `http://localhost:3000`, which is right for someone
 * running the service and wrong for someone who installed the CLI. Defaulting to
 * the public deployment is the choice that works for the second person.
 */
export const DEFAULT_COGMEM_BASE_URL = "https://cogmem.astracollab.app";

const DEFAULTS: CogmemConfig = {
  enabled: false,
  baseUrl: DEFAULT_COGMEM_BASE_URL,
  keySource: "store",
};

/** Merge stored values over the defaults, dropping anything of the wrong type. */
export const loadCogmemConfig = async (): Promise<CogmemConfig> => {
  const stored = (await readConfig()).cogmem ?? {};
  const baseUrl =
    typeof stored.baseUrl === "string" && stored.baseUrl.trim() ? stored.baseUrl.trim() : DEFAULTS.baseUrl;
  const keySource: CogmemKeySource = stored.keySource === "env" ? "env" : DEFAULTS.keySource;
  return { enabled: stored.enabled === true, baseUrl, keySource };
};

export const saveCogmemConfig = async (patch: Partial<CogmemConfig>): Promise<CogmemConfig> => {
  let saved: CogmemConfig = DEFAULTS;
  await updateConfig((current) => {
    saved = { ...DEFAULTS, ...current.cogmem, ...patch };
    return { ...current, cogmem: saved };
  });
  return saved;
};

/** The URL to talk to, with the environment override applied. */
export const resolveCogmemBaseUrl = (config: CogmemConfig): string => {
  const override = process.env.COGNITIVE_MEMORY_URL?.trim();
  return (override || config.baseUrl).replace(/\/+$/, "");
};

export type ResolvedCogmemKey = {
  key: string | null;
  /** Where it came from, or null when there is none. */
  source: CogmemKeySource | null;
};

/**
 * The key to use, or null with the reason.
 *
 * The reason matters more than the null: "you never set one" and "you set
 * COGNITIVE_MEMORY_KEY= empty" call for different instructions, and a setup flow
 * that cannot tell them apart asks the user to paste a key they already pasted.
 */
export const resolveCogmemKey = async (config: CogmemConfig): Promise<ResolvedCogmemKey> => {
  const fromEnv = process.env.COGNITIVE_MEMORY_KEY?.trim();
  if (fromEnv) return { key: fromEnv, source: "env" };

  if (config.keySource === "env") {
    return { key: null, source: null };
  }

  const stored = await getStoredSecret("cogmem", COGMEM_ACCOUNT);
  return stored ? { key: stored, source: "store" } : { key: null, source: null };
};

/** A key safe to show in a status line: enough to recognise, not enough to use. */
export const maskKey = (key: string): string => {
  if (key.length <= 8) return "•".repeat(key.length);
  return `${key.slice(0, 4)}…${key.slice(-2)} (${key.length} chars)`;
};

/** Whether a string looks like something worth sending to the service. */
export const looksLikeUrl = (value: string): boolean => {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
};
