import { afterEach, describe, expect, it, vi } from "vitest";

import {
	type WarmResource,
	createSessionManager,
} from "../src/session-manager.js";

/**
 * Warm sessions.
 *
 * The failure this exists to prevent is symmetric and both directions are
 * expensive: building twice means two sandboxes and two Postgres pools, and
 * building fresh on every read means the warm reuse never existed. Most of these
 * tests are about that pair.
 */

const resource = (id: string) => ({ id, destroy: vi.fn() });

/** A controllable clock, so eviction is tested without timers. */
const clock = (start = 1_000) => {
	let now = start;
	return { now: () => now, advance: (ms: number) => void (now += ms) };
};

describe("warm reuse", () => {
	it("builds once and hands the same resource back", async () => {
		const create = vi.fn(() => resource("a"));
		const manager = createSessionManager({ create, now: () => 0 });

		const first = await manager.ensure("chat-1");
		const second = await manager.ensure("chat-1");

		expect(create).toHaveBeenCalledTimes(1);
		// Identity, not equality: two sessions that merely look alike are two
		// sandboxes, and the caller cannot tell them apart until it is too late.
		expect(second.resource).toBe(first.resource);
		expect(manager.size).toBe(1);
	});

	it("builds once per key", async () => {
		const create = vi.fn((key: string) => resource(key));
		const manager = createSessionManager({ create });

		await manager.ensure("a");
		await manager.ensure("b");
		await manager.ensure("a");

		expect(create).toHaveBeenCalledTimes(2);
		expect(manager.size).toBe(2);
	});

	it("shares one construction between concurrent cold callers", async () => {
		// A cold key under load is exactly when a double build costs the most.
		let builds = 0;
		const manager = createSessionManager({
			create: async (key) => {
				builds += 1;
				await new Promise((resolve) => setTimeout(resolve, 5));
				return resource(key);
			},
		});

		const [a, b, c] = await Promise.all([
			manager.ensure("k"),
			manager.ensure("k"),
			manager.ensure("k"),
		]);

		expect(builds).toBe(1);
		expect(b.resource).toBe(a.resource);
		expect(c.resource).toBe(a.resource);
	});

	it("get never creates", async () => {
		const create = vi.fn(() => resource("a"));
		const manager = createSessionManager({ create });

		expect(manager.get("cold")).toBeUndefined();
		expect(create).not.toHaveBeenCalled();
		await manager.ensure("cold");
		expect(manager.get("cold")).toBeDefined();
	});

	it("counts uses, so a caller can see a session is hot", async () => {
		const manager = createSessionManager({ create: () => resource("a") });
		await manager.ensure("a");
		await manager.ensure("a");
		expect((await manager.ensure("a")).uses).toBe(3);
	});
});

