import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
/**
 * The Studio server.
 *
 * `node:http` and nothing else. A framework would add a dependency tree to a
 * package that ships a binary, for routing that here is fifteen routes over a
 * prefix, and the whole surface is local: a developer UI reading from a file on
 * the same machine. That constraint is also the security model — see `guard`.
 */
import {
	type IncomingMessage,
	type Server,
	type ServerResponse,
	createServer,
} from "node:http";
import { hostname } from "node:os";
import { extname, join, normalize, resolve, sep } from "node:path";

import {
	type Scorer,
	calledToolScorer,
	includesScorer,
	notRefusedScorer,
	runOne,
	summarize,
} from "./evals.js";
import {
	type Launcher,
	launchAgent,
	resolveNahBinary,
	stopAgentProcess,
} from "./launcher.js";
import type { StoreEvent, StudioStore } from "./store.js";
import { type StreamHub, createStreamHub } from "./stream.js";
import type { IngestPayload, StreamEvent } from "./wire.js";
import type { WorkflowCatalog, WorkflowRuns } from "./workflows.js";

/** How long without a heartbeat before an agent is drawn as idle. */
const AGENT_LIVENESS_MS = 30_000;

export type StudioServerOptions = {
	store: StudioStore;
	/**
	 * Directory holding the built Studio (`index.html` plus hashed assets).
	 *
	 * The UI is built by the package's own second Vite pass into `dist/ui`, so the
	 * server serves bytes from beside its entry point rather than shipping a
	 * second copy of the source.
	 */
	assetDir?: string;
	port?: number;
	host?: string;
	/** Reuse an already-listening server in tests. */
	server?: Server;
	/**
	 * Runs one prompt through the real agent, used by the chat tab and by
	 * experiments. Supplied by `run.ts`, which owns model resolution.
	 */
	execute?: (input: string) => Promise<{
		output: string;
		toolsCalled: string[];
		filesChanged: string[];
		traceId?: string;
		/**
		 * Why the run stopped short. Optional so an `execute` written before
		 * stops existed still typechecks; absent means the run finished.
		 */
		stopNotice?: string;
	}>;
	/** Model the server is running, recorded on experiments. */
	model?: string;
	/**
	 * Shared secret for every request. Set when the server is not bound to
	 * loopback, because the store holds prompts, file paths and tool output.
	 */
	token?: string;
	/**
	 * Spawning agents. Absent in tests and whenever no `nah` binary can be found,
	 * in which case the launch route reports that instead of pretending.
	 */
	launcher?: Launcher;
	/** The live event stream. Supplied by `startStudioServer`, which owns its lifetime. */
	stream?: StreamHub;
	/** The directory the built-in agent works in, reported by `/api/info`. */
	cwd?: string;
	/**
	 * The workspace's workflows and the runs this server is making of them. Absent
	 * in tests and whenever no model is configured, in which case the workflow
	 * routes report that instead of pretending a run started.
	 */
	workflows?: { catalog: WorkflowCatalog; runs: WorkflowRuns };
};

// Inlined at build time by vite define, so the published binary can name its own
// version without reading its package.json off disk.
declare const __NAH_STUDIO_VERSION__: string;

type Handler = (request: {
	method: string;
	path: string;
	query: URLSearchParams;
	body: unknown;
	store: StudioStore;
	options: StudioServerOptions;
	/** The live stream writes to this itself; every other route leaves it alone. */
	response: ServerResponse;
}) => Promise<unknown | undefined>;

/**
 * Refuse everything not from loopback unless a token was supplied.
 *
 * Bound to 0.0.0.0 by default so a container or a colleague on the LAN can reach
 * it — and the store is full of things you did not intend to publish. A token is
 * then *required*, because the alternative is a debugging UI that serves a
 * stranger the contents of your terminal.
 */
