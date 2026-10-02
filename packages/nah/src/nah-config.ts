/**
 * `~/.nah/config.json`, read and written in one place.
 *
 * The last-used model and the Cognitive Memory connection both live in this file,
 * so two modules doing their own read-modify-write would race: a `/model` and a
 * `/cogmem` in the same moment, and one silently drops the other's change. Every
 * write goes through `updateConfig`, which is the only code that touches the file.
 *
 * The write is temp-file-plus-rename because a config truncated by a crash is
 * worse than one that is briefly stale, and 0600 because it is a user's home
 * directory even when the values in it are not secret.
 */
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as nodePath from "node:path";

/** Where a Cognitive Memory key comes from. See `./cogmem-config.ts`. */
export type CogmemKeySource = "store" | "env";

export type CogmemConfig = {
  /** Use the hosted service rather than the local SQLite store. */
  enabled: boolean;
  baseUrl: string;
  keySource: CogmemKeySource;
};

export type NahConfig = {
  lastModel?: string;
  cogmem?: Partial<CogmemConfig>;
};

export const configPath = (): string => nodePath.join(os.homedir(), ".nah", "config.json");

/** The stored config, or an empty one. A corrupt file is not worth crashing over. */
export const readConfig = async (): Promise<NahConfig> => {
  try {
    const parsed = JSON.parse(await fs.readFile(configPath(), "utf8")) as unknown;
    return typeof parsed === "object" && parsed !== null ? (parsed as NahConfig) : {};
  } catch {
    return {};
  }
};

export const writeConfig = async (next: NahConfig): Promise<void> => {
  const path = configPath();
  await fs.mkdir(nodePath.dirname(path), { recursive: true, mode: 0o700 });
  const temporaryPath = `${path}.${process.pid}.tmp`;
  await fs.writeFile(temporaryPath, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  await fs.rename(temporaryPath, path);
  await fs.chmod(path, 0o600);
};

/**
 * Read-modify-write, atomically enough.
 *
 * The transform receives the current file contents so a caller never has to
 * remember to read first, and cannot accidentally write a whole config from a
 * value it read before someone else changed it.
 */
export const updateConfig = async (mutate: (current: NahConfig) => NahConfig): Promise<NahConfig> => {
  const next = mutate(await readConfig());
  await writeConfig(next);
  return next;
};
