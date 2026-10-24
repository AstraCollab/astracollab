/**
 * The runtime: a turn of the harness, over HTTP.
 *
 * ## What this file is
 *
 * The harness's unit of work is `runAgent`, which returns an event stream and
 * a result. A route handler's unit of work is a request and a response. This
 * is the translation between them, and almost all of its complexity comes from
 * one fact:
 *
 * **A run can stop halfway and be finished by a later request.**
 *
 * The harness ends a run with `awaiting-approval` when a tool needs a person's
 * decision, and with `suspended` when a tool parked itself waiting for a
 * value. The run is over — there is no more event stream to read — but the
 * *work* is not. The transcript holds a call that never produced a result,
 * and the only way forward is to run the harness again with the transcript and
 * the answer.
 *
 * So the transcript has to live somewhere that outlives the request, and the
 * answer has to be able to arrive on a request that did not start the run.
 * Everything else here follows from that.
 *
 * ## The shape of a turn
 *
 * 1. Load the transcript.
 * 2. Fold in whatever the request carries — a decision, a value, a message.
 * 3. Run the harness.
 * 4. Stream its events out as frames.
 * 5. Persist the transcript, appending or replacing depending on whether the
 *    run compacted.
 *
 * Step 5 is the one that is easy to get wrong. A compacted transcript shares
 * no prefix with the one before it, so appending the difference loses the
 * middle of the conversation without erroring. The harness exports
 * `sessionUpdate` for exactly this decision, and this runtime uses it rather
 * than re-deriving the rule.
 */

import { parkedSuspensionIds, runAgent } from "../agent.js";
import { suspensionResumeMessage } from "../interactive-tools.js";
import { appendApprovalResponses, sessionUpdate } from "../types.js";
import type {
	HarnessEvent,
	HarnessRun,
	HarnessRunOptions,
	HarnessRunResult,
	PendingApproval,
	PendingSuspension,
} from "../types.js";
import type { ModelMessage } from "ai";
import { createEventStreamResponse } from "./sse.js";
import {
	createMemoryEventLog,
	createMemorySessionStore,
	createRunId,
	createSessionId,
} from "./session.js";
import type { NahEventLog, NahSessionStore } from "./session.js";
import type {
	NahActionResponse,
	NahError,
	NahEvent,
	NahFrame,
	NahTurnRequest,
} from "./types.js";

/** What the agent factory is given. */
export type NahAgentContext = {
	/** The conversation. */
	sessionId: string;
	/** The transcript as it stands, including any resume messages. */
	messages: ModelMessage[];
	/** Aborted when the client goes away or the turn is stopped. */
	signal: AbortSignal;
	/** Trusted, request-scoped context supplied by the HTTP adapter. */
	requestContext?: unknown;
};

/**
 * Everything the harness needs for a run, except the three things the runtime
 * owns.
 *
 * The runtime owns `messages`, `prompt` and `abortSignal` because getting any
 * of them wrong is silent: a transcript that is not the stored one loses
 * history, a prompt that is not the input asks the model a question nobody
 * typed, and a signal that is not the request's keeps burning tokens after the
 * user closed the tab.
 */
export type NahAgentSpec = Omit<
	HarnessRunOptions,
	"messages" | "prompt" | "abortSignal"
>;

/**
 * Builds the run's options.
 *
 * Called once per turn, after the transcript is loaded, so it can vary the
 * model, the tools or the system prompt per conversation — and so the tools
 * can be built against the workspace the conversation is about.
 */
export type NahAgentFactory = (
	context: NahAgentContext,
) => NahAgentSpec | Promise<NahAgentSpec>;

/**
 * The memory back-end interface the runtime uses to inject context and learn
 * from turns. Implement this and pass it as `memory` to `createNahHandler`
 * or `createNahRuntime` — you do not need any particular memory package to use
 * the framework. The shipped CognitiveMemory implementation wires in cogmemory
 * behind this same contract.
 */