const isLoopback = (request: IncomingMessage): boolean => {
	const address = request.socket.remoteAddress ?? "";
	return (
		address === "127.0.0.1" ||
		address === "::1" ||
		address === "::ffff:127.0.0.1"
	);
};

const readBody = async (request: IncomingMessage): Promise<unknown> => {
	const chunks: Buffer[] = [];
	for await (const chunk of request)
		chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
	const raw = Buffer.concat(chunks).toString("utf8");
	if (raw.trim() === "") return undefined;
	try {
		return JSON.parse(raw);
	} catch {
		return undefined;
	}
};

/**
 * Every route, keyed by `METHOD /path`.
 *
 * A flat map rather than a router: the whole API is visible on one screen, and a
 * new route is one line instead of a matching branch somewhere.
 */
const routes: Record<string, Handler> = {
	"GET /api/health": async () => ({ ok: true, service: "nah-studio" }),

	/**
	 * What this server is.
	 *
	 * Enough for the UI to be honest about itself: which directory it is watching,
	 * which build it is, and whether it can start agents — which is the difference
	 * between a form that works and a button that quietly does nothing.
	 */
	"GET /api/info": async ({ options }) => ({
		service: "nah-studio",
		version:
			typeof __NAH_STUDIO_VERSION__ === "string"
				? __NAH_STUDIO_VERSION__
				: "0.0.0",
		cwd: options.cwd ?? "",
		model: options.model ?? null,
		launcher: {
			available: Boolean(options.launcher),
			command: options.launcher?.label ?? null,
		},
	}),

	"GET /api/overview": async ({ store, query }) => ({
		...store.overview(agentScope(query)),
		...(query.get("buckets")
			? {
					timeseries: store.timeseries(
						Number(query.get("buckets")),
						agentScope(query),
					),
				}
			: {}),
	}),

	"GET /api/tools": async ({ store, query }) =>
		store.toolStats(agentScope(query)),

	"GET /api/traces": async ({ store, query }) =>
		store.listTraces({
			// A run whose agent stopped reporting is over, whatever its row says. See
			// `Store.ageInterrupted`.
			livenessMs: AGENT_LIVENESS_MS,
			limit: Number(query.get("limit") ?? 50),
			...(query.get("search") ? { search: query.get("search")! } : {}),
			...(query.get("status") ? { status: query.get("status")! } : {}),
			...(query.get("tag") ? { tag: query.get("tag")! } : {}),
			...(query.get("agentId") ? { agentId: query.get("agentId")! } : {}),
			...(query.get("since") ? { since: Number(query.get("since")) } : {}),
			...(query.get("until") ? { until: Number(query.get("until")) } : {}),
			...(query.get("sort")
				? { sort: query.get("sort") as "startTime" | "name" | "costUsd" }
				: {}),
			...(query.get("order")
				? { order: query.get("order") as "asc" | "desc" }
				: {}),
		}),

	"GET /api/traces/:id": async ({ store, path }) => {
		const found = store.getTrace(path.split("/").pop()!, {
			livenessMs: AGENT_LIVENESS_MS,
		});
		// 404 as null: the UI distinguishes "no such trace" from "server broke", and
		// a null body is how it says so without parsing a message.
		return found ?? null;
	},

	/**
	 * The ingest endpoint every agent pushes to.
	 *
	 * `{ agent, trace, spans }`, and the agent is optional: the built-in agent that
	 * answers the chat tab runs inside this process and has already been written to
	 * the store directly. A remote agent's registration is applied first, so a
	 * client that pushes a trace without having registered still ends up attributed
	 * to something.
	 */
	"POST /api/traces": async ({ store, body }) => {
		const payload = body as IngestPayload;
		if (!payload?.trace || !Array.isArray(payload.spans))
			return { error: "expected { trace, spans }" };
		const agentId = payload.agent
			? store.registerAgent(payload.agent).id
			: null;
		/**
		 * `final: false` means a run still in progress, and takes the merge path so
		 * a partial upload cannot delete the spans it did not carry.
		 *
		 * Only an explicit `false` counts. Every caller before this flag existed sent
		 * a finished trace with no flag at all, and reading that as "live" would
		 * replace completed traces with a prefix of themselves.
		 */
		if (payload.final === false)
			store.appendSpans(payload.trace, payload.spans, agentId);
		else store.saveTrace(payload.trace, payload.spans, agentId);
		if (agentId) store.setAgentState(agentId, { status: "running" });
		return { ok: true, id: payload.trace.id, ...(agentId ? { agentId } : {}) };
	},

	"GET /api/agents": async ({ store, query }) =>
		store.listAgents({
			runningBefore: Date.now() - AGENT_LIVENESS_MS,
			...(query.get("cwd") ? { cwd: query.get("cwd")! } : {}),
		}),

	"GET /api/agents/:id": async ({ store, path }) =>
		store.getAgent(path.split("/").pop()!) ?? null,

	/**
	 * Register or heartbeat.
	 *
	 * One route for both because a client cannot know whether the Studio it found
	 * is one it has already met: posting the same registration twice is the whole
	 * protocol, and the store's answer is idempotent.
	 */
	"POST /api/agents": async ({ store, body }) => {
		const payload = body as {
			cwd?: string;
			id?: string;
			name?: string;
			host?: string;
			pid?: number;
			model?: string;
			version?: string;
			status?: string;
			metadata?: Record<string, unknown>;
		};
		if (!payload?.cwd) return { error: "expected { cwd, name?, model? }" };
		const agent = store.registerAgent({
			...(payload.id === undefined ? {} : { id: payload.id }),
			...(payload.name === undefined ? {} : { name: payload.name }),
			cwd: payload.cwd,
			...(payload.host === undefined ? {} : { host: payload.host }),
			...(payload.pid === undefined ? {} : { pid: payload.pid }),
			model: payload.model ?? null,
			version: payload.version ?? null,
			source: "session",
			...(payload.status === undefined
				? {}
				: { status: payload.status as never }),
			...(payload.metadata === undefined ? {} : { metadata: payload.metadata }),
		});
		return { ok: true, agent };
	},

	"DELETE /api/agents/:id": async ({ store, path }) => ({
		ok: store.deleteAgent(path.split("/").pop()!),
	}),

	"POST /api/agents/:id/stop": async ({ store, path, options }) => {
		const id = path.split("/").at(-2)!;
		const agent = store.getAgent(id);
		if (!agent) return { error: "no such agent" };
		// Only ever a process this machine started. An agent registered by a session
		// somewhere else is a colleague's terminal, and a browser button is not
		// consent to kill it.
		if (agent.host !== hostname()) {
			return {
				error: `${agent.name} is running on ${agent.host}; stop it there`,
			};
		}
		const stopped = options.launcher
			? stopAgentProcess(agent, store)
			: { stopped: false, reason: "this server cannot stop processes" };
		return {
			ok: stopped.stopped,
			...(stopped.reason === undefined ? {} : { error: stopped.reason }),
		};
	},

	"GET /api/agents/:id/logs": async ({ store, path, query }) =>
		store.listAgentLogs(
			path.split("/").at(-2)!,
			Number(query.get("limit") ?? 500),
		),

	/**
	 * Start an agent.
	 *
	 * A real `nah` process, detached, given one prompt — so it registers itself,
	 * pushes its own traces and reports its own errors, and the Studio has no
	 * privileged path into it. The row exists before the process does, which is
	 * what makes a failed launch visible instead of a request that never returns.
	 */
	"POST /api/agents/launch": async ({ store, body, options }) => {
		const payload = body as {
			cwd?: string;
			name?: string;
			prompt?: string;
			model?: string;
			permissions?: string;
		};
		if (!payload?.cwd) return { error: "expected { cwd, prompt }" };
		if (!payload.prompt?.trim()) return { error: "expected { cwd, prompt }" };
		if (!options.launcher)
			return {
				error:
					"no nah binary found on this machine, so the Studio cannot start agents",
			};
		const agent = store.registerAgent({
			...(payload.name === undefined ? {} : { name: payload.name }),
			cwd: payload.cwd,
			host: hostname(),
			status: "starting",
			source: "launch",
			model: payload.model ?? null,
			metadata: {
				prompt: payload.prompt,
				...(payload.permissions === undefined
					? {}
					: { permissions: payload.permissions }),
			},
		});
		const started = await launchAgent(options.launcher, {
			store,
			agentId: agent.id,
			cwd: payload.cwd,
			prompt: payload.prompt,
			...(payload.model === undefined ? {} : { model: payload.model }),
			...(payload.permissions === undefined
				? {}
				: { permissions: payload.permissions }),
		});
		if (!started.started) {
			store.setAgentState(agent.id, { status: "failed" });
			store.appendAgentLog(agent.id, {
				stream: "system",
				text: started.reason ?? "could not start",
			});
			return { error: started.reason ?? "could not start the agent" };
		}
		return { ok: true, agent: store.getAgent(agent.id) };
	},

	/** Where the Studio would find a `nah` binary, for the UI to explain a failure. */
	"GET /api/launcher": async ({ options }) => ({
		available: Boolean(options.launcher),
		...(options.launcher === null || options.launcher === undefined
			? {}
			: { command: options.launcher.label }),
	}),

	"GET /api/messages": async ({ store, query }) =>
		store.listMessages({
			limit: Number(query.get("limit") ?? 100),
			...(query.get("traceId") ? { traceId: query.get("traceId")! } : {}),
		}),

	"POST /api/messages": async ({ store, body }) => {
		const message = body as {
			role: string;
			content: string;
			traceId?: string;
			agentId?: string;
		};
		if (!message?.content) return { error: "expected { role, content }" };
		const id = randomUUID();
		store.saveMessage({
			id,
			role: message.role ?? "user",
			content: message.content,
			...(message.traceId ? { traceId: message.traceId } : {}),
			...(message.agentId ? { agentId: message.agentId } : {}),
		});
		return { ok: true, id };
	},

	"POST /api/chat": async ({ body, store, options }) => {
		const payload = body as { message?: string };
		if (!payload?.message) return { error: "expected { message }" };
		if (!options.execute) return { error: "this server has no agent attached" };
		// Recorded even when the run fails: what was asked is the first thing anyone
		// wants when reading a broken conversation back.
		store.saveMessage({
			id: randomUUID(),
			role: "user",
			content: payload.message,
		});
		const result = await options.execute(payload.message);
		store.saveMessage({
			id: randomUUID(),
			role: "assistant",
			content: result.output,
			...(result.traceId ? { traceId: result.traceId } : {}),
		});
		return result;
	},

	"GET /api/datasets": async ({ store }) => store.listDatasets(),
	"GET /api/datasets/:id/items": async ({ store, path }) =>
		store.listDatasetItems(path.split("/").at(-2)!),

	"POST /api/datasets": async ({ store, body }) => {
		const payload = body as {
			name?: string;
			description?: string;
			id?: string;
			items?: Array<{ input: string; expected?: string }>;
		};
		if (!payload?.name) return { error: "expected { name }" };
		const dataset = store.createDataset({
			name: payload.name,
			...(payload.description ? { description: payload.description } : {}),
			...(payload.id ? { id: payload.id } : {}),
		});
		const added = payload.items?.length
			? store.addDatasetItems(dataset.id, payload.items)
			: 0;
		return { ok: true, ...dataset, items: added };
	},

	"POST /api/datasets/:id/items": async ({ store, path, body }) => {
		const datasetId = path.split("/").at(-2)!;
		const payload = body as {
			items?: Array<{ input: string; expected?: string }>;
		};
		if (!payload?.items?.length)
			return { error: "expected { items: [{ input }] }" };
		return { ok: true, added: store.addDatasetItems(datasetId, payload.items) };
	},

	"DELETE /api/datasets/:id": async ({ store, path }) => ({
		ok: store.deleteDataset(path.split("/").pop()!),
	}),

	"GET /api/scorers": async ({ store }) => store.listScorers(),

	"POST /api/experiments": async ({ store, body, options }) => {
		const payload = body as { datasetId?: string; scorerIds?: string[] };
		if (!payload?.datasetId) return { error: "expected { datasetId }" };
		const items = store.listDatasetItems(payload.datasetId);
		if (items.length === 0) return { error: "that dataset has no items" };
		// Captured into a local because narrowing on `options.execute` does not
		// survive into the closure below, where it would still be `| undefined`.
		const execute = options.execute;
		if (!execute)
			return {
				error:
					"this server has no agent attached, so it cannot run experiments",
			};

		const scorers = resolveScorers(store, payload.scorerIds ?? []);
		if (scorers.length === 0) return { error: "no scorers selected" };

		const experimentId = store.startExperiment({
			datasetId: payload.datasetId,
			model: options.model ?? "",
		});

		// Background, and answered immediately. A run over a real dataset takes
		// minutes, and a request that holds the connection open for that long looks
		// exactly like a hung server — so the caller gets an id and polls.
		void (async () => {
			const results = [];
			try {
				// Sequential, not concurrent. Evals exist to compare two configurations,
				// and two runs sharing a rate limit produce scores that differ for
				// reasons nobody will find in the data.
				for (const item of items) {
					const result = await runOne({
						item: {
							id: item.id,
							input: item.input,
							...(item.expected === undefined
								? {}
								: { expected: item.expected }),
						},
						scorers,
						execute: (input) => execute(input.input),
					});
					store.saveExperimentResult({ ...result, experimentId });
					results.push(result);
				}
				store.finishExperiment(experimentId, summarize(results));
			} catch (error) {
				store.finishExperiment(
					experimentId,
					summarize(results),
					error instanceof Error ? error.message : String(error),
				);
			}
		})();

		return { ok: true, id: experimentId };
	},

	"GET /api/experiments": async ({ store }) => store.listExperiments(),

	"GET /api/experiments/:id": async ({ store, path }) =>
		store.getExperiment(path.split("/").pop()!) ?? null,

	/**
	 * The live stream.
	 *
	 * The one route that does not answer and return: it hands the response to the
	 * hub and returns nothing, so the caller must not write a body afterwards.
	 */
	"GET /api/stream": async ({ options, response }) => {
		options.stream?.add(response);
		return undefined;
	},
};

