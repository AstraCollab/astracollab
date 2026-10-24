import type { z } from "zod";
import { createNahHandler } from "./handler.js";
import type { NahHandlerOptions } from "./handler.js";
import type { Workflow, WorkflowRunStore } from "../workflow.js";
import { randomUUID } from "node:crypto";

export type NahServerAuthContext = unknown;
export type NahServerAuth = (request: Request) => NahServerAuthContext | Response | Promise<NahServerAuthContext | Response>;

export type NahServerToolContext = {
	request: Request;
	context: NahServerAuthContext;
	signal: AbortSignal;
};

/** A deliberately explicit endpoint definition for direct tool exposure. */
export type NahServerTool = {
	description: string;
	inputSchema?: z.ZodType;
	execute: (input: unknown, context: NahServerToolContext) => unknown | Promise<unknown>;
};

export type NahServerOptions = {
	/** Registered agent ids become `/agents/:agentId` endpoints. */
	agents?: Record<string, NahHandlerOptions>;
	/** Only tools listed here are callable as standalone HTTP endpoints. */
	tools?: Record<string, NahServerTool>;
	/** Registered workflows become `/workflows/:workflowId/runs` endpoints. */
	workflows?: Record<string, Workflow<any, any, any>>;
	/** Store for suspended workflow checkpoints. Use a shared durable implementation across server instances. */
	workflowRunStore?: WorkflowRunStore;
	/** Optional tenant/user partition for persisted workflow runs. */
	workflowRunScope?: (context: NahServerAuthContext) => string | undefined;
	/** Authenticate every API request and return trusted context for capabilities. */
	authenticate?: NahServerAuth;
	/** Base path for all routes. Defaults to `/api`. */
	prefix?: string;
	/** Maximum JSON body for direct tool and workflow calls. Defaults to 1 MiB. */
	maxBodyBytes?: number;
};

export type NahServer = {
	/** Handle one Web Request and return a Web Response. Mount in any compatible server. */
	handle(request: Request): Promise<Response>;
	/** The OpenAPI 3.1 document describing the registered endpoints. */
	openapi(): Record<string, unknown>;
};

const RUN_LEASE_MS = 30_000;
const LEASE_RENEW_MS = 10_000;

const withRunLease = async <T>(
	store: WorkflowRunStore,
	runId: string,
	scope: string | undefined,
	requestSignal: AbortSignal,
	work: (fencingToken: number, signal: AbortSignal) => Promise<T>,
): Promise<T | null> => {
	const lease = await store.claim(runId, randomUUID(), RUN_LEASE_MS, scope);
	if (!lease) return null;
	const leaseController = new AbortController();
	const signal = AbortSignal.any([requestSignal, leaseController.signal]);
	const timer = setInterval(() => {
		void store.renew(runId, lease.fencingToken, RUN_LEASE_MS, scope).then((renewed) => {
			if (!renewed) leaseController.abort(new Error("workflow run lease lost"));
		}).catch((error: unknown) => leaseController.abort(error));
	}, LEASE_RENEW_MS);
	try {
		return await work(lease.fencingToken, signal);
	} finally {
		clearInterval(timer);
		await store.release(runId, lease.fencingToken, scope);
	}
};

const json = (value: unknown, status = 200): Response =>
	Response.json(value as Record<string, unknown>, { status });

const isResponse = (value: unknown): value is Response => value instanceof Response;

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const validId = (id: string): boolean => /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id);

const decodeId = (value: string): string | null => {
	try {
		const id = decodeURIComponent(value);
		return validId(id) ? id : null;
	} catch {
		return null;
	}
};

const readJson = async (request: Request, maxBytes: number): Promise<unknown> => {
	const declared = Number(request.headers.get("content-length") ?? "");
	if (Number.isFinite(declared) && declared > maxBytes) throw new RangeError("body too large");
	const text = await request.text();
	if (new TextEncoder().encode(text).byteLength > maxBytes) throw new RangeError("body too large");
	try {
		return text.trim() ? JSON.parse(text) : {};
	} catch {
		throw new SyntaxError("body must be valid JSON");
	}
};

/**
 * Mount registered NAH agents, tools, and workflows on any Web `Request` →
 * `Response` server. The host retains ownership of its listener and middleware.
 */