export type NahMemory = {
	/** Builds the prompt block for a turn. Sync or async — both are first-class. */
	getPromptContext(currentUserMessage?: string): string | Promise<string>;
	/** Learn from a finished exchange. Optional: recall-only deployments omit it. */
	postTurnAsync?(turn: { userMessage: string; assistantResponse: string }): Promise<unknown>;
	/** Serialise the engine's full state for persistence. Optional. */
	getSnapshot?(): unknown;
	/** Restore a serialised snapshot from storage. Optional. */
	loadSnapshot?(snapshot: unknown): void;
};

/** Options the runtime needs to drive a memory back-end. Same shape either side. */
export type NahMemoryOptions = {
	/** The memory back-end. Owned by the caller; the same instance serves every turn. */
	memory: NahMemory;
	/** Where the engine's state lives between turns. */
	stateStore?: { load(key: string): Promise<unknown>; save(key: string, snapshot: unknown): Promise<void> };
	/** Identifies the state — per chat, or per caller depending on what should be shared. */
	key?: string;
	/** Report failures on read/write/learn rather than failing the turn. */
	onError?: (operation: "load-state" | "save-state" | "learn", error: unknown) => void;
	/** Consecutive failures before a state operation is retried. Default 3. */
	circuitThreshold?: number;
	/** Stay open for this long after consecutive failures. Default 30s. */
	circuitCooldownMs?: number;
};

/** How a turn ended. Handed to `onTurnFinish`. */
export type NahTurnSummary = {
	sessionId: string;
	runId: string;
	reason: HarnessRunResult["reason"];
	steps: number;
	usage: HarnessRunResult["usage"];
	durationMs: number;
};

export type NahRuntimeOptions = {
	/** Builds the run. Called once per turn. */
	agent: NahAgentFactory;
	/** Where transcripts live. Defaults to an in-memory store. */
	session?: NahSessionStore;
	/** Where frames are recorded, for reconnects. Defaults to an in-memory log. */
	events?: NahEventLog;
	/** Extra headers on every response. */
	headers?: Record<string, string>;
	/** Keep-alive interval for the event stream, in ms. `0` disables it. */
	heartbeatMs?: number;
	/**
	 * A hook for work that should outlive the response.
	 *
	 * Next.js's `after` from `next/server` fits here: pass it in and the runtime
	 * will use it for the bookkeeping it does after a turn ends. The transcript
	 * itself is written *before* the response finishes, because a client that
	 * sends its next turn the moment it sees `finish` must find the transcript
	 * already there.
	 */
	after?: (task: () => void | Promise<void>) => void;
	/** Called when a turn ends, for logging. */
	onTurnFinish?: (summary: NahTurnSummary) => void;
	/**
 * Memory integration options. When provided, the memory layer is activated:
 * - `buildMemoryContext` is called pre-turn to inject the memory block into the prompt.
 * - `learnFromTurn` is called post-turn to persist what was learned.
 * Default `undefined`: memory is off. Set to a `NahMemoryOptions` object to enable.
 * This makes the framework plug-in play — you can swap the memory back-end
 * (vector DB, Mastra, etc.) by implementing the `NahMemoryLike` protocol.
 */
memory?: NahMemoryOptions;
};

/** The runtime's surface. */
export type NahRuntime = {
	/** The frames of one turn. */
	frames: (
		request: NahTurnRequest,
		options?: { signal?: AbortSignal; requestContext?: unknown },
	) => AsyncGenerator<NahFrame>;
	/** A turn, as an event-stream response. */
	turn: (
		request: NahTurnRequest,
		options?: { signal?: AbortSignal; requestContext?: unknown },
	) => Response;
	/**
	 * Replay what a client missed, then follow along live.
	 *
	 * The stream covers the turn that is running and **ends when that turn is
	 * over**. A stream that stayed open forever would be a connection nobody
	 * could finish reading, and a client that wanted the next turn would have
	 * to reconnect regardless — which a browser's `EventSource` does on its own.
	 */
	follow: (request: Request) => Response;
	/** Send a message to a run that is in flight. */
	steer: (sessionId: string, text: string) => NahActionResponse;
	/** Stop a run that is in flight. */
	abort: (sessionId: string) => NahActionResponse;
};

