/**
 * Server-sent events: the framing, in both directions.
 *
 * ## Why SSE and not a websocket
 *
 * The traffic is one way — the server pushes events, the client answers with
 * ordinary requests — and it is text. A websocket would buy bidirectional
 * framing we do not need and cost us the reconnect behaviour that matters:
 * `EventSource` reconnects on its own, and the most likely cause of a dropped
 * stream is somebody closing a laptop lid, not a server falling over.
 *
 * It is also the one streaming format a Next.js route handler can produce
 * without a framework in the middle. The response body is a `ReadableStream`
 * and the headers are two lines; there is no adapter to keep in step with.
 *
 * ## The framing
 *
 * ```
 * id: 12
 * event: text-delta
 * data: {"type":"text-delta", ...}
 *
 * ```
 *
 * `id` carries the frame's sequence number so a reconnecting client can say
 * where it left off. `event` carries the type so a browser's `EventSource` can
 * dispatch by name, and `data` carries the whole frame as JSON so a client
 * that wants everything gets it without subscribing to a dozen event names.
 *
 * The blank line after `data` is the frame terminator and is not optional.
 */

import type { NahFrame } from "./types.js";

/** Headers every event stream needs. */
export const SSE_HEADERS: Readonly<Record<string, string>> = {
	"content-type": "text/event-stream; charset=utf-8",
	// `no-transform` matters as much as `no-cache`: a proxy that is allowed to
	// re-encode the body will happily buffer it, and a buffered event stream
	// delivers everything at once when the run ends — which is not a stream.
	"cache-control": "no-cache, no-transform",
	// Nginx buffers an event stream into uselessness without this.
	"x-accel-buffering": "no",
	connection: "keep-alive",
};

/** The comment frame used as a keep-alive. Comments are ignored by clients. */
export const encodeComment = (text: string): string => `: ${text}\n\n`;

/** Serialise one frame. */
export const encodeFrame = (frame: NahFrame): string =>
	`id: ${frame.seq}\nevent: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`;

/**
 * Pull frames out of a buffer.
 *
 * Returns the frames it could complete and whatever is left over, because a
 * chunk boundary can fall anywhere — including in the middle of a frame's
 * JSON — and a decoder that assumed otherwise would drop the tail of every
 * large frame.
 */
export const decodeFrames = (buffer: string): {
	frames: NahFrame[];
	rest: string;
} => {
	const frames: NahFrame[] = [];
	let rest = buffer;

	for (;;) {
		const boundary = rest.indexOf("\n\n");
		if (boundary === -1) break;
		const block = rest.slice(0, boundary);
		rest = rest.slice(boundary + 2);

		const data: string[] = [];
		for (const line of block.split("\n")) {
			if (line.startsWith("data:")) {
				data.push(line.slice("data:".length).replace(/^ /, ""));
			}
		}
		if (data.length === 0) continue;

		try {
			frames.push(JSON.parse(data.join("\n")) as NahFrame);
		} catch {
			// A frame we cannot parse is dropped rather than fatal: a client that
			// dies on one bad frame loses the whole run, and the run is the
			// expensive part.
		}
	}

	return { frames, rest };
};

/**
 * Read an event stream from a `Response`.
 *
 * The reader is the browser's `fetch` response body, not `EventSource`,
 * because a turn is started by a `POST` and `EventSource` can only issue a
 * `GET`. The frames are the same either way, which is the point of writing
 * the format down.
 */
export const parseEventStream = async function* (
	response: Response,
): AsyncGenerator<NahFrame> {
	const body = response.body;
	if (!body) return;

	const reader = body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";

	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			buffer += decoder.decode(value, { stream: true });
			const { frames, rest } = decodeFrames(buffer);
			buffer = rest;
			for (const frame of frames) yield frame;
		}
		// A stream that ends without its final newline is still a stream that
		// happened; the tail is decoded rather than dropped.
		buffer += decoder.decode();
		const { frames } = decodeFrames(buffer);
		for (const frame of frames) yield frame;
	} finally {
		reader.releaseLock?.();
	}
};