/**
 * The agent a request is scoped to.
 *
 * One place, because every aggregate has to agree: an overview for one agent
 * next to a chart of every agent is the kind of mismatch nobody notices until a
 * number is wrong.
 */
const agentScope = (query: URLSearchParams): { agentId?: string } => {
	const agentId = query.get("agentId");
	return agentId ? { agentId } : {};
};

/** Opt-in scorers, resolved from the store by id. */
const resolveScorers = (store: StudioStore, ids: string[]): Scorer[] => {
	const available = store.listScorers();
	// Unknown ids are ignored rather than fatal: a scorer registered by a previous
	// run of the server is a normal state, not an error worth aborting an eval over.
	return ids
		.map((id) => available.find((scorer) => scorer.id === id))
		.filter((scorer): scorer is NonNullable<typeof scorer> => Boolean(scorer))
		.map((scorer) => registeredScorers.get(scorer.id))
		.filter((scorer): scorer is Scorer => Boolean(scorer));
};

/**
 * Scorers this process can actually run.
 *
 * A registry rather than instances in the database, because a scorer is code and
 * a database row cannot be code. The row carries the name and the description;
 * this map decides what runs.
 */
export const registeredScorers = new Map<string, Scorer>();

/** Register the scorers that need no model, so a fresh server has something to run. */
export const registerBuiltinScorers = (): void => {
	for (const scorer of [
		notRefusedScorer(),
		includesScorer(["TODO"], "mentions-todo"),
		calledToolScorer("read"),
	]) {
		registeredScorers.set(scorer.id, scorer);
	}
};

