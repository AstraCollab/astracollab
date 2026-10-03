/**
 * Where a running Studio announces itself.
 *
 * One small JSON file, written by the Studio, read by every `nah` on the
 * machine. It is the whole discovery story: an agent that finds this file sends
 * its traces there, and an agent that does not find it sends nothing anywhere.
 * That is what makes "turn on telemetry by starting the Studio" an honest default
 * rather than a switch nobody remembered to set.
 *
 * The file is written 0600 because it holds the token, and the token is what
 * stands between a colleague on the LAN and the contents of your prompts.
 */
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as nodePath from "node:path";

export type StudioEndpoint = {
	/** Base URL, e.g. `http://127.0.0.1:4111`. */
	url: string;
	/** Required only when the Studio is not bound to loopback. */
	token?: string;
	/** The Studio's pid, so a stale file can be told from a live one. */
	pid: number;
	startedAt: number;
	version: string;
	/**
	 * The `nah` binary that started this Studio, if it was started by one.
	 *
	 * Recorded so the Studio launches the same build the user is running. A global
	 * `nah` from npm and a `nah` built from source produce different traces, and a
	 * dashboard silently watching the wrong one is worse than no dashboard.
	 */
	nahBin?: string;
	/** Directory the Studio was pointed at, for the chat tab and experiments. */
	cwd?: string;
};

export const endpointPath = (home: string = os.homedir()): string =>
	nodePath.join(home, ".nah", "studio.json");

/**
 * Read the endpoint, or null when there is not one.
 *
 * Never throws: every caller treats a missing or corrupt file as "no Studio",
 * because a dashboard that cannot start should not be a dashboard that cannot be
 * read from either.
 */
export const readEndpoint = async (
	path: string = endpointPath(),
): Promise<StudioEndpoint | null> => {
	try {
		const parsed = JSON.parse(
			await fs.readFile(path, "utf8"),
		) as Partial<StudioEndpoint>;
		if (typeof parsed.url !== "string" || typeof parsed.pid !== "number")
			return null;
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

/** Write it atomically, so an agent never reads half a file. */
export const writeEndpoint = async (
	endpoint: StudioEndpoint,
	path: string = endpointPath(),
): Promise<void> => {
	await fs.mkdir(nodePath.dirname(path), { recursive: true, mode: 0o700 });
	const temporaryPath = `${path}.${process.pid}.tmp`;
	await fs.writeFile(temporaryPath, `${JSON.stringify(endpoint, null, 2)}\n`, {
		mode: 0o600,
	});
	await fs.rename(temporaryPath, path);
	await fs.chmod(path, 0o600).catch(() => undefined);
};

/**
 * Remove it, but only if it is still ours.
 *
 * Two Studios on one machine is a mistake, not a scenario; whichever exits first
 * would otherwise delete the other's file and leave every agent talking to a
 * closed port.
 */
export const clearEndpoint = async (
	pid: number,
	path: string = endpointPath(),
): Promise<void> => {
	const existing = await readEndpoint(path);
	if (existing && existing.pid !== pid) return;
	await fs.rm(path, { force: true });
};

/** Whether a process is still running. Signals 0: exists, and we may signal it. */
export const isProcessAlive = (pid: number): boolean => {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		// eslint-disable-next-line no-empty -- the call is the test; it throws ESRCH when gone.
		process.kill(pid, 0);
		return true;
	} catch (error) {
		// EPERM means it exists and belongs to somebody else, which still counts as
		// alive for our purposes.
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
};

/**
 * The Studio to talk to, or null.
 *
 * A file whose process is gone is not an endpoint. The alternative is every agent
 * on the machine retrying a dead port for as long as the file survives, and a
 * studio the user stopped an hour ago still claiming to be there.
 */
export const liveEndpoint = async (
	path: string = endpointPath(),
): Promise<StudioEndpoint | null> => {
	const endpoint = await readEndpoint(path);
	if (!endpoint) return null;
	return isProcessAlive(endpoint.pid) ? endpoint : null;
};
