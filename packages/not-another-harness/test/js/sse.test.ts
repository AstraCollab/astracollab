import { describe, expect, it } from "vitest";

import {
	decodeFrames,
	encodeComment,
	encodeFrame,
	parseEventStream,
} from "../../src/js/sse.js";
import type { NahFrame } from "../src/types.js";

const frame = (overrides: Partial<NahFrame> = {}): NahFrame => ({
	type: "text-delta",
	step: 1,
	text: "hello",
	seq: 7,
	sessionId: "s1",
	runId: "r1",
	at: 1_700_000_000_000,
	...overrides,
}) as NahFrame;

describe("sse framing", () => {
	it("writes the id, the event name and the data", () => {
		const encoded = encodeFrame(frame());
		expect(encoded).toContain("id: 7\n");
		expect(encoded).toContain("event: text-delta\n");
		expect(encoded).toContain("data: {");
		expect(encoded.endsWith("\n\n")).toBe(true);
	});

	it("round-trips a frame", () => {
		const { frames, rest } = decodeFrames(encodeFrame(frame()));
		expect(rest).toBe("");
		expect(frames).toHaveLength(1);
		expect(frames[0]).toEqual(frame());
	});

	it("keeps a partial frame for the next chunk", () => {
		const encoded = encodeFrame(frame());
		const cut = Math.floor(encoded.length / 2);
		const first = decodeFrames(encoded.slice(0, cut));
		expect(first.frames).toHaveLength(0);
		expect(first.rest).toBe(encoded.slice(0, cut));

		const second = decodeFrames(first.rest + encoded.slice(cut));
		expect(second.frames).toEqual([frame()]);
	});

	it("skips a frame it cannot parse rather than dying on it", () => {
		const good = encodeFrame(frame());
		const broken = "id: 1\nevent: text-delta\ndata: {not json\n\n";
		const { frames } = decodeFrames(broken + good);
		expect(frames).toEqual([frame()]);
	});

	it("ignores a comment", () => {
		const { frames } = decodeFrames(encodeComment("keep-alive"));
		expect(frames).toHaveLength(0);
	});
});

describe("parseEventStream", () => {
	it("reads frames out of a response body", async () => {
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				const encoder = new TextEncoder();
				controller.enqueue(encoder.encode(encodeFrame(frame())));
				controller.enqueue(
					encoder.encode(
						encodeFrame(frame({ type: "finish", seq: 8 } as Partial<NahFrame>)),
					),
				);
				controller.close();
			},
		});

		const seen: NahFrame[] = [];
		for await (const parsed of parseEventStream(new Response(body))) {
			seen.push(parsed);
		}

		expect(seen.map((f) => f.type)).toEqual(["text-delta", "finish"]);
	});

	it("returns nothing for a response with no body", async () => {
		const seen: NahFrame[] = [];
		for await (const parsed of parseEventStream(
			new Response(null, { status: 204 }),
		)) {
			seen.push(parsed);
		}
		expect(seen).toHaveLength(0);
	});
});