export const createNahServer = (options: NahServerOptions): NahServer => {
	const prefix = `/${(options.prefix ?? "/api").split("/").filter(Boolean).join("/")}`;
	const maxBodyBytes = options.maxBodyBytes ?? 1024 * 1024;
	const contextByRequest = new WeakMap<Request, NahServerAuthContext>();
	const agents = new Map<string, ReturnType<typeof createNahHandler>>();
	for (const [id, handlerOptions] of Object.entries(options.agents ?? {})) {
		if (!validId(id)) throw new Error(`Invalid NAH agent id: ${id}`);
		agents.set(id, createNahHandler({
			...handlerOptions,
			requestContext: (request) => contextByRequest.get(request),
		}));
	}
	for (const id of Object.keys(options.tools ?? {})) {
		if (!validId(id)) throw new Error(`Invalid NAH tool id: ${id}`);
	}
	for (const id of Object.keys(options.workflows ?? {})) {
		if (!validId(id)) throw new Error(`Invalid NAH workflow id: ${id}`);
	}

	const handle = async (request: Request): Promise<Response> => {
		const url = new URL(request.url);
		const path = url.pathname.replace(/\/$/, "") || "/";
		if (path === `${prefix}/openapi.json` && request.method === "GET") {
			if (options.authenticate) {
				const auth = await options.authenticate(request);
				if (isResponse(auth)) return auth;
			}
			return json(openapi());
		}
		if (path === `${prefix}/health` && request.method === "GET") return json({ ok: true, service: "nah-server" });

		if (!path.startsWith(`${prefix}/`)) return json({ error: "not found" }, 404);
		let context: NahServerAuthContext;
		if (options.authenticate) {
			const auth = await options.authenticate(request);
			if (isResponse(auth)) return auth;
			context = auth;
		} else {
			context = undefined;
		}
		contextByRequest.set(request, context);

		const parts = path.slice(prefix.length + 1).split("/");
		const kind = parts[0];
		const id = parts[1] ? decodeId(parts[1]) : null;
		if (!id) return json({ error: "not found" }, 404);

		if (kind === "agents") {
			const registered = agents.get(id);
			if (!registered) return json({ error: "unknown agent" }, 404);
			if (parts.length === 2 && request.method === "POST") return registered.POST(request);
			if (parts.length === 2 && request.method === "GET") return registered.GET(request);
			return json({ error: "method or route not allowed" }, 405);
		}

		if (kind === "tools" && parts.length === 3 && parts[2] === "execute" && request.method === "POST") {
			const tool = options.tools?.[id];
			if (!tool) return json({ error: "unknown tool" }, 404);
			let input: unknown;
			try {
				input = await readJson(request, maxBodyBytes);
			} catch (error) {
				return json({ error: error instanceof RangeError ? error.message : "body must be valid JSON" }, error instanceof RangeError ? 413 : 400);
			}
			const parsed = tool.inputSchema?.safeParse(input);
			if (parsed && !parsed.success) return json({ error: "invalid tool input", issues: parsed.error.issues }, 400);
			try {
				const result = await tool.execute(parsed?.success ? parsed.data : input, { request, context, signal: request.signal });
				return json({ result });
			} catch (error) {
				return json({ error: error instanceof Error ? error.message.slice(0, 500) : "tool execution failed" }, 500);
			}
		}

		if (kind === "workflows" && parts.length === 3 && parts[2] === "runs" && request.method === "POST") {
			const workflow = options.workflows?.[id];
			if (!workflow) return json({ error: "unknown workflow" }, 404);
			let body: unknown;
			try {
				body = await readJson(request, maxBodyBytes);
			} catch (error) {
				return json({ error: error instanceof RangeError ? error.message : "body must be valid JSON" }, error instanceof RangeError ? 413 : 400);
			}
			if (!isRecord(body)) return json({ error: "body must be a JSON object" }, 400);
			try {
				const run = workflow.createRun();
				const scope = options.workflowRunScope?.(context);
				const execute = (fencingToken?: number, signal = request.signal) => run.start({
					inputData: body.input,
					context: { ...(isRecord(body.context) ? body.context : {}), requestContext: context },
					signal,
					fencingToken,
					onCheckpoint: options.workflowRunStore ? (snapshot) => options.workflowRunStore!.save(snapshot, scope, fencingToken) : undefined,
				});
				let result;
				if (options.workflowRunStore) {
					const leased = await withRunLease(options.workflowRunStore, run.runId, scope, request.signal, async (token, signal) => {
						const completed = await execute(token, signal);
						if (completed.status !== "suspended") await options.workflowRunStore!.delete(run.runId, scope, token);
						return completed;
					});
					if (!leased) return json({ error: "workflow run is already claimed" }, 409);
					result = leased;
				} else result = await execute();
				return json({ result });
			} catch (error) {
				return json({ error: error instanceof Error ? error.message.slice(0, 500) : "workflow run failed" }, 500);
			}
		}

		if (kind === "workflows" && parts.length === 3 && parts[2] === "runs" && request.method === "GET") {
			const workflow = options.workflows?.[id];
			if (!workflow) return json({ error: "unknown workflow" }, 404);
			if (!options.workflowRunStore) return json({ error: "workflow run persistence is not configured" }, 501);
			try {
				const scope = options.workflowRunScope?.(context);
				const runs = await options.workflowRunStore.list({ workflowId: id, scope });
				return json({ runs: runs.map(({ runId, workflowId, workflowVersion, input, state, steps, pending }) => ({ runId, workflowId, workflowVersion, input, state, steps, pending, status: "suspended" })) });
			} catch (error) {
				return json({ error: error instanceof Error ? error.message.slice(0, 500) : "could not list workflow runs" }, 500);
			}
		}

		if (kind === "workflows" && parts.length >= 4 && parts[2] === "runs") {
			const workflow = options.workflows?.[id];
			if (!workflow) return json({ error: "unknown workflow" }, 404);
			if (!options.workflowRunStore) return json({ error: "workflow run persistence is not configured" }, 501);
			const runId = decodeId(parts[3]!);
			if (!runId) return json({ error: "not found" }, 404);
			const scope = options.workflowRunScope?.(context);
			if (request.method === "GET" && parts.length === 4) {
				const snapshot = await options.workflowRunStore.load(runId, scope);
				if (!snapshot || snapshot.workflowId !== id) return json({ error: "unknown workflow run" }, 404);
				return json({ run: { ...snapshot, status: "suspended" } });
			}
			if (request.method === "POST" && parts.length === 5 && parts[4] === "resume") {
				let body: unknown;
				try { body = await readJson(request, maxBodyBytes); }
				catch (error) { return json({ error: error instanceof RangeError ? error.message : "body must be valid JSON" }, error instanceof RangeError ? 413 : 400); }
				const snapshot = await options.workflowRunStore.load(runId, scope);
				if (!snapshot || snapshot.workflowId !== id) return json({ error: "unknown workflow run" }, 404);
				try {
					const run = workflow.restoreRun(snapshot);
					const result = await run.resume({ resumeData: isRecord(body) ? body.resumeData : body, context: { requestContext: context }, signal: request.signal });
					if (result.status === "suspended") {
						const next = run.snapshot();
						if (next) await options.workflowRunStore.save(next, scope);
					} else await options.workflowRunStore.delete(runId, scope);
					return json({ result });
				} catch (error) {
					return json({ error: error instanceof Error ? error.message.slice(0, 500) : "workflow resume failed" }, 400);
				}
			}
		}

		return json({ error: "not found" }, 404);
	};

	const openapi = (): Record<string, unknown> => {
		const paths: Record<string, unknown> = {
			[`${prefix}/health`]: { get: { operationId: "health", responses: { "200": { description: "Server is ready" } } } },
		};
		for (const id of agents.keys()) {
			paths[`${prefix}/agents/${id}`] = {
				get: { operationId: `follow_${id}`, parameters: [{ name: "sessionId", in: "query", required: true, schema: { type: "string" } }, { name: "after", in: "query", schema: { type: "integer" } }], responses: { "200": { description: "Server-sent event stream" } } },
				post: { operationId: `turn_${id}`, requestBody: { required: true, content: { "application/json": { schema: { type: "object", properties: { sessionId: { type: "string" }, input: { type: "string" }, approvals: { type: "object" }, resumeData: { type: "object" } } } } } }, responses: { "200": { description: "Server-sent event stream" } } },
			};
		}
		for (const [id, tool] of Object.entries(options.tools ?? {})) {
			paths[`${prefix}/tools/${id}/execute`] = { post: { operationId: `execute_${id}`, summary: tool.description, requestBody: { required: true, content: { "application/json": { schema: tool.inputSchema ? { description: "Validated by the registered tool input schema" } : { type: "object" } } } }, responses: { "200": { description: "Tool result" }, "400": { description: "Invalid input" } } } };
		}
		for (const [id, workflow] of Object.entries(options.workflows ?? {})) {
			paths[`${prefix}/workflows/${id}/runs`] = {
				get: {
					operationId: `list_${id}_runs`,
					summary: `List suspended ${id} runs`,
					responses: { "200": { description: "Suspended workflow runs" } },
				},
				post: {
					operationId: `run_${id}`,
					summary: workflow.description,
					requestBody: { required: true, content: { "application/json": { schema: { type: "object", properties: { input: { description: "Workflow input" }, context: { type: "object" } } } } } },
					responses: { "200": { description: "Workflow result; suspended runs are persisted when a run store is configured" } },
				},
			};
			paths[`${prefix}/workflows/${id}/runs/{runId}`] = {
				get: {
					operationId: `get_${id}_run`,
					parameters: [{ name: "runId", in: "path", required: true, schema: { type: "string" } }],
					responses: { "200": { description: "Suspended workflow checkpoint" }, "404": { description: "Run not found" } },
				},
			};
			paths[`${prefix}/workflows/${id}/runs/{runId}/resume`] = {
				post: {
					operationId: `resume_${id}_run`,
					parameters: [{ name: "runId", in: "path", required: true, schema: { type: "string" } }],
					requestBody: { required: true, content: { "application/json": { schema: { type: "object", properties: { resumeData: {} } } } } },
					responses: { "200": { description: "Resumed workflow result" }, "404": { description: "Run not found" } },
				},
			};
		}
		return { openapi: "3.1.0", info: { title: "NAH Server API", version: "1.0.0" }, paths };
	};

	return { handle, openapi };
};