/**
 * Find the handler for a request.
 *
 * Exact matches win, then patterns where `:id` stands for any one segment. Kept
 * explicit rather than pulled from a router so the route table above stays the
 * whole API — the question "what can this server do" has one answer.
 */
const matchRoute = (method: string, pathname: string): Handler | undefined => {
	const exact = routes[`${method} ${pathname}`];
	if (exact) return exact;
	const segments = pathname.split("/").filter(Boolean);
	for (const [key, handler] of Object.entries(routes)) {
		const [routeMethod, routePath = ""] = key.split(" ");
		if (routeMethod !== method) continue;
		const routeSegments = routePath.split("/").filter(Boolean);
		if (routeSegments.length !== segments.length) continue;
		if (
			routeSegments.every(
				(segment, index) =>
					segment.startsWith(":") || segment === segments[index],
			)
		) {
			return handler;
		}
	}
	return undefined;
};

/** Only the handful of types a Vite build actually emits. */
const CONTENT_TYPES: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".mjs": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".svg": "image/svg+xml",
	".png": "image/png",
	".jpg": "image/jpeg",
	".webp": "image/webp",
	".ico": "image/x-icon",
	".woff": "font/woff",
	".woff2": "font/woff2",
	".map": "application/json; charset=utf-8",
};

/**
 * Serve a file from the built UI.
 *
 * The cache headers are the whole reason the UI is built rather than served as
 * source: Vite puts a content hash in every asset filename, so `/assets/*` is
 * safe to cache for a year and `index.html` must not be, or a deploy leaves
 * browsers pointing at assets that no longer exist.
 *
 * The path is resolved and then checked to still be inside the asset directory.
 * That is not paranoia about `..` — it is the difference between a path that can
 * only reach the UI and one that can read `~/.nah/config.json`.
 */
