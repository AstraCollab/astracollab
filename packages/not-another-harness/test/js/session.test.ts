import { describe, expect, it } from "vitest";

import {
	createMemoryEventLog,
	createMemorySessionStore,
} from "../../src/js/session.js";
import type { NahFrame } from "../../src/js/types.js";

const frame = (seq: number, sessionId = "s1"): NahFrame => ({
	type: "text-delta",
	step: 1,
	text: `chunk ${seq}`,
	seq,
	sessionId,
	runId: "r1",
	at: 0,
});

describe("the memory session store", () => {
	it("starts empty", async () => {
		const store = createMemorySessionStore();
		expect(await store.load("nobody")).toEqual([]);
	});

	it("appends and reads back", async () => {
		const store = createMemorySessionStore();
		await store.append("s1", [{ role: "user", content: "one" }]);
		await store.append("s1", [{ role: "assistant", content: "two" }]);

		expect(await store.load("s1")).toEqual([
			{ role: "user", content: "one" },
			{ role: "assistant", content: "two" },
		]);
	});

	it("replaces the whole transcript", async () => {
		const store = createMemorySessionStore();
		await store.append("s1", [{ role: "user", content: "one" }]);
		await store.replace("s1", [{ role: "assistant", content: "summary" }]);

		expect(await store.load("s1")).toEqual([
			{ role: "assistant", content: "summary" },
		]);
	});

	it("does not let a caller corrupt the store by mutating what it was given", async () => {
		const store = createMemorySessionStore();
		await store.append("s1", [{ role: "user", content: "one" }]);

		const loaded = await store.load("s1");
		loaded.push({ role: "user", content: "two" });

		expect(await store.load("s1")).toHaveLength(1);
	});

	it("keeps sessions apart", async () => {
		const store = createMemorySessionStore();
		await store.append("s1", [{ role: "user", content: "one" }]);
		expect(await store.load("s2")).toEqual([]);
	});
});

describe("the memory event log", () => {
	it("reads back what was written", async () => {
		const log = createMemoryEventLog();
		await log.append(frame(1));
		await log.append(frame(2));

		expect((await log.read("s1")).map((f) => f.seq)).toEqual([1, 2]);
	});

	it("reads only what came after a sequence number", async () => {
		const log = createMemoryEventLog();
		await log.append(frame(1));
		await log.append(frame(2));
		await log.append(frame(3));

		expect((await log.read("s1", 1)).map((f) => f.seq)).toEqual([2, 3]);
	});

	it("keeps the log bounded", async () => {
		const log = createMemoryEventLog({ maxFramesPerSession: 3 });
		for (let seq = 1; seq <= 10; seq += 1) await log.append(frame(seq));

		expect((await log.read("s1")).map((f) => f.seq)).toEqual([8, 9, 10]);
	});

	it("keeps sessions apart", async () => {
		const log = createMemoryEventLog();
		await log.append(frame(1, "s1"));
		expect(await log.read("s2")).toEqual([]);
	});
});
