/**
 * Warm sessions with a bounded lifetime.
 *
 * ## What this replaces, and what it does not
 *
 * This is the runtime half of what Mastra's `Harness` / `AgentController` provided
 * to `@astracollab/client`: a keyed registry that keeps a session's expensive
 * resources alive across turns, hands the same one back rather than rebuilding
 * it, and eventually lets them go.
 *
 * It is deliberately **not** an agent, a store, or a transport. It has no idea
 * what a session contains, which is why it is generic over the resource: the same
 * manager keeps a `HarnessRun` warm, or a resolved model plus sandbox, or whatever
 * else a caller pays to construct once per conversation.
 *
 * The reasoning for it living here rather than in an application: "keep this
 * expensive per-session thing alive, bound it, and reclaim it" is runtime
 * lifecycle. An app that reimplemented it would be reimplementing an SDK concern,
 * and the second app to need it would copy the first app's copy.
 *
 * ## What a caller still owns
 *
 * Conversation state. This never stores messages — a caller passes them per turn
 * from whatever store it uses, so the manager cannot become a second, competing
 * source of truth for a transcript.
 */

/** A resource a session keeps warm, optionally with its own teardown. */
export type WarmResource<Resource> = Resource & {
	destroy?: () => void | Promise<void>;
};

export type Session<Resource> = {
	readonly key: string;
	readonly resource: Resource;
	readonly createdAt: number;
	readonly lastUsedAt: number;
	/** Times this session has been handed out. A cheap liveness signal. */
	readonly uses: number;
};

/**
 * The same shape, mutable.
 *
 * `Session` is readonly because a caller must not be able to make a session look
 * freshly used — or stale — from outside. The manager still has to update both on
 * every read, so it holds this and hands it out as the readonly one.
 */
type LiveSession<Resource> = {
	-readonly [K in keyof Session<Resource>]: Session<Resource>[K];
};

export type SessionManagerOptions<Resource> = {
	/**
	 * Build the resource for a key. Called at most once per live session.
	 *
	 * May be async so a caller can await construction, but the resource is only
	 * published once it resolves: two concurrent `ensure()` calls for one key share
	 * a single construction, so a cold key under load cannot be built twice.
	 */
	create: (key: string) => Resource | Promise<Resource>;
	/** Idle time before a session may be reclaimed. Default 5 minutes. */
	idleTtlMs?: number;
	/** Hard cap; the least recently used are reclaimed to make room. Default 100. */
	maxSessions?: number;
	/**
	 * How often idle sessions are reclaimed in the background.
	 *
	 * Defaults to a quarter of `idleTtlMs`, capped at 30s: a session that has gone
	 * idle is released within ~25% of its own TTL, so the TTL the caller set is the
	 * number they can actually reason about. Pass `0` to sweep only when the caller
	 * asks, which is what a long-lived test or an embedder that drives its own
	 * lifecycle usually wants.
	 */
	sweepIntervalMs?: number;
	/** Injected in tests. */
	now?: () => number;
	/** Called after a session is reclaimed, for logging. */
	onEvict?: (
		key: string,
		reason: "idle" | "capacity" | "destroy" | "clear",
	) => void;
};

export type SessionManager<Resource> = {
	/** The live session for a key, or undefined. Never creates. */
	get(key: string): Session<Resource> | undefined;
	/** The live session for a key, creating it if cold. Warms on access. */
	ensure(key: string): Promise<Session<Resource>>;
	/** The resource for a key, creating it if cold. */
	resource(key: string): Promise<Resource>;
	/** Number of live sessions. */
	readonly size: number;
	/** Live keys, most recently used last. */
	keys(): string[];
	/** Reclaim one session and run its teardown. False when the key is unknown. */
	destroy(key: string): Promise<boolean>;
	/** Reclaim every session idle for longer than the TTL. Returns the keys. */
	evictIdle(): Promise<string[]>;
	/** Reclaim everything. */
	clear(): Promise<void>;
	/**
	 * Stop the background sweep.
	 *
	 * Sessions stay warm and everything still works; they simply stop being
	 * reclaimed without a caller asking.
	 */
	stopSweeping(): void;
};

/**
 * Warm sessions with a bounded lifetime.
 *
 * The `ensure` path is the important one: it is what a turn handler calls per
 * request, and getting it wrong in either direction is expensive. Building twice
 * means two sandboxes and two Postgres pools; creating fresh every time means the
 * warm reuse never existed at all.
 *
 * Idle sessions are reclaimed on a background timer. The interval is `unref`ed, so
 * a manager that is still holding sessions never keeps a process alive on its own —
 * the one failure mode a library-owned timer can cause. `stopSweeping` turns it
 * off, and `sweepIntervalMs: 0` opts out from the start.
 */