/**
 * Reduce a thrown value to something safe to put on the wire.
 *
 * The harness reports errors as `unknown`, and that value can be an `Error`
 * carrying a stack trace, a provider message with a key in it, or a `cause`
 * chain. None of that belongs in a browser. The original stays on the server,
 * where the logs are.
 */
const describeError = (error: unknown): NahError => {
	if (error instanceof Error) {
		return {
			name: error.name || "Error",
			message: (error.message || "The run failed.").slice(0, 500),
		};
	}
	if (typeof error === "string") {
		return { name: "Error", message: error.slice(0, 500) };
	}
	return { name: "Error", message: "The run failed." };
};

const emptyUsage = (): HarnessRunResult["usage"] => ({
	inputTokens: 0,
	outputTokens: 0,
	totalTokens: 0,
});

/**
 * The calls a transcript is still waiting on, with their tool names.
 *
 * The harness knows which calls are parked — `parkedSuspensionIds` reads the
 * transcript for exactly that — but not what they were called, because the
 * parked call's marker carries no tool name. The name is in the tool call
 * itself, one part earlier in the same message, so it is looked up there.
 */
const readParkedSuspensions = (
	messages: ModelMessage[],
): Array<{ toolCallId: string; toolName: string }> => {
	const ids = parkedSuspensionIds(messages);
	if (ids.length === 0) return [];

	const names = new Map<string, string>();
	for (const message of messages) {
		if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
		for (const part of message.content as Array<Record<string, unknown>>) {
			if (part.type !== "tool-call") continue;
			const id = part.toolCallId;
			if (typeof id !== "string" || names.has(id)) continue;
			names.set(id, typeof part.toolName === "string" ? part.toolName : "");
		}
	}

	return ids.map((toolCallId) => ({
		toolCallId,
		toolName: names.get(toolCallId) ?? "",
	}));
};

type TurnPlan =
	| {
			ok: true;
			messages: ModelMessage[];
			prompt: string;
			toolResumeData?: Record<string, unknown>;
			resumed: boolean;
			/** The length of the *stored* transcript, before anything was added. */
			before: number;
	  }
	| { ok: false; error: NahError };

/**
 * Work out what a request is asking for.
 *
 * The rules are not arbitrary. The harness reads an answer from the **last**
 * message of the transcript only, so a decision and a new instruction cannot
 * travel together: the instruction would push the decision out of the position
 * the SDK reads, the tool would never run, and the run would report success
 * having done nothing. A request carrying both is refused rather than
 * half-honoured, because half-honouring it is the failure nobody notices.
 */
