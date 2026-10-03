/**
 * Where a running Studio is, if there is one.
 *
 * The mirror of `@astracollab/nah-studio`'s endpoint module, and deliberately a
 * copy rather than an import: `nah` must be able to start the Studio without
 * depending on the package it starts, which is the whole point of installing it
 * on demand. The format is a handful of fields and the reader below refuses
 * anything it does not understand, so the two halves can disagree without
 * corrupting anything — a mismatch costs you telemetry, never a bad write.
 *
 * A file whose process is gone is not an endpoint. Otherwise every session on the
 * machine keeps retrying a port nobody is listening on, and a Studio that was
 * stopped an hour ago still claims to be running.
 */
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as nodePath from "node:path";

export type StudioEndpoint = {
  /** Base URL, e.g. `http://127.0.0.1:4111`. */
  url: string;
  /** Required only when the Studio is not bound to loopback. */
  token?: string;
  pid: number;
  startedAt: number;
  version: string;
  /** The `nah` that started it, so agents are launched with the same build. */
  nahBin?: string;
  cwd?: string;
};

export const STUDIO_PACKAGE = "nah-studio";

/**
 * The tag `/studio` installs from.
 *
 * `beta`, because that is where a prerelease goes, and `latest` is whatever was
 * published without a tag — for a package that has only ever been published with
 * one, that is the first build, and it stays there.
 */
export const STUDIO_DIST_TAG = "beta";

export const endpointPath = (home: string = os.homedir()): string =>
  nodePath.join(home, ".nah", "studio.json");

/** Read it, or null. Never throws: every caller treats that as "no Studio". */
export const readEndpoint = async (path: string = endpointPath()): Promise<StudioEndpoint | null> => {
  try {
    const parsed = JSON.parse(await fs.readFile(path, "utf8")) as Partial<StudioEndpoint>;
    if (typeof parsed.url !== "string" || typeof parsed.pid !== "number") return null;
    return {
      url: parsed.url,
      ...(parsed.token === undefined ? {} : { token: parsed.token }),
      pid: parsed.pid,
      startedAt: parsed.startedAt ?? 0,
      version: parsed.version ?? "unknown",
      ...(parsed.nahBin === undefined ? {} : { nahBin: parsed.nahBin }),
      ...(parsed.cwd === undefined ? {} : { cwd: parsed.cwd }),
    };
  } catch {
    return null;
  }
};

/** Whether a process is still running. Signal 0 tests for existence. */
export const isProcessAlive = (pid: number): boolean => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means it exists and belongs to somebody else, which still counts.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

/**
 * The Studio to report to, or null.
 *
 * Cheap on purpose: a failed request to a dead Studio is far more expensive than
 * one process-existence check, and this runs at the start of every session.
 */
export const liveEndpoint = async (path: string = endpointPath()): Promise<StudioEndpoint | null> => {
  const endpoint = await readEndpoint(path);
  if (!endpoint) return null;
  return isProcessAlive(endpoint.pid) ? endpoint : null;
};

/**
 * Remove a Studio's endpoint file, but only if it is still that Studio's.
 *
 * Two Studios on one machine is a mistake rather than a plan, and whichever
 * exits first would otherwise delete the other's file and leave every agent
 * talking to a closed port.
 */
export const clearEndpoint = async (pid: number, path: string = endpointPath()): Promise<void> => {
  const existing = await readEndpoint(path);
  if (existing && existing.pid !== pid) return;
  await fs.rm(path, { force: true });
};

/**
 * Is a Studio answering?
 *
 * Asked before `/studio` starts another, so the command opens the dashboard you
 * already have rather than reporting a port in use.
 */
export const probeStudio = async (
  endpoint: StudioEndpoint,
  timeoutMs = 1_500,
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> => {
  try {
    const response = await fetchImpl(new URL("/api/health", endpoint.url), {
      headers: endpoint.token === undefined ? {} : { authorization: `Bearer ${endpoint.token}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
    return response.ok;
  } catch {
    return false;
  }
};