export const createSessionManager = <Resource extends object>(
	options: SessionManagerOptions<Resource>,
): SessionManager<Resource> => {
	const idleTtlMs = options.idleTtlMs ?? 5 * 60_000;
	const maxSessions = options.maxSessions ?? 100;
	const now = options.now ?? (() => Date.now());
	const sessions = new Map<string, LiveSession<Resource>>();
	/** In-flight constructions, so two cold callers share one. */
	const pending = new Map<string, Promise<LiveSession<Resource>>>();

	const reclaim = async (
		key: string,
		reason: "idle" | "capacity" | "destroy" | "clear",
	): Promise<void> => {
		const session = sessions.get(key);
		if (!session) return;
		sessions.delete(key);
		options.onEvict?.(key, reason);
		// A session's teardown is its own business and may be async; a failure there
		// must not stop the rest of the sweep, and must not leave the entry behind —
		// it is already out of the map, which is the part that matters for memory.
		try {
			await (session.resource as WarmResource<Resource>).destroy?.();
		} catch {
			// Deliberately swallowed: the resource is unreachable either way, and
			// propagating would turn one bad teardown into a failed request.
		}
	};

	/** Trim to `maxSessions`, least recently used first. */
	const trimToCapacity = async (): Promise<void> => {
		if (sessions.size <= maxSessions) return;
		const ordered = [...sessions.values()].sort(
			(a, b) => a.lastUsedAt - b.lastUsedAt,
		);
		for (const session of ordered) {
			if (sessions.size <= maxSessions) break;
			await reclaim(session.key, "capacity");
		}
	};

	const ensure = async (key: string): Promise<Session<Resource>> => {
		const existing = sessions.get(key);
		if (existing) {
			// Touched on read, so a busy session is never mistaken for an idle one.
			existing.lastUsedAt = now();
			existing.uses += 1;
			return existing;
		}

		const inFlight = pending.get(key);
		if (inFlight) return inFlight;

		const construction = (async () => {
			const resource = await options.create(key);
			const at = now();
			const session: LiveSession<Resource> = {
				key,
				resource,
				createdAt: at,
				lastUsedAt: at,
				uses: 1,
			};
			sessions.set(key, session);
			pending.delete(key);
			await trimToCapacity();
			return session;
		})();

		pending.set(key, construction);
		return construction;
	};

	const evictIdle = async (): Promise<string[]> => {
		const cutoff = now() - idleTtlMs;
		// Materialised first: reclaiming mutates the map this would otherwise
		// iterate, and a live iterator over a mutating map is a skipped key at best.
		const stale = [...sessions.values()]
			.filter((session) => session.lastUsedAt <= cutoff)
			.map((session) => session.key);
		for (const key of stale) await reclaim(key, "idle");
		return stale;
	};

	/**
	 * The background sweep.
	 *
	 * `unref()` because this is a library: a caller who creates a manager and then
	 * stops using it should not find their process unable to exit. That is the
	 * whole reason an internal timer is opt-out-able rather than mandatory.
	 */
	const sweepIntervalMs =
		options.sweepIntervalMs ??
		Math.min(30_000, Math.max(250, Math.floor(idleTtlMs / 4)));
	let timer: ReturnType<typeof setInterval> | undefined;
	if (sweepIntervalMs > 0) {
		timer = setInterval(() => {
			void evictIdle().catch(() => undefined);
		}, sweepIntervalMs);
		// Not every runtime returns an object with unref — a browser timer has none —
		// so this is optional rather than assumed.
		(timer as { unref?: () => void }).unref?.();
	}

	return {
		get(key) {
			return sessions.get(key);
		},

		ensure,

		async resource(key) {
			return (await ensure(key)).resource;
		},

		get size() {
			return sessions.size;
		},

		keys() {
			return [...sessions.values()]
				.sort((a, b) => a.lastUsedAt - b.lastUsedAt)
				.map((session) => session.key);
		},

		async destroy(key) {
			if (!sessions.has(key)) return false;
			pending.delete(key);
			await reclaim(key, "destroy");
			return true;
		},

		evictIdle,

		async clear() {
			for (const key of [...sessions.keys()]) await reclaim(key, "clear");
			pending.clear();
		},

		stopSweeping() {
			if (timer === undefined) return;
			clearInterval(timer);
			timer = undefined;
		},
	};
};
