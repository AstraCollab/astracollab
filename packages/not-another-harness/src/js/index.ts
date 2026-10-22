/**
 * `not-another-harness/js` — the Web runtime.
 *
 * The server half. The browser half is `not-another-harness/js/client`, which is a separate
 * entry point so that React never reaches a server bundle.
 *
 * The server half knows nothing about any framework: it takes a `Request` and
 * returns a `Response`, which is the contract a route handler, a Hono app and
 * a Worker all already speak.
 */

export { createNahRuntime } from "./runtime.js";
export type {
	NahAgentContext,
	NahAgentFactory,
	NahAgentSpec,
	NahRuntime,
	NahRuntimeOptions,
	NahTurnSummary,
} from "./runtime.js";

export { createNahHandler } from "./handler.js";
export type { NahHandlerOptions, NahRouteHandlers } from "./handler.js";

export {
	createMemoryEventLog,
	createMemorySessionStore,
	createRunId,
	createSessionId,
} from "./session.js";
export type { NahEventLog, NahSessionStore } from "./session.js";

export {
	createEventStreamResponse,
	decodeFrames,
	encodeComment,
	encodeFrame,
	parseEventStream,
	SSE_HEADERS,
} from "./sse.js";

export type {
	NahActionRequest,
	NahActionResponse,
	NahError,
	NahEvent,
	NahFrame,
	NahPostRequest,
	NahTurnRequest,
} from "./types.js";
