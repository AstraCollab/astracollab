/**
 * Ingesting a trace that is still running.
 *
 * `saveTrace` replaces a whole trace: it deletes every span for the id and
 * reinserts what it was handed, because an experiment re-running a case must
 * replace the old attempt rather than sit next to it. Applied to a run in flight
 * that is actively destructive — each partial upload would delete every span it
 * did not carry, so a waterfall that only ever grows would flicker instead.
 *
 * `appendSpans` is the merge half, and these pin it against the failure that
 * actually loses data: a later write quietly removing an earlier one.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { type StudioHandle, startStudioServer } from "../src/server.js";
import { StudioStore } from "../src/store.js";
import type { Span, Trace } from "../src/wire.js";

/** A server with a fresh in-memory store, plus a request helper. */
const withServer = async (
	run: (url: string, store: StudioStore) => Promise<void>,
): Promise<void> => {
	const store = new StudioStore({ path: ":memory:" });
	const handle: StudioHandle = await startStudioServer({
		store,
		port: 0,
		host: "127.0.0.1",
	});
	try {
		await run(handle.url, store);
	} finally {
		await handle.close();
	}
};

const post = async (
	url: string,
	path: string,
	body: unknown,
): Promise<Response> =>
	fetch(new URL(path, url), {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});

const store = (): StudioStore => new StudioStore({ path: ":memory:" });

/** A trace as it looks mid-run: no end time yet, status not yet decided. */
const running = (over: Partial<Trace> = {}): Trace => ({
	id: "t1",
	name: "a run",
	startTime: 1_000,
	endTime: null,
	rootSpanId: "root",
	status: "unset",
	tags: [],
	metadata: {},
	...over,
});

const span = (over: Partial<Span> = {}): Span => ({
	id: "s1",
	traceId: "t1",
	parentId: "root",
	name: "a step",
	kind: "step",
	startTime: 1_100,
	endTime: 1_400,
	status: "ok",
	attributes: {},
	metadata: {},
	...over,
});

const spanIds = (s: StudioStore, traceId = "t1"): string[] =>
	(s.getTrace(traceId)?.spans ?? [])
		.slice()
		.sort((a, b) => a.startTime - b.startTime)
		.map((entry) => entry.id);

describe("appendSpans", () => {
	it("keeps the spans an earlier upload already wrote", () => {
		const s = store();
		s.appendSpans(running(), [span({ id: "s1" })]);
		s.appendSpans(running(), [
			span({ id: "s2", startTime: 1_500, endTime: 1_800 }),
		]);

		// The bug this exists to prevent: the second upload carrying only s2.
		expect(spanIds(s)).toEqual(["s1", "s2"]);
	});

	it("accumulates across many partial uploads in order", () => {
		const s = store();
		for (let i = 0; i < 25; i += 1) {
			s.appendSpans(running(), [
				span({
					id: `s${i}`,
					startTime: 1_000 + i * 10,
					endTime: 1_005 + i * 10,
				}),
			]);
		}
		expect(spanIds(s)).toHaveLength(25);
		expect(spanIds(s)[0]).toBe("s0");
		expect(spanIds(s).at(-1)).toBe("s24");
	});

	it("is idempotent, so a retried request does not duplicate a span", () => {
		const s = store();
		s.appendSpans(running(), [span({ id: "s1" })]);
		s.appendSpans(running(), [span({ id: "s1" })]);

		expect(spanIds(s)).toEqual(["s1"]);
	});

	it("lets a span be corrected by a later upload of the same id", () => {
		const s = store();
		s.appendSpans(running(), [
			span({ id: "s1", name: "first guess", endTime: null }),
		]);
		s.appendSpans(running(), [
			span({ id: "s1", name: "the real name", endTime: 1_900 }),
		]);

		const stored = s.getTrace("t1")?.spans;
		expect(stored).toHaveLength(1);
		expect(stored[0]?.name).toBe("the real name");
		expect(stored[0]?.endTime).toBe(1_900);
	});

	it("records a running trace with no end time", () => {
		const s = store();
		s.appendSpans(running(), [span({ id: "s1" })]);

		const row = s.listTraces()[0]!;
		expect(row.id).toBe("t1");
		expect(row.endTime).toBeNull();
		expect(row.status).toBe("unset");
	});

	it("leaves cost and tokens unset until the run is over", () => {
		const s = store();
		s.appendSpans(running(), [span({ id: "s1" })]);

		// A running trace has no root span yet, and those columns are read off it.
		// The store omits the key entirely rather than sending a null, so "not known
		// yet" stays distinct from "known to be zero".
		const partial = s.listTraces()[0]!;
		expect(partial.costUsd).toBeUndefined();
		expect(partial.inputTokens).toBeUndefined();
		expect(partial.outputTokens).toBeUndefined();
	});

	it("does not let a late partial upload un-finish a trace that already ended", () => {
		// The regression a naive merge would cause: `INSERT OR REPLACE` here would
		// put `end_time` back to null and a completed trace would look live forever.
		const s = store();
		s.saveTrace({ ...running(), endTime: 9_000, status: "ok" }, [
			span({ id: "s1" }),
		]);
		s.appendSpans(running(), [
			span({ id: "s2", startTime: 9_100, endTime: 9_200 }),
		]);

		const row = s.listTraces()[0]!;
		expect(row.endTime).toBe(9_000);
		expect(row.status).toBe("ok");
		// The new span still lands — only the trace row is left alone.
		expect(spanIds(s)).toEqual(["s1", "s2"]);
	});

	it("does not let a late partial upload erase the cost of a finished trace", () => {
		const s = store();
		const root = span({
			id: "root",
			parentId: null,
			attributes: { "nah.cost.usd": 1.25 },
		});
		s.saveTrace({ ...running(), endTime: 9_000, status: "ok" }, [root]);
		expect(s.listTraces()[0]?.costUsd).toBeCloseTo(1.25);

		s.appendSpans(running(), [span({ id: "s9" })]);

		expect(s.listTraces()[0]?.costUsd).toBeCloseTo(1.25);
	});

	it("writes a trace row before any span arrives", () => {
		// A run announces itself and then produces spans; the list must show it.
		const s = store();
		s.appendSpans(running(), []);

		expect(s.listTraces().map((row) => row.id)).toEqual(["t1"]);
	});

	it("accepts an empty upload without touching what is there", () => {
		const s = store();
		s.appendSpans(running(), [span({ id: "s1" })]);
		s.appendSpans(running(), []);

		expect(spanIds(s)).toEqual(["s1"]);
	});
});