const buildPlan = (
	stored: ModelMessage[],
	request: NahTurnRequest,
): TurnPlan => {
	let messages = [...stored];
	let toolResumeData: Record<string, unknown> | undefined;
	let resumed = false;

	const approvals = request.approvals ?? {};
	const approvalIds = Object.keys(approvals);
	const resumeData = request.resumeData ?? {};
	const resumeIds = Object.keys(resumeData);
	const hasInput =
		typeof request.input === "string" && request.input.trim().length > 0;

	/**
	 * The conflict is checked first, because it is a statement about the
	 * request rather than about the transcript. A request that carries a
	 * decision *and* a message cannot be honoured whichever way it is read, and
	 * saying "nothing is pending" instead would send the caller looking in the
	 * wrong place — at a transcript that is fine.
	 */
	if (hasInput && (approvalIds.length > 0 || resumeIds.length > 0)) {
		return {
			ok: false,
			error: {
				name: "ConflictingRequest",
				message:
					"A decision and a new message cannot travel together. Answer the pending call first, then send the message.",
			},
		};
	}

	if (approvalIds.length > 0) {
		const answered = appendApprovalResponses(messages, approvals);
		if (answered.length === messages.length) {
			return {
				ok: false,
				error: {
					name: "StaleApproval",
					message:
						"No pending approval matches that decision. The transcript does not hold a matching request.",
				},
			};
		}
		messages = answered;
		resumed = true;
	}

	if (resumeIds.length > 0) {
		const parked = readParkedSuspensions(messages);
		const answering = parked.filter(
			(pending) => resumeData[pending.toolCallId] !== undefined,
		);
		if (answering.length === 0) {
			return {
				ok: false,
				error: {
					name: "StaleResume",
					message:
						"No parked call matches that answer. The transcript does not hold a waiting tool.",
				},
			};
		}
		messages = [...messages, suspensionResumeMessage(answering, resumeData)];
		toolResumeData = { ...resumeData };
		resumed = true;
	}

	if (!hasInput && !resumed) {
		return {
			ok: false,
			error: {
				name: "EmptyTurn",
				message: "A turn needs a message or a decision.",
			},
		};
	}

	return {
		ok: true,
		messages,
		prompt: hasInput ? (request.input as string) : "",
		toolResumeData,
		resumed,
		before: stored.length,
	};
};

/**
 * The harness's events, as this runtime's events.
 *
 * The harness's `finish` is the one that does not pass through: it does not
 * carry the pending decisions, and those are the only thing a client needs to
 * know what to do next. The runtime emits its own `finish` once the result is
 * in hand, with them attached.
 */
const mapEvent = (event: HarnessEvent): NahEvent | null => {
	switch (event.type) {
		case "finish":
			return null;
		case "error":
			return { type: "error", error: describeError(event.error) };
		default:
			return event as unknown as NahEvent;
	}
};