describe("idle eviction", () => {
	it("reclaims a session past the ttl and runs its teardown", async () => {
		const time = clock();
		const built = resource("a");
		const manager = createSessionManager({
			create: () => built,
			idleTtlMs: 100,
			now: time.now,
		});

		await manager.ensure("a");
		time.advance(99);
		expect(await manager.evictIdle()).toEqual([]);
		expect(manager.size).toBe(1);

		time.advance(2);
		expect(await manager.evictIdle()).toEqual(["a"]);
		expect(manager.size).toBe(0);
		expect(built.destroy).toHaveBeenCalledTimes(1);
	});

	it("keeps a session warm while it is being used", async () => {
		const time = clock();
		const manager = createSessionManager({
			create: () => resource("a"),
			idleTtlMs: 100,
			now: time.now,
		});

		await manager.ensure("a");
		time.advance(80);
		await manager.ensure("a");
		time.advance(80);
		// 160ms since created, but only 80ms since last used.
		expect(await manager.evictIdle()).toEqual([]);
		expect(manager.size).toBe(1);
	});

	it("rebuilds after eviction rather than handing back a dead resource", async () => {
		const time = clock();
		let built = 0;
		const manager = createSessionManager({
			create: () => resource(`r${++built}`),
			idleTtlMs: 10,
			now: time.now,
		});

		const first = await manager.ensure("a");
		time.advance(20);
		await manager.evictIdle();
		const second = await manager.ensure("a");

		expect(second.resource).not.toBe(first.resource);
		expect(built).toBe(2);
	});

	it("reports why it reclaimed", async () => {
		const time = clock();
		const onEvict = vi.fn();
		const manager = createSessionManager({
			create: () => resource("a"),
			idleTtlMs: 5,
			now: time.now,
			onEvict,
		});

		await manager.ensure("a");
		time.advance(10);
		await manager.evictIdle();
		expect(onEvict).toHaveBeenCalledWith("a", "idle");
	});

	it("does not let a failing teardown break the sweep", async () => {
		const time = clock();
		const broken = {
			id: "bad",
			destroy: () => {
				throw new Error("teardown exploded");
			},
		};
		const good = resource("good");
		const manager = createSessionManager({
			create: (key) => (key === "bad" ? broken : good),
			idleTtlMs: 5,
			now: time.now,
		});

		await manager.ensure("bad");
		await manager.ensure("good");
		time.advance(10);
		const evicted = await manager.evictIdle();

		// Both went, and the healthy one's teardown still ran.
		expect(evicted.sort()).toEqual(["bad", "good"]);
		expect(good.destroy).toHaveBeenCalledTimes(1);
		expect(manager.size).toBe(0);
	});
});

describe("capacity", () => {
	it("reclaims the least recently used to make room", async () => {
		const time = clock();
		const manager = createSessionManager({
			create: (key) => resource(key),
			maxSessions: 2,
			now: time.now,
		});

		await manager.ensure("a");
		time.advance(10);
		await manager.ensure("b");
		time.advance(10);
		await manager.ensure("c");

		expect(manager.size).toBe(2);
		// "a" was least recently used, so it is the one that goes.
		expect(manager.get("a")).toBeUndefined();
		expect(manager.get("b")).toBeDefined();
		expect(manager.get("c")).toBeDefined();
	});

	it("does not reclaim a session that was just used", async () => {
		const time = clock();
		const manager = createSessionManager({
			create: (key) => resource(key),
			maxSessions: 2,
			now: time.now,
		});

		await manager.ensure("a");
		time.advance(10);
		await manager.ensure("b");
		time.advance(10);
		await manager.ensure("a");
		time.advance(10);
		await manager.ensure("c");

		// "b" aged out; "a" was touched and survives.
		expect(manager.get("a")).toBeDefined();
		expect(manager.get("b")).toBeUndefined();
	});
});