describe("saveTrace stays a replace", () => {
	it("drops spans it was not given, which is what an experiment re-run needs", () => {
		const s = store();
		s.appendSpans(running(), [
			span({ id: "s1" }),
			span({ id: "s2", startTime: 1_500, endTime: 1_800 }),
		]);
		s.saveTrace({ ...running(), endTime: 9_000, status: "ok" }, [
			span({ id: "s2", startTime: 1_500, endTime: 1_800 }),
		]);

		expect(spanIds(s)).toEqual(["s2"]);
	});

	it("still populates cost and tokens from the root span", () => {
		const s = store();
		const root = span({
			id: "root",
			parentId: null,
			attributes: {
				"nah.cost.usd": 2,
				"gen_ai.usage.input_tokens": 10,
				"gen_ai.usage.output_tokens": 20,
			},
		});
		s.saveTrace({ ...running(), endTime: 9_000, status: "ok" }, [root]);

		const row = s.listTraces()[0]!;
		expect(row.costUsd).toBeCloseTo(2);
		expect(row.inputTokens).toBe(10);
		expect(row.outputTokens).toBe(20);
	});
});

describe("POST /api/traces", () => {
	it("merges when the client says the run is not over", async () => {
		await withServer(async (url, s) => {
			await post(url, "/api/traces", {
				trace: running(),
				spans: [span({ id: "s1" })],
				final: false,
			});
			await post(url, "/api/traces", {
				trace: running(),
				spans: [span({ id: "s2", startTime: 1_500, endTime: 1_800 })],
				final: false,
			});

			expect(spanIds(s)).toEqual(["s1", "s2"]);
			expect(s.listTraces()[0]?.endTime).toBeNull();
		});
	});

	it("replaces when the flag is absent, which is how every older client behaves", async () => {
		// The back-compat that matters most: an omitted flag must not be read as
		// "live", or every completed trace would be truncated to its first span.
		await withServer(async (url, s) => {
			await post(url, "/api/traces", {
				trace: running(),
				spans: [span({ id: "s1" })],
			});
			await post(url, "/api/traces", {
				trace: running(),
				spans: [span({ id: "s2" })],
			});

			expect(spanIds(s)).toEqual(["s2"]);
		});
	});

	it("replaces when the flag is explicitly true", async () => {
		await withServer(async (url, s) => {
			await post(url, "/api/traces", {
				trace: running(),
				spans: [span({ id: "s1" })],
				final: true,
			});
			await post(url, "/api/traces", {
				trace: running(),
				spans: [span({ id: "s2" })],
				final: true,
			});

			expect(spanIds(s)).toEqual(["s2"]);
		});
	});

	it("lets a live run be finished by a final upload", async () => {
		await withServer(async (url, s) => {
			await post(url, "/api/traces", {
				trace: running(),
				spans: [span({ id: "s1" })],
				final: false,
			});
			await post(url, "/api/traces", {
				trace: { ...running(), endTime: 9_000, status: "ok" },
				spans: [span({ id: "s1" }), span({ id: "s2" })],
			});

			expect(spanIds(s)).toEqual(["s1", "s2"]);
			expect(s.listTraces()[0]?.endTime).toBe(9_000);
		});
	});

	it("still answers with the trace id a client can correlate against", async () => {
		await withServer(async (url) => {
			const body = (await (
				await post(url, "/api/traces", {
					trace: running(),
					spans: [],
					final: false,
				})
			).json()) as {
				ok: boolean;
				id: string;
			};
			expect(body.ok).toBe(true);
			expect(body.id).toBe("t1");
		});
	});
});