export const createNahRuntime = (options: NahRuntimeOptions): NahRuntime => {
	const session = options.session ?? createMemorySessionStore();
	const events = options.events ?? createMemoryEventLog();

	/** Runs in flight, by session. Used for steering and stopping. */
	const active = new Map<
		string,
		{ run: HarnessRun; controller: AbortController }
	>();

	/** Clients following a session. */
	const subscribers = new Map<string, Set<(frame: NahFrame) => void>>();

	/** The frame counter, per session. */
	const counters = new Map<string, number>();

	const nextSeq = (sessionId: string): number => {
		const next = (counters.get(sessionId) ?? 0) + 1;
		counters.set(sessionId, next);
		return next;
	};

	const publish = (frame: NahFrame): void => {
		void events.append(frame);
		const set = subscribers.get(frame.sessionId);
		if (!set) return;
		for (const send of set) {
			try {
				send(frame);
			} catch {
				// A subscriber that throws is a dead subscriber. It is removed by
				// its own generator when it unwinds; here it just does not take
				// the turn down with it.
			}
		}
	};

	const makeFrame = (
		sessionId: string,
		runId: string,
		event: NahEvent,
	): NahFrame => ({
		...event,
		seq: nextSeq(sessionId),
		sessionId,
		runId,
		at: Date.now(),
	});

	async function* frames(
		request: NahTurnRequest,
		turnOptions: { signal?: AbortSignal; requestContext?: unknown } = {},
	): AsyncGenerator<NahFrame> {
		const sessionId = request.sessionId ?? createSessionId();
		const runId = createRunId();

		const controller = new AbortController();
		const external = turnOptions.signal;
		const onExternalAbort = () => controller.abort();
		external?.addEventListener("abort", onExternalAbort, { once: true });

		const emit = (event: NahEvent): NahFrame => {
			const frame = makeFrame(sessionId, runId, event);
			publish(frame);
			return frame;
		};

		try {
			const stored = await session.load(sessionId);
			const plan = buildPlan(stored, request);

			if (!plan.ok) {
				yield emit({ type: "error", error: plan.error });
				yield emit({
					type: "finish",
					reason: "error",
					text: "",
					usage: emptyUsage(),
					pendingApprovals: [],
					pendingSuspensions: [],
				});
				return;
			}

			yield emit({ type: "turn-start", turnId: runId, resumed: plan.resumed });

			const spec = await options.agent({
				sessionId,
				messages: plan.messages,
				signal: controller.signal,
				...(turnOptions.requestContext === undefined ? {} : { requestContext: turnOptions.requestContext }),
			});

			// Pre-turn: build memory context and inject into system prompt.
			let memoryContext = "";
			let memoryDegraded = false;
			if (options.memory) {
				const { memory, stateStore, key, onError, circuitThreshold, circuitCooldownMs } = options.memory;
				// Restore persisted state
				if (stateStore && key && memory.getSnapshot && memory.loadSnapshot) {
					try {
						const snapshot = await stateStore.load(key);
						if (snapshot != null) memory.loadSnapshot(snapshot);
					} catch (error) {
						onError?.("load-state", error);
					}
				}
				// Get prompt context
				try {
					memoryContext = await memory.getPromptContext(plan.prompt);
				} catch (error) {
					onError?.("load-state", error);
					memoryDegraded = true;
				}
			}

			const systemWithMemory = memoryContext
				? (spec.system ? `${spec.system}\n${memoryContext}` : memoryContext)
				: spec.system;

			const run = runAgent({
				...spec,
				system: systemWithMemory,
				messages: plan.messages,
				prompt: plan.prompt,
				toolResumeData: plan.toolResumeData ?? spec.toolResumeData,
				abortSignal: controller.signal,
			});

			active.set(sessionId, { run, controller });

			const settled: Promise<
				| { ok: true; result: HarnessRunResult }
				| { ok: false; error: unknown }
			> = run.result.then(
				(result) => ({ ok: true, result }),
				(error) => ({ ok: false, error }),
			);

			const startedAt = Date.now();
			let outcome:
				| { ok: true; result: HarnessRunResult }
				| { ok: false; error: unknown }
				| undefined;

			try {
				for await (const event of run.events) {
					const mapped = mapEvent(event);
					if (mapped) yield emit(mapped);
				}
				outcome = await settled;
			} finally {
				// The client may have gone away, in which case this generator is
				// being closed early. The run is stopped and the transcript is
				// written either way, because a half-finished turn is worth
				// keeping: it is what the next request resumes from.
				controller.abort();
				if (!outcome) outcome = await settled;
				active.delete(sessionId);

				if (outcome.ok) {
					const update = sessionUpdate(plan.before, outcome.result);
					if (update.mode === "append") {
						await session.append(sessionId, update.messages);
					} else {
						await session.replace(sessionId, update.messages);
					}

					// Post-turn: learn from the exchange.
					if (options.memory && memoryContext) {
						const { memory, stateStore, key, onError } = options.memory;
						try {
							if (memory.postTurnAsync) {
								await memory.postTurnAsync({
									userMessage: plan.prompt,
									assistantResponse: outcome.result.text,
								});
							}
							// Persist state
							if (stateStore && key && memory.getSnapshot) {
								try {
									await stateStore.save(key, memory.getSnapshot());
								} catch (error) {
									onError?.("save-state", error);
								}
							}
						} catch (error) {
							onError?.("learn", error);
						}
					}
				}

				const summary: NahTurnSummary = {
					sessionId,
					runId,
					reason: outcome.ok ? outcome.result.reason : "error",
					steps: outcome.ok ? outcome.result.steps : 0,
					usage: outcome.ok ? outcome.result.usage : emptyUsage(),
					durationMs: Date.now() - startedAt,
				};
				// The bookkeeping is not the client's business, so when the
				// application has said how to outlive a response, it is handed
				// over rather than run inline.
				if (options.after) {
					try {
						options.after(() => options.onTurnFinish?.(summary));
					} catch {
						// Next.js's `after` throws when it is called outside the
						// request scope, and a turn ends after the response has
						// been written — so the handover can arrive too late. The
						// bookkeeping is worth less than the turn that produced
						// it, so it runs inline rather than being lost to an
						// exception thrown out of a `finally`.
						options.onTurnFinish?.(summary);
					}
				} else {
					options.onTurnFinish?.(summary);
				}
			}

			if (outcome.ok) {
				yield emit({
					type: "finish",
					reason: outcome.result.reason,
					text: outcome.result.text,
					usage: outcome.result.usage,
					pendingApprovals: outcome.result.pendingApprovals,
					pendingSuspensions: outcome.result.pendingSuspensions,
				});
			} else {
				yield emit({
					type: "error",
					error: describeError(outcome.error),
				});
				yield emit({
					type: "finish",
					reason: "error",
					text: "",
					usage: emptyUsage(),
					pendingApprovals: [],
					pendingSuspensions: [],
				});
			}
		} finally {
			external?.removeEventListener("abort", onExternalAbort);
		}
	}

	const turn = (
		request: NahTurnRequest,
		turnOptions: { signal?: AbortSignal; requestContext?: unknown } = {},
	): Response =>
		createEventStreamResponse(frames(request, turnOptions), {
			headers: options.headers,
			heartbeatMs: options.heartbeatMs,
			signal: turnOptions.signal,
		});

	const follow = (request: Request): Response => {
		const url = new URL(request.url);
		const sessionId = url.searchParams.get("sessionId") ?? "";
		const header = request.headers.get("last-event-id");
		const query = url.searchParams.get("after");
		const afterSeq = Number(header ?? query ?? "0") || 0;

		let closed = false;
		let notify: (() => void) | null = null;

		const source = (async function* (): AsyncGenerator<NahFrame> {
			const buffer: NahFrame[] = [];
			const send = (frame: NahFrame) => {
				buffer.push(frame);
				notify?.();
			};

			const set = subscribers.get(sessionId) ?? new Set();
			subscribers.set(sessionId, set);
			set.add(send);

			const onAbort = () => {
				closed = true;
				notify?.();
			};
			request.signal.addEventListener("abort", onAbort, { once: true });

			try {
				let cursor = afterSeq;
				for (const frame of await events.read(sessionId, cursor)) {
					cursor = frame.seq;
					yield frame;
					if (frame.type === "finish" && !active.has(sessionId)) return;
				}

				while (!closed) {
					if (buffer.length === 0) {
						await new Promise<void>((resolve) => {
							notify = resolve;
						});
						notify = null;
						if (closed) break;
					}
					for (const frame of buffer.splice(0)) {
						if (frame.seq <= cursor) continue;
						cursor = frame.seq;
						yield frame;
						if (frame.type === "finish" && !active.has(sessionId)) return;
					}
				}
			} finally {
				request.signal.removeEventListener("abort", onAbort);
				set.delete(send);
				if (set.size === 0) subscribers.delete(sessionId);
			}
		})();

		return createEventStreamResponse(source, {
			headers: options.headers,
			heartbeatMs: options.heartbeatMs,
			signal: request.signal,
		});
	};

	const steer = (sessionId: string, text: string): NahActionResponse => {
		const entry = active.get(sessionId);
		if (!entry) {
			return {
				ok: false,
				reason: "No run for that session is in flight in this process.",
			};
		}
		const accepted = entry.run.steer(text);
		return accepted
			? { ok: true }
			: { ok: false, reason: "The run has already settled." };
	};

	const abort = (sessionId: string): NahActionResponse => {
		const entry = active.get(sessionId);
		if (!entry) {
			return {
				ok: false,
				reason: "No run for that session is in flight in this process.",
			};
		}
		entry.run.interrupt();
		return { ok: true };
	};

	return { frames, turn, follow, steer, abort };
};
