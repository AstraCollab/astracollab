/**
 * Starting agents.
 *
 * The Studio does not implement an agent. It starts the real one — a `nah`
 * process, given a prompt — and watches it the same way it watches any other
 * agent, because that agent registers itself and pushes its own traces like
 * everything else. There is no privileged path into a running agent, which is
 * what keeps "the dashboard can see the agent" from becoming "the dashboard can
 * be the agent".
 *
 * One prompt per launch, so a launch is a task with an end: the process runs,
 * produces traces, exits, and the row says so. A long-lived supervised agent is a
 * different feature, and pretending a one-shot is one would make the status
 * column lie.
 */
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { basename } from "node:path";

import type { StudioStore } from "./store.js";
import type { Agent } from "./wire.js";

export type Launcher = {
	/** The thing being spawned: a `nah` binary, or this process's own node. */
	command: string;
	/** Arguments that always come first, e.g. the script path when running under node. */
	prefixArgs: string[];
	/** Human-readable form, for the UI. */
	label: string;
};

export type LaunchRequest = {
	store: StudioStore;
	agentId: string;
	cwd: string;
	prompt: string;
	model?: string;
	permissions?: string;
};

const isScript = (path: string): boolean => /\.(c|m)?js$/i.test(path);

/**
 * Find the `nah` to launch.
 *
 * Checked in the order that produces the version you are debugging: the binary
 * recorded by the `nah` that started this Studio, then a `nah` on PATH. The
 * recorded one matters because a global `nah` from npm and a `nah` built from
 * source send different trace shapes, and a dashboard that quietly launched the
 * other one would show you runs you never made.
 *
 * A recorded path ending in `.js` is a script rather than a binary — which is what
 * `argv[1]` is for a dev checkout or an `npx` run — so it is launched through this
 * process's own node. Depending on the file's executable bit would work on a
 * globally installed CLI and fail on every checkout, which is the opposite of the
 * order that matters.
 */
export const resolveNahBinary = (
	recorded: string | undefined,
	options: {
		platform?: NodeJS.Platform;
		execPath?: string;
		which?: (command: string) => string | undefined;
	} = {},
): Launcher | null => {
	const platform = options.platform ?? process.platform;
	const which = options.which ?? whichCommand;
	if (recorded) {
		return isScript(recorded)
			? {
					command: options.execPath ?? process.execPath,
					prefixArgs: [recorded],
					label: `${recorded}`,
				}
			: { command: recorded, prefixArgs: [], label: recorded };
	}
	const found = which(platform === "win32" ? "nah.cmd" : "nah");
	return found ? { command: found, prefixArgs: [], label: found } : null;
};

const whichCommand = (command: string): string | undefined => {
	const probe = spawnSync(
		process.platform === "win32" ? "where" : "command",
		process.platform === "win32" ? [command] : ["-v", command],
		{
			stdio: ["ignore", "pipe", "ignore"],
			encoding: "utf8",
		},
	);
	if (probe.status !== 0) return undefined;
	const first = probe.stdout.split("\n")[0]?.trim();
	return first && first.length > 0 ? first : undefined;
};

/**
 * Argument list for one launched agent.
 *
 * `--mode json` because the output is a machine-readable event stream, not a
 * terminal: this process has no TTY, so the pretty renderer would have nothing to
 * render into and the agent's reasoning would be invisible in the log pane.
 */
export const launchArgs = (
	request: Pick<LaunchRequest, "prompt" | "model" | "permissions">,
): string[] => {
	const args = ["--mode", "json"];
	if (request.model) args.push("--model", request.model);
	if (request.permissions) args.push("--permissions", request.permissions);
	args.push(request.prompt);
	return args;
};

export type LaunchResult = { started: boolean; reason?: string; pid?: number };

