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
 * `latest`, because that is what the Studio is published under. This used to be
 * `beta` — when the Studio was a prerelease — but the releases now go out under
 * `latest`, so installing from `beta` would pin every user to a dead tag.
 */
export const STUDIO_DIST_TAG = "latest";

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

/**
 * Compare two semver strings.
 *
 * Returns negative when `a` is older than `b`, positive when newer, zero when equal.
 *
 * Prerelease suffixes are respected: `1.0.0-beta.2` is older than `1.0.0`, and
 * `0.0.1-beta.2` older than `0.0.1-beta.12`. Ignoring them made a beta behind the
 * `latest` tag look like a match for it, so the upgrade prompt never fired.
 */
export const compareVersions = (a: string, b: string): number => {
  const parse = (v: string): { core: number[]; pre: string[] } => {
    const [main = ""] = v.replace(/^v/, "").split("+");
    const [core = "", pre] = main.split("-");
    return {
      core: core.split(".").map((n) => {
        const num = parseInt(n, 10);
        return Number.isNaN(num) ? 0 : num;
      }),
      pre: pre ? pre.split(".") : [],
    };
  };
  const { core: aCore, pre: aPre } = parse(a);
  const { core: bCore, pre: bPre } = parse(b);
  for (let i = 0; i < Math.max(aCore.length, bCore.length); i += 1) {
    const av = aCore[i] ?? 0;
    const bv = bCore[i] ?? 0;
    if (av !== bv) return av - bv;
  }
  // Same core version: a prerelease sorts before the release it precedes.
  if (aPre.length === 0 && bPre.length > 0) return 1;
  if (aPre.length > 0 && bPre.length === 0) return -1;
  for (let i = 0; i < Math.max(aPre.length, bPre.length); i += 1) {
    const av = aPre[i];
    const bv = bPre[i];
    // A shorter prerelease list is older when the shared prefix is equal.
    if (av === undefined) return -1;
    if (bv === undefined) return 1;
    if (av === bv) continue;
    const an = parseInt(av, 10);
    const bn = parseInt(bv, 10);
    if (!Number.isNaN(an) && !Number.isNaN(bn)) return an - bn;
    // Numeric identifiers sort before alphanumeric ones.
    if (!Number.isNaN(an)) return -1;
    if (!Number.isNaN(bn)) return 1;
    return av < bv ? -1 : 1;
  }
  return 0;
};

/**
 * The latest published version of the Studio on npm, or null when the registry
 * is unreachable.
 *
 * Asked before `/studio` starts one, so a dashboard that is a release behind
 * can be upgraded rather than quietly running an old build.
 *
 * Reads the `beta` dist-tag rather than `latest`: the Studio is a prerelease, and
 * `latest` is whatever was last published without a tag — which on a project like
 * this is the first build, and it stays there. Comparing against it would mean the
 * upgrade prompt never fires, or fires for a downgrade.
 */
export const latestStudioVersion = async (
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 2_000,
): Promise<string | null> => {
  try {
    const response = await fetchImpl(`https://registry.npmjs.org/${STUDIO_PACKAGE}/${STUDIO_DIST_TAG}`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return null;
    const data = await response.json() as { version?: string };
    return typeof data.version === "string" ? data.version : null;
  } catch {
    return null;
  }
};
