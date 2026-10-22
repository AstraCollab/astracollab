/**
 * Where a conversation lives between requests.
 *
 * ## Why this is a seam and not a feature
 *
 * The harness keeps its transcript in memory for the length of a run. A Next.js
 * route handler gets one request, and on a serverless platform the process may
 * be recycled the moment the response is written. So the transcript has to
 * outlive the request, and *where* it outlives it is the application's
 * decision — Postgres, Redis, a KV store, a file, a database you already have.
 *
 * So this file defines the interface and ships one implementation: an in-memory
 * store, which is right for a single long-lived Node server and wrong for
 * anything else. It is the default because a default that does not work in
 * production is a trap, and this one at least fails loudly in the way that
 * matters — a second instance sees an empty conversation.
 *
 * The interface is deliberately small. Three methods, and the third one is the
 * interesting one: `replace` exists because compaction *means* the transcript
 * was rewritten, and a store that cannot represent that has to take the whole
 * thing or lose history.
 */

import type { ModelMessage } from "ai";
import type { NahFrame } from "./types.js";

/**
 * The transcript of one conversation.
 *
 * `append` adds to the end. `replace` overwrites the whole transcript, which
 * is what a compaction produces: a summary plus a recent tail, sharing no
 * prefix with what came before.
 */
export type NahSessionStore = {
	/** The transcript so far. Empty for a session that has not run. */
	load(sessionId: string): Promise<ModelMessage[]>;
	/** Add messages to the end. */
	append(sessionId: string, messages: ModelMessage[]): Promise<void>;
	/** Overwrite the transcript. */
	replace(sessionId: string, messages: ModelMessage[]): Promise<void>;
};

/**
 * An in-memory store.
 *
 * Right for a single long-lived Node server, and for tests. Wrong for a
 * serverless platform, where each request may land on a different instance —
 * a second instance sees an empty conversation and the agent starts over.
 */
export const createMemorySessionStore = (): NahSessionStore => {
	const sessions = new Map<string, ModelMessage[]>();

	return {
		async load(sessionId) {
			const messages = sessions.get(sessionId);
			// A copy, so a caller that mutates what it was given cannot corrupt the
			// store without going through `append` — and so a compaction that
			// rewrites the array it was handed does not rewrite the store's.
			return messages ? [...messages] : [];
		},

		async append(sessionId, messages) {
			if (messages.length === 0) return;
			const existing = sessions.get(sessionId) ?? [];
			existing.push(...messages);
			sessions.set(sessionId, existing);
		},

		async replace(sessionId, messages) {
			sessions.set(sessionId, [...messages]);
		},
	};
};

/**
 * A log of the frames a session has produced.
 *
 * Separate from the session store because the two have different lifetimes and
 * different shapes: the transcript is the conversation, and the log is a
 * *record of the delivery* of that conversation's events. Keeping them apart
 * means an app can keep transcripts for a year and frames for an hour.
 *
 * It is what makes a reconnect work. A client that lost its connection asks
 * for "everything after frame 42" and gets it, rather than starting the
 * conversation over.
 */
export type NahEventLog = {
	/** Record one frame. */
	append(frame: NahFrame): Promise<void>;
	/** The frames of a session, oldest first. `afterSeq` excludes what came before. */
	read(sessionId: string, afterSeq?: number): Promise<NahFrame[]>;
};

/**
 * An in-memory log.
 *
 * Bounded per session, because an unbounded log is a memory leak with a
 * friendly name. The default keeps 500 frames per session, which is enough to
 * cover a reconnect and short enough that a forgotten session does not cost
 * much.
 */
export const createMemoryEventLog = (
	options: { maxFramesPerSession?: number } = {},
): NahEventLog => {
	const max = options.maxFramesPerSession ?? 500;
	const sessions = new Map<string, NahFrame[]>();

	return {
		async append(frame) {
			const frames = sessions.get(frame.sessionId) ?? [];
			frames.push(frame);
			if (frames.length > max) frames.splice(0, frames.length - max);
			sessions.set(frame.sessionId, frames);
		},

		async read(sessionId, afterSeq) {
			const frames = sessions.get(sessionId) ?? [];
			if (afterSeq === undefined) return [...frames];
			return frames.filter((frame) => frame.seq > afterSeq);
		},
	};
};

/** A fresh session id. */
export const createSessionId = (): string =>
	globalThis.crypto.randomUUID();

/** A fresh turn id. */
export const createRunId = (): string => globalThis.crypto.randomUUID();
