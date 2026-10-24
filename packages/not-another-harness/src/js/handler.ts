/**
 * The route handler: HTTP in, HTTP out.
 *
 * ## Why there is no framework dependency
 *
 * A route handler is a function that takes a `Request` and returns a
 * `Response`. That is the Web platform's contract, and it is the same contract
 * Next.js, Hono, Remix, SvelteKit and Astro's server endpoints speak.
 *
 * So this package does not depend on any of them. It does not need to: the
 * parts of a framework that would matter here are the parts that are not about
 * the request at all — Next.js's `after` for work that outlives a response,
 * and the route segment config (`export const runtime`, `maxDuration`), which
 * the *application* writes in its own `route.ts` and which this package has no
 * business setting.
 *
 * The cost of that choice is that a caller has to write two lines in their
 * route file. The benefit is that this package does not break when a framework
 * moves, and that the same runtime can be mounted somewhere that is not
 * Next.js at all.
 *
 * ## What an application writes
 *
 * ```ts
 * // app/api/nah/route.ts
 * import { createNahHandler } from "not-another-harness/js";
 *
 * export const runtime = "nodejs";
 * export const maxDuration = 300;
 *
 * export const { GET, POST } = createNahHandler({
 *   agent: ({ sessionId }) => ({ model, system, tools }),
 * });
 * ```
 */

import { createNahRuntime } from "./runtime.js";
import type { NahRuntime, NahRuntimeOptions } from "./runtime.js";
import type {
	NahActionResponse,
	NahPostRequest,
	NahTurnRequest,
} from "./types.js";

/** The largest request body the handler will read. Default 1 MiB. */
const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;

export type NahHandlerOptions = NahRuntimeOptions & {
	/** Resolve trusted context after the host application authenticates the request. */
	requestContext?: (request: Request) => unknown | Promise<unknown>;
	/**
	 * How large a request body may be.
	 *
	 * A turn's body is small — a message, a decision, a value — so the default
	 * is generous. It is a limit rather than a constant because a body limit is
	 * the cheapest denial-of-service guard a route handler can have, and the
	 * cheapest way for an application to raise it deliberately.
	 */
	maxBodyBytes?: number;
};

/** The handlers a route file exports. */
export type NahRouteHandlers = {
	/** Follow a session: replay what was missed, then follow along live. */
	GET: (request: Request) => Response | Promise<Response>;
	/** Run a turn, steer a run, or stop one. */
	POST: (request: Request) => Response | Promise<Response>;
	/** The runtime, for anything the handlers do not cover. */
	runtime: NahRuntime;
};

class PayloadTooLarge extends Error {}
class BadRequest extends Error {}

const json = (body: unknown, status = 200): Response =>
	Response.json(body as Record<string, unknown>, { status });

/**
 * Read and parse a JSON body, with a size limit.
 *
 * The limit is enforced while reading rather than after, because a body that
 * is too large has already cost the memory by the time it is fully read.
 */
const readJson = async (
	request: Request,
	maxBytes: number,
): Promise<unknown> => {
	const declared = Number(request.headers.get("content-length") ?? "");
	if (Number.isFinite(declared) && declared > maxBytes) {
		throw new PayloadTooLarge();
	}

	if (!request.body) return {};

	const reader = request.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;

	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		total += value.byteLength;
		if (total > maxBytes) {
			await reader.cancel().catch(() => undefined);
			throw new PayloadTooLarge();
		}
		chunks.push(value);
	}

	if (total === 0) return {};

	const buffer = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		buffer.set(chunk, offset);
		offset += chunk.byteLength;
	}

	const text = new TextDecoder().decode(buffer);
	if (text.trim() === "") return {};

	try {
		return JSON.parse(text);
	} catch {
		throw new BadRequest("The body is not valid JSON.");
	}
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Mount the runtime on a route.
 *
 * The returned object is what a route file exports. `GET` follows a session
 * and `POST` runs turns, so a client can either read the stream it opened or
 * come back later and pick up where it left off.
 */
export const createNahHandler = (options: NahHandlerOptions): NahRouteHandlers => {
	const runtime = createNahRuntime(options);
	const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;

	const POST = async (request: Request): Promise<Response> => {
		let body: unknown;
		try {
			body = await readJson(request, maxBodyBytes);
		} catch (error) {
			if (error instanceof PayloadTooLarge) {
				return json(
					{ error: "The request body is too large." },
					413,
				);
			}
			if (error instanceof BadRequest) {
				return json({ error: error.message }, 400);
			}
			throw error;
		}

		if (!isRecord(body)) {
			return json({ error: "The body must be a JSON object." }, 400);
		}

		const payload = body as NahPostRequest;

		if (payload.action === "steer") {
			const result = runtime.steer(payload.sessionId, payload.text);
			return json(result satisfies NahActionResponse, result.ok ? 200 : 409);
		}

		if (payload.action === "abort") {
			const result = runtime.abort(payload.sessionId);
			return json(result satisfies NahActionResponse, result.ok ? 200 : 409);
		}

		const turn: NahTurnRequest = {
			...(payload.sessionId === undefined
				? {}
				: { sessionId: String(payload.sessionId) }),
			...(payload.input === undefined ? {} : { input: String(payload.input) }),
			...(payload.approvals === undefined
				? {}
				: { approvals: payload.approvals }),
			...(payload.resumeData === undefined
				? {}
				: { resumeData: payload.resumeData }),
		};

		// The request's own signal is the run's abort signal: a client that
		// closes the tab stops the run rather than leaving it burning tokens
		// for an answer nobody will read.
		const requestContext = await options.requestContext?.(request);
		return runtime.turn(turn, {
			signal: request.signal,
			...(requestContext === undefined ? {} : { requestContext }),
		});
	};

	const GET = async (request: Request): Promise<Response> =>
		runtime.follow(request);

	return { GET, POST, runtime };
};
