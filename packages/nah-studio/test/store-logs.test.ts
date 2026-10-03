/**
 * The agent log table, and the sequence numbers that order it.
 *
 * Numbering used to be read back with `SELECT MAX(seq)` on every appended line,
 * which is what capped how fast the dashboard could keep up with a chatty agent.
 * It is cached in memory now, and these pin the part of that which can go wrong
 * silently: a cache that hands out a number already in use would overwrite a
 * real line rather than add one, and the log would silently lose lines.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { StudioStore } from "../src/store.js";

const tempDirs: string[] = [];

/** A real file, because the reopening case only means anything on disk. */
const tempPath = (): string => {
	const dir = mkdtempSync(join(tmpdir(), "nah-studio-store-"));
	tempDirs.push(dir);
	return join(dir, "studio.db");
};

afterEach(() => {
	for (const dir of tempDirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
});

const log = (store: StudioStore, agentId: string, text: string) =>
	store.appendAgentLog(agentId, { stream: "stdout", text });

describe("agent log sequencing", () => {
	it("numbers lines from 1 without gaps", () => {
		const store = new StudioStore({ path: ":memory:" });
		for (let i = 0; i < 5; i += 1) log(store, "ag_1", `line ${i}`);

		expect(store.listAgentLogs("ag_1").map((line) => line.seq)).toEqual([
			1, 2, 3, 4, 5,
		]);
	});

	it("keeps each agent's numbering independent", () => {
		const store = new StudioStore({ path: ":memory:" });
		log(store, "ag_1", "a");
		log(store, "ag_2", "b");
		log(store, "ag_1", "c");

		expect(store.listAgentLogs("ag_1").map((line) => line.seq)).toEqual([1, 2]);
		expect(store.listAgentLogs("ag_2").map((line) => line.seq)).toEqual([1]);
	});

	it("continues the numbering of a log that already exists on disk", () => {
		// The case a naive in-memory counter gets wrong: reopening a Studio whose
		// rows are already there must not restart at 1, because the insert is
		// `INSERT OR REPLACE` and would overwrite real lines.
		const path = tempPath();
		const first = new StudioStore({ path });
		log(first, "ag_1", "one");
		log(first, "ag_1", "two");
		first.close();

		const second = new StudioStore({ path });
		second.appendAgentLog("ag_1", { stream: "stdout", text: "three" });

		const lines = second.listAgentLogs("ag_1");
		expect(lines.map((line) => line.seq)).toEqual([1, 2, 3]);
		expect(lines.map((line) => line.text)).toEqual(["one", "two", "three"]);
	});

	it("starts over after the agent's lines are deleted", () => {
		const store = new StudioStore({ path: ":memory:" });
		store.registerAgent({ id: "ag_1", name: "one", cwd: "/tmp" });
		log(store, "ag_1", "a");
		log(store, "ag_1", "b");
		store.deleteAgent("ag_1");

		const entry = log(store, "ag_1", "fresh");

		expect(entry.seq).toBe(1);
		expect(store.listAgentLogs("ag_1").map((line) => line.text)).toEqual([
			"fresh",
		]);
	});

	it("keeps numbering correctly after a prune removes other agents' lines", () => {
		const store = new StudioStore({ path: ":memory:" });
		store.registerAgent({ id: "ag_keep", name: "keep", cwd: "/tmp" });
		store.registerAgent({ id: "ag_drop", name: "drop", cwd: "/tmp" });
		log(store, "ag_keep", "a");
		log(store, "ag_drop", "b");
		store.deleteAgent("ag_drop");
		// Nothing is old enough to age out yet.
		store.pruneAgents(60_000);

		expect(log(store, "ag_keep", "c").seq).toBe(2);
	});

	it("survives a volume of lines a real agent run would produce", () => {
		const store = new StudioStore({ path: ":memory:" });
		for (let i = 0; i < 2_000; i += 1) log(store, "ag_1", `line ${i}`);

		const lines = store.listAgentLogs("ag_1", 2_000);
		expect(lines).toHaveLength(2_000);
		expect(lines[0]?.seq).toBe(1);
		expect(lines.at(-1)?.seq).toBe(2_000);
	});
});