const serveAsset = (
	options: StudioServerOptions,
	pathname: string,
	response: ServerResponse,
): void => {
	const directory = options.assetDir;
	const relative =
		pathname === "/" || pathname === ""
			? "index.html"
			: pathname.replace(/^\/+/, "");
	if (!directory) {
		response.writeHead(503, { "content-type": "text/plain; charset=utf-8" });
		response.end(
			"The Studio UI was not built. Run `pnpm --filter @astracollab/nah-studio-ui build`.\n",
		);
		return;
	}

	const root = resolve(directory);
	const target = resolve(root, normalize(relative));
	if (target !== root && !target.startsWith(root + sep)) {
		response.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
		response.end("forbidden\n");
		return;
	}
	if (!existsSync(target) || !statSync(target).isFile()) {
		response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
		response.end("not found\n");
		return;
	}

	const body = readFileSync(target);
	const hashed = target.includes(`${sep}assets${sep}`);
	response.writeHead(200, {
		"content-type":
			CONTENT_TYPES[extname(target)] ?? "application/octet-stream",
		"content-length": body.byteLength,
		"cache-control": hashed
			? "public, max-age=31536000, immutable"
			: "no-cache",
	});
	response.end(body);
};

const send = (
	response: ServerResponse,
	status: number,
	payload: unknown,
): void => {
	const body = JSON.stringify(payload ?? null);
	response.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		"content-length": Buffer.byteLength(body),
	});
	response.end(body);
};