describe("a run that never reported an ending", () => {
	const LIVENESS_MS = 30_000;

	/** An agent that is running and was heard from just now. */
	const runningAgent = (s: StudioStore): string => {
		s.registerAgent({ id: "ag1", name: "a session", cwd: "/repo" });
		s.setAgentState("ag1", { status: "running" });
		return "ag1";
	};

	/** Move the clock on, as a process that stopped reporting does. */
	const goQuiet = (by: number): void => {
		vi.spyOn(Date, "now").mockReturnValue(Date.now() + by);
	};

	afterEach(() => vi.restoreAllMocks());

	it("stops claiming to be running once its agent goes quiet", () => {
		const s = store();
		const agentId = runningAgent(s);
		s.appendSpans(running(), [span()], agentId);
		expect(s.listTraces({ livenessMs: LIVENESS_MS })[0]?.status).toBe("unset");

		// The turn was killed part-way. The client stops heartbeating and never sends
		// the post that would have closed the trace, so the row is left exactly as its
		// first partial made it — claiming, forever, to be a run in progress.
		goQuiet(LIVENESS_MS * 3);
		const aged = s.listTraces({ livenessMs: LIVENESS_MS })[0]!;
		expect(aged.status).toBe("interrupted");
		// No invented end time. A made-up duration is a number somebody would trust.
		expect(aged.endTime).toBeNull();
	});

	it("leaves a run alone while its agent is still reporting", () => {
		const s = store();
		const agentId = runningAgent(s);
		s.appendSpans(running(), [span()], agentId);
		// An agentic turn is minutes old and perfectly alive, which is the whole
		// reason this is keyed off the heartbeat and not off the trace's age.
		goQuiet(LIVENESS_MS * 3);
		s.setAgentState(agentId, { status: "running" });

		expect(s.listTraces({ livenessMs: LIVENESS_MS })[0]?.status).toBe("unset");
	});

	it("believes a finished trace over any of this", () => {
		const s = store();
		const agentId = runningAgent(s);
		s.appendSpans(running(), [span()], agentId);
		s.saveTrace(
			{ ...running(), endTime: 2_000, status: "ok" },
			[span()],
			agentId,
		);
		goQuiet(LIVENESS_MS * 100);

		// The client's own final word is the one thing that cannot be second-guessed:
		// a trace can sit unread for a week and still be a run that finished fine.
		expect(s.listTraces({ livenessMs: LIVENESS_MS })[0]?.status).toBe("ok");
	});

	it("leaves a trace with no agent alone, having nobody to go quiet", () => {
		const s = store();
		// The built-in agent writes here directly rather than over HTTP.
		s.appendSpans(running(), [span()]);
		goQuiet(LIVENESS_MS * 100);

		expect(s.listTraces({ livenessMs: LIVENESS_MS })[0]?.status).toBe("unset");
	});

	it("reports the same thing whichever way the trace is read", () => {
		const s = store();
		const agentId = runningAgent(s);
		s.appendSpans(running(), [span()], agentId);
		goQuiet(LIVENESS_MS * 3);

		expect(s.getTrace("t1", { livenessMs: LIVENESS_MS })?.trace.status).toBe(
			"interrupted",
		);
		// Opt-in, like the agent liveness it is modelled on: a caller that does not
		// ask is not second-guessing what is stored.
		expect(s.getTrace("t1")?.trace.status).toBe("unset");
	});

	it("still finds the spans of a run that was cut short", () => {
		const s = store();
		const agentId = runningAgent(s);
		s.appendSpans(running(), [span({ id: "s1" })], agentId);
		s.appendSpans(
			running(),
			[span({ id: "s2", startTime: 1_500, endTime: 1_800 })],
			agentId,
		);
		goQuiet(LIVENESS_MS * 3);

		// Ageing the status must not cost the evidence: the partial trace is how
		// anyone finds out what the run was doing when it stopped.
		expect(spanIds(s)).toEqual(["s1", "s2"]);
		expect(s.getTrace("t1", { livenessMs: LIVENESS_MS })?.spans).toHaveLength(
			2,
		);
	});
});