describe("the background sweep", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("reclaims idle sessions without a caller asking", async () => {
		// The point of the timer: a forgotten session is memory a long-lived process
		// never gives back.
		vi.useFakeTimers();
		const time = clock();
		const built = resource("a");
		const manager = createSessionManager({
			create: () => built,
			idleTtlMs: 400,
			sweepIntervalMs: 100,
			now: time.now,
		});

		await manager.ensure("a");
		expect(manager.size).toBe(1);

		time.advance(500);
		await vi.advanceTimersByTimeAsync(150);

		expect(manager.size).toBe(0);
		expect(built.destroy).toHaveBeenCalledTimes(1);
		manager.stopSweeping();
	});

	it("defaults the interval to a fraction of the ttl, so the ttl means something", async () => {
		vi.useFakeTimers();
		const time = clock();
		const manager = createSessionManager({
			create: () => resource("a"),
			idleTtlMs: 400,
			now: time.now,
		});

		await manager.ensure("a");
		// Nothing at a tenth of the TTL: the default interval is idleTtlMs / 4.
		time.advance(500);
		await vi.advanceTimersByTimeAsync(100);
		expect(manager.size).toBe(1);

		await vi.advanceTimersByTimeAsync(200);
		expect(manager.size).toBe(0);
		manager.stopSweeping();
	});

	it("stopSweeping leaves sessions warm and stops reclaiming", async () => {
		vi.useFakeTimers();
		const time = clock();
		const manager = createSessionManager({
			create: () => resource("a"),
			idleTtlMs: 100,
			sweepIntervalMs: 50,
			now: time.now,
		});

		await manager.ensure("a");
		manager.stopSweeping();
		time.advance(1000);
		await vi.advanceTimersByTimeAsync(500);

		expect(manager.size).toBe(1);
		// Still reclaimable on demand, which is the escape hatch that matters.
		expect(await manager.evictIdle()).toEqual(["a"]);
	});

	it("sweepIntervalMs: 0 opts out entirely", async () => {
		vi.useFakeTimers();
		const time = clock();
		const manager = createSessionManager({
			create: () => resource("a"),
			idleTtlMs: 100,
			sweepIntervalMs: 0,
			now: time.now,
		});

		await manager.ensure("a");
		time.advance(1000);
		await vi.advanceTimersByTimeAsync(10_000);
		expect(manager.size).toBe(1);
	});

	it("unrefs its timer, so a manager cannot keep a process alive", async () => {
		// The one failure a library-owned timer can cause, and the reason it is
		// opt-out-able rather than mandatory.
		const unref = vi.fn();
		const originalSetInterval = globalThis.setInterval;
		vi.stubGlobal("setInterval", ((handler: unknown, ms: number) => {
			const timer = originalSetInterval(handler as never, ms);
			return Object.assign(timer, { unref });
		}) as never);

		const manager = createSessionManager({ create: () => resource("a") });
		expect(unref).toHaveBeenCalled();
		manager.stopSweeping();
		vi.unstubAllGlobals();
	});

	it("survives a teardown that throws, on the timer path too", async () => {
		vi.useFakeTimers();
		const time = clock();
		const manager = createSessionManager<{ id: string; destroy?: () => void }>({
			create: () => ({
				id: "bad",
				destroy: () => {
					throw new Error("teardown exploded");
				},
			}),
			idleTtlMs: 100,
			sweepIntervalMs: 50,
			now: time.now,
		});

		await manager.ensure("bad");
		time.advance(200);
		// An unhandled rejection here would crash the process rather than just
		// leaving a session warm.
		await vi.advanceTimersByTimeAsync(200);
		expect(manager.size).toBe(0);
		manager.stopSweeping();
	});
});

describe("lifecycle", () => {
	it("destroy removes one session and says whether it was there", async () => {
		const manager = createSessionManager({ create: (key) => resource(key) });
		await manager.ensure("a");
		expect(await manager.destroy("a")).toBe(true);
		expect(await manager.destroy("a")).toBe(false);
		expect(manager.size).toBe(0);
	});

	it("clear reclaims everything", async () => {
		const a = resource("a");
		const b = resource("b");
		const manager = createSessionManager({
			create: (key) => (key === "a" ? a : b),
		});
		await manager.ensure("a");
		await manager.ensure("b");

		await manager.clear();
		expect(manager.size).toBe(0);
		expect(a.destroy).toHaveBeenCalled();
		expect(b.destroy).toHaveBeenCalled();
	});

	it("works with a resource that has no teardown", async () => {
		const manager = createSessionManager<{ id: string }>({
			create: (key) => ({ id: key }),
		});
		await manager.ensure("a");
		await expect(manager.evictIdle()).resolves.toEqual([]);
		await manager.clear();
		expect(manager.size).toBe(0);
	});

	it("awaits an async teardown", async () => {
		let torn = false;
		const manager = createSessionManager<WarmResource<{ id: string }>>({
			create: () => ({ id: "a", destroy: async () => void (torn = true) }),
		});
		await manager.ensure("a");
		await manager.clear();
		expect(torn).toBe(true);
	});

	it("lists keys least-recently-used first", async () => {
		const time = clock();
		const manager = createSessionManager({
			create: (key) => resource(key),
			now: time.now,
		});
		await manager.ensure("a");
		time.advance(10);
		await manager.ensure("b");
		expect(manager.keys()).toEqual(["a", "b"]);
	});
});