/**
 * Wrap a frame source in a `Response` that streams it.
 *
 * The heartbeat is the fiddly part. A proxy in front of the app will close an
 * idle connection — the default is often 30 or 60 seconds — and a long tool
 * call can easily be idle for longer than that. A comment frame every so often
 * keeps the connection open without waking the client, because comments are
 * ignored by `EventSource` and dropped by the parser above.
 */
export const createEventStreamResponse = (
	source: AsyncIterable<NahFrame>,
	options: {
		headers?: Record<string, string>;
		/** Keep-alive interval in milliseconds. `0` disables it. Default 15s. */
		heartbeatMs?: number;
		/** Aborts the source when the client goes away. */
		signal?: AbortSignal;
	} = {},
): Response => {
	const heartbeatMs = options.heartbeatMs ?? 15_000;
	const encoder = new TextEncoder();

	const stream = new ReadableStream<Uint8Array>({
		async start(controller) {
			const iterator = source[Symbol.asyncIterator]();
			let closed = false;

			/**
			 * The outstanding `next()`.
			 *
			 * Held across iterations on purpose. Racing a fresh `next()` against
			 * the heartbeat timer and dropping it when the timer wins would lose
			 * the frame it was waiting for — the next call would return the frame
			 * *after* it, and one frame would silently vanish from the stream.
			 */
			let pending: Promise<IteratorResult<NahFrame>> | null = null;

			const onAbort = () => {
				closed = true;
			};
			options.signal?.addEventListener("abort", onAbort, { once: true });

			const close = () => {
				if (closed) return;
				closed = true;
				try {
					controller.close();
				} catch {
					// Already closed by a cancel.
				}
			};

			const enqueue = (text: string) => {
				try {
					controller.enqueue(encoder.encode(text));
				} catch {
					// The consumer went away between the check and the write.
					closed = true;
				}
			};

			/**
			 * Wait for the next frame, or for the heartbeat to be due.
			 *
			 * The pending promise is *not* consumed when the timer wins, so no
			 * frame is lost to a slow tool call.
			 */
			const waitFor = async (
				value: Promise<IteratorResult<NahFrame>>,
			): Promise<
				{ timedOut: true } | { timedOut: false; value: IteratorResult<NahFrame> }
			> => {
				if (heartbeatMs <= 0) {
					return { timedOut: false, value: await value };
				}
				let timer: ReturnType<typeof setTimeout> | undefined;
				const timeout = new Promise<{ timedOut: true }>((resolve) => {
					timer = setTimeout(() => resolve({ timedOut: true }), heartbeatMs);
					(timer as { unref?: () => void }).unref?.();
				});
				const raced = await Promise.race([
					value.then((result) => ({ timedOut: false as const, result })),
					timeout,
				]);
				if (timer) clearTimeout(timer);
				return raced.timedOut
					? { timedOut: true }
					: { timedOut: false, value: raced.result };
			};

			try {
				for (;;) {
					if (pending === null) pending = iterator.next();
					const raced = await waitFor(pending);
					if (raced.timedOut) {
						if (closed) break;
						enqueue(encodeComment("keep-alive"));
						continue;
					}
					pending = null;
					if (raced.value.done) break;
					if (closed) break;
					enqueue(encodeFrame(raced.value.value));
				}
			} catch {
				// The source threw. There is no frame to send it in, because the
				// source is what produces frames — so the connection ends and the
				// client sees a truncated stream. The error is the server's
				// problem, not the client's, and it is logged there.
			} finally {
				options.signal?.removeEventListener("abort", onAbort);
				await iterator.return?.(undefined);
				close();
			}
		},
		cancel() {
			// The client went away. The iterator's `return` runs in the producer's
			// `finally`, which is where the runtime persists the transcript.
		},
	});

	return new Response(stream, {
		status: 200,
		headers: { ...SSE_HEADERS, ...options.headers },
	});
};