export const createStudioServer = (options: StudioServerOptions): Server => {
	const handler = async (
		request: IncomingMessage,
		response: ServerResponse,
	): Promise<void> => {
		const url = new URL(
			request.url ?? "/",
			`http://${request.headers.host ?? "localhost"}`,
		);
		const method = request.method ?? "GET";

		if (method === "OPTIONS") {
			response.writeHead(204, {
				"access-control-allow-origin": "*",
				"access-control-allow-headers": "content-type, authorization",
			});
			response.end();
			return;
		}

		// The gate, before anything is read or written.
		if (options.token) {
			const supplied =
				request.headers.authorization?.replace(/^Bearer\s+/i, "") ??
				url.searchParams.get("token") ??
				"";
			// Hashed and compared as hex: two Buffers are never `===`, so a naive
			// digest comparison would reject every token including the right one, and
			// hashing keeps the comparison from being timed apart.
			const ok =
				supplied.length === options.token.length &&
				createHash("sha256").update(supplied).digest("hex") ===
					createHash("sha256").update(options.token).digest("hex");
			if (!ok) {
				send(response, 401, { error: "unauthorized" });
				return;
			}
		} else if (!isLoopback(request)) {
			send(response, 403, {
				error:
					"refused a non-local request without a token. This store holds prompts and tool output; set NAH_STUDIO_TOKEN.",
			});
			return;
		}

		if (
			url.pathname === "/" ||
			url.pathname === "/index.html" ||
			!url.pathname.startsWith("/api/")
		) {
			serveAsset(options, url.pathname, response);
			return;
		}

		if (!url.pathname.startsWith("/api/")) {
			send(response, 404, { error: "not found" });
			return;
		}

		// Exact matches beat the `:id` patterns, so `/api/traces` is the list and
		// `/api/traces/abc` is the one trace.
		const matched = matchRoute(method, url.pathname);
		if (!matched) {
			send(response, 404, { error: `no route for ${method} ${url.pathname}` });
			return;
		}

		try {
			const result = await matched({
				method,
				path: url.pathname,
				query: url.searchParams,
				body:
					method === "POST" || method === "PUT"
						? await readBody(request)
						: undefined,
				store: options.store,
				options,
				response,
			});
			// A handler returning undefined means "handled, nothing to say" — except
			// for the event stream, which has already sent its headers and is holding
			// the response open. Writing a body onto it would end the client's
			// connection, which it cannot tell from a crash.
			if (result === undefined && response.headersSent) return;
			send(response, result === undefined ? 204 : 200, result);
		} catch (error) {
			// The message, not a stack: this is a local dev tool and the caller is a
			// person looking at a browser.
			if (response.headersSent) {
				response.end();
				return;
			}
			send(response, 500, {
				error: error instanceof Error ? error.message : String(error),
			});
		}
	};

	return options.server ?? createServer(handler);
};

export type StudioHandle = {
	server: Server;
	url: string;
	close(): Promise<void>;
};

export const startStudioServer = async (
	options: StudioServerOptions,
): Promise<StudioHandle> => {
	// The hub belongs to the server, not to the route: it has to outlive a single
	// request to fan one store write out to every open browser.
	const stream = createStreamHub(options.store, {
		livenessMs: AGENT_LIVENESS_MS,
	});
	const server = createStudioServer({ ...options, stream });
	const port = options.port ?? 4111;
	const host = options.host ?? "127.0.0.1";
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(port, host, () => {
			server.off("error", reject);
			resolve();
		});
	});
	const address = server.address();
	const bound =
		typeof address === "object" && address !== null ? address.port : port;
	return {
		server,
		url: `http://${host}:${bound}`,
		close: () =>
			new Promise<void>((resolve) => {
				// End the streams first: `server.close` waits for open connections, and
				// a dashboard left open would otherwise keep the process alive forever.
				stream.close();
				server.close(() => resolve());
				// Idle keep-alive sockets are not connections `close` waits for, and
				// they hold the port long after everything else has gone.
				server.closeIdleConnections?.();
			}),
	};
};
