/**
 * The live event stream.
 *
 * A monitoring dashboard that only learns what happened when it asks is a
 * dashboard you have to sit and watch, so the server pushes: an agent appeared,
 * an agent moved, a trace landed, an agent printed a line. The store already
 * knows all four at the moment they happen, so this only has to decide who to
 * tell and how to say it.
 *
 * Server-sent events rather than a socket. The traffic is one way, it is text,
 * and `EventSource` reconnects on its own — which matters more here than
 * throughput, because the most likely cause of a dropped stream is somebody
 * closing a laptop lid, and the dashboard should come back without being asked.
 */
import type { ServerResponse } from "node:http";

import type { StoreEvent, StudioStore } from "./store.js";
import type { StreamEvent } from "./wire.js";

/** Comment frames keep proxies and browsers from timing out an idle connection. */
const HEARTBEAT_MS = 15_000;

/** Enough for a laptop to sleep and wake without the UI needing to notice. */
const RETRY_MS = 2_000;

export type StreamHub = {
	/** Take over a response and keep it open as an event stream. */
	add: (response: ServerResponse) => void;
	/** End every open stream. Called when the server closes. */
	close: () => void;
	/** Clients currently attached, for tests. */
	readonly size: () => number;
};

export const createStreamHub = (
	store: StudioStore,
	options: { livenessMs?: number; now?: () => number } = {},
): StreamHub => {
	const now = options.now ?? (() => Date.now());
	const liveness = options.livenessMs ?? 30_000;
	const clients = new Set<ServerResponse>();

	const frame = (event: StreamEvent): string =>
		`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;

	const write = (response: ServerResponse, text: string): void => {
		// A client that has gone away is normal — a closed tab, a killed browser —
		// and it must not take the writer down with it.
		try {
			response.write(text);
		} catch {
			clients.delete(response);
		}
	};

	const broadcast = (event: StreamEvent): void => {
		if (clients.size === 0) return;
		const text = frame(event);
		for (const response of clients) write(response, text);
	};

	const toEvent = (event: StoreEvent): StreamEvent | null => {
		switch (event.type) {
			case "trace":
				return { type: "trace", trace: event.trace };
			case "agent": {
				// Re-read the row: the event says what changed, not what the agent now
				// looks like, and a summary is cheaper to send than a question.
				const agent = store.getAgentSummary(event.agentId, now() - liveness);
				return agent ? { type: "agent", agent } : null;
			}
			case "log":
				return { type: "log", agentId: event.agentId, line: event.line };
		}
	};

	// Subscribed lazily, while somebody is listening. An idle Studio should do
	// nothing at all: no timer, no listener, no work per turn.
	let unsubscribe: (() => void) | null = null;
	let heartbeat: NodeJS.Timeout | null = null;

	const attach = (): void => {
		if (unsubscribe) return;
		unsubscribe = store.on((event) => {
			const mapped = toEvent(event);
			if (mapped) broadcast(mapped);
		});
		heartbeat = setInterval(() => {
			if (clients.size > 0) broadcast({ type: "pong", at: now() });
		}, HEARTBEAT_MS);
		// Never hold the process open for a heartbeat.
		heartbeat.unref?.();
	};

	const detachIfIdle = (): void => {
		if (clients.size > 0) return;
		unsubscribe?.();
		unsubscribe = null;
		if (heartbeat) clearInterval(heartbeat);
		heartbeat = null;
	};

	return {
		add(response: ServerResponse): void {
			response.writeHead(200, {
				"content-type": "text/event-stream; charset=utf-8",
				"cache-control": "no-cache, no-transform",
				// Nginx will buffer an event stream into uselessness without this.
				"x-accel-buffering": "no",
				connection: "keep-alive",
			});
			// Tell the browser how long to wait before reconnecting, and send the
			// current state immediately: a dashboard that opens blank for ten seconds
			// while it polls looks broken.
			try {
				response.write(`retry: ${RETRY_MS}\n\n`);
				const agents = store.listAgents({ runningBefore: now() - liveness });
				response.write(frame({ type: "hello", agents, at: now() }));
			} catch {
				// The client went away between the socket opening and the first frame.
				// Its request is answered by ending it, and nobody is subscribed.
				clients.delete(response);
				response.end();
				return;
			}
			clients.add(response);
			attach();
			const drop = (): void => {
				clients.delete(response);
				detachIfIdle();
			};
			response.on("close", drop);
			response.on("error", drop);
		},
		close(): void {
			detachIfIdle();
			for (const response of clients) {
				try {
					response.end();
				} catch {
					// Already gone.
				}
			}
			clients.clear();
		},
		size: () => clients.size,
	};
};