export const launchAgent = async (
	launcher: Launcher,
	request: LaunchRequest,
	options: { spawnProcess?: typeof spawn } = {},
): Promise<LaunchResult> => {
	const spawnProcess = options.spawnProcess ?? spawn;
	const { store, agentId } = request;

	// The child finds the Studio the same way any other agent does: through the
	// endpoint file `nah` writes. The name is passed explicitly so a launch reads
	// as itself in the list rather than as whatever the directory is called.
	const env = {
		...process.env,
		NAH_AGENT_NAME: store.getAgent(agentId)?.name ?? basename(request.cwd),
		NAH_TELEMETRY: "on",
	};

	// Typed as the general `ChildProcess` rather than the `WithoutNullStreams`
	// variant: stdin is deliberately ignored, and narrowing to a type that has one
	// is a cast that lies about the thing it describes.
	let child: ChildProcess;
	try {
		child = spawnProcess(
			launcher.command,
			[...launcher.prefixArgs, ...launchArgs(request)],
			{
				cwd: request.cwd,
				env,
				stdio: ["ignore", "pipe", "pipe"],
				windowsHide: true,
			},
		);
	} catch (error) {
		return {
			started: false,
			reason: error instanceof Error ? error.message : String(error),
		};
	}

	store.appendAgentLog(agentId, {
		stream: "system",
		text: `started ${launcher.label} in ${request.cwd}`,
	});

	// Line-buffered, because a `--mode json` agent emits one JSON object per line
	// and a log pane full of half-objects is unreadable.
	pipeLines(child.stdout, (text) =>
		store.appendAgentLog(agentId, { stream: "stdout", text }),
	);
	pipeLines(child.stderr, (text) =>
		store.appendAgentLog(agentId, { stream: "stderr", text }),
	);

	// `spawn` means the process exists; `error` means it never did, and the
	// difference is the whole answer to this request. Waiting for `close` instead
	// would hold the HTTP response open for the length of the task.
	const started = await new Promise<LaunchResult>((resolve) => {
		child.once("spawn", () =>
			resolve({
				started: true,
				...(child.pid === undefined ? {} : { pid: child.pid }),
			}),
		);
		child.once("error", (error) => {
			store.setAgentState(agentId, { status: "failed" });
			store.appendAgentLog(agentId, { stream: "system", text: error.message });
			resolve({ started: false, reason: error.message });
		});
	});

	if (started.started) {
		// The row the dashboard watches from here on: the process updates it as it
		// goes, and so does the live stream.
		store.setAgentState(agentId, { status: "running" });
	}

	// From here the process reports on itself. The exit is recorded whatever the
	// request already returned, because a launch that fails a minute later is the
	// case worth seeing in the log.
	child.once("close", (code, signal) => {
		const how = signal ? `signal ${signal}` : `exit ${code ?? 0}`;
		store.appendAgentLog(agentId, {
			stream: "system",
			text: `finished: ${how}`,
		});
		store.setAgentState(agentId, {
			status: code === 0 ? "exited" : "failed",
			exitCode: code ?? (signal ? 1 : 0),
		});
	});

	return started;
};

export type StopResult = { stopped: boolean; reason?: string };

/**
 * Ask a launched agent to stop.
 *
 * `SIGTERM` first, because a `nah` process restores the terminal on the way out
 * and `SIGKILL` would leave an alternate screen behind. Only agents the Studio
 * started are eligible, and the server checks the host before calling this.
 */
export const stopAgentProcess = (
	agent: Agent,
	store: StudioStore,
): StopResult => {
	if (agent.source !== "launch")
		return {
			stopped: false,
			reason: "that agent was started outside the Studio",
		};
	if (agent.pid === null)
		return { stopped: false, reason: "no pid recorded for that agent" };
	try {
		process.kill(agent.pid, "SIGTERM");
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		// Already gone is the outcome the caller wanted, not a failure.
		if ((error as NodeJS.ErrnoException).code === "ESRCH") {
			store.setAgentState(agent.id, { status: "stopped" });
			return { stopped: true };
		}
		return { stopped: false, reason: message };
	}
	store.setAgentState(agent.id, { status: "stopped" });
	store.appendAgentLog(agent.id, {
		stream: "system",
		text: "stopped by the Studio",
	});
	return { stopped: true };
};

const pipeLines = (
	stream: NodeJS.ReadableStream | null,
	onLine: (text: string) => void,
): void => {
	if (!stream) return;
	let pending = "";
	stream.setEncoding?.("utf8");
	stream.on("data", (chunk: string | Buffer) => {
		pending += typeof chunk === "string" ? chunk : chunk.toString("utf8");
		const lines = pending.split("\n");
		// The last element is the incomplete remainder, and is held until its
		// newline arrives.
		pending = lines.pop() ?? "";
		for (const line of lines) onLine(line);
	});
	stream.on("end", () => {
		if (pending.length > 0) onLine(pending);
		pending = "";
	});
};
