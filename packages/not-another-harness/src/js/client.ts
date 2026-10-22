"use client";

/**
 * The browser half of the runtime.
 *
 * ## What this hook is for
 *
 * Rendering a harness run needs three things the raw protocol does not give
 * you: the text so far, the decisions the run is waiting on, and a way to
 * answer them. This hook is the small amount of state that turns a stream of
 * frames into those three things.
 *
 * It is a hook and not a component library because the shape of the UI is the
 * application's business — a chat transcript, a terminal, a side panel — and
 * the two decisions it does have to make for you are the ones that are easy to
 * get wrong:
 *
 *  - **A resume is a new request.** When a run stops for an approval, the
 *    answer goes back in a fresh `POST` carrying the decision. It does not
 *    ride on the same connection, because the run is over as far as that
 *    connection is concerned — the harness has ended it, and the transcript
 *    now holds the parked call.
 *  - **A decision and a new message cannot share a request.** The harness reads
 *    a decision from the last message of the transcript only, so sending both
 *    would push the decision out of the position the SDK reads and the tool
 *    would silently never run. `send` and `approve` are separate calls for
 *    that reason.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { parseEventStream } from "./sse.js";
import type { NahFrame } from "./types.js";

/** Where the run is. */
export type NahChatStatus =
	| "idle" /** Nothing running. */
	| "submitted" /** The request is out; no frame has arrived yet. */
	| "streaming" /** Frames are arriving. */
	| "error"; /** The run failed. */

/** One message in the transcript. */
export type NahChatMessage = {
	id: string;
	role: "user" | "assistant";
	text: string;
};

/** A tool waiting for a yes/no decision. */
export type NahPendingApproval = {
	approvalId: string;
	toolCallId: string;
	toolName: string;
	input: unknown;
	reason?: string;
};

/** A tool waiting for a value. */
export type NahPendingSuspension = {
	toolCallId: string;
	toolName: string;
	payload: unknown;
	input?: unknown;
};

export type UseNahChatOptions = {
	/** Where turns are posted. Default `/api/nah`. */
	api?: string;
	/**
	 * The conversation.
	 *
	 * Defaults to one generated per mount, so two hook instances on a page are
	 * two conversations. Pass an id to share one.
	 */
	sessionId?: string;
	/** Called for every frame, for callers that want their own view of the run. */
	onFrame?: (frame: NahFrame) => void;
};

export type UseNahChatResult = {
	messages: NahChatMessage[];
	status: NahChatStatus;
	error: Error | null;
	/** Tools waiting for a decision. */
	pendingApprovals: NahPendingApproval[];
	/** Tools waiting for a value. */
	pendingSuspensions: NahPendingSuspension[];
	/** Send a message. Starts a turn. */
	send: (text: string) => Promise<void>;
	/** Answer a held call. Resumes the paused run. */
	approve: (
		approvalId: string,
		approved: boolean,
		reason?: string,
	) => Promise<void>;
	/** Answer a parked call. Resumes the paused run. */
	answer: (toolCallId: string, value: unknown) => Promise<void>;
	/** Abort the run in flight. */
	stop: () => void;
	/** Clear the transcript and any pending decisions. */
	reset: () => void;
};

const newId = (): string =>
	globalThis.crypto?.randomUUID?.() ?? `nah-${Date.now()}-${Math.random()}`;

export const useNahChat = (
	options: UseNahChatOptions = {},
): UseNahChatResult => {
	const api = options.api ?? "/api/nah";
	const [messages, setMessages] = useState<NahChatMessage[]>([]);
	const [status, setStatus] = useState<NahChatStatus>("idle");
	const [error, setError] = useState<Error | null>(null);
	const [pendingApprovals, setPendingApprovals] = useState<
		NahPendingApproval[]
	>([]);
	const [pendingSuspensions, setPendingSuspensions] = useState<
		NahPendingSuspension[]
	>([]);

	// The session id is stable across renders but is not state: changing it is
	// not something the UI does, and making it state would mean a re-render
	// whenever it was assigned.
	const sessionIdRef = useRef<string>(options.sessionId ?? newId());
	useEffect(() => {
		if (options.sessionId) sessionIdRef.current = options.sessionId;
	}, [options.sessionId]);

	const abortRef = useRef<AbortController | null>(null);
	const assistantIdRef = useRef<string | null>(null);
	const onFrameRef = useRef(options.onFrame);
	useEffect(() => {
		onFrameRef.current = options.onFrame;
	}, [options.onFrame]);

	useEffect(() => () => abortRef.current?.abort(), []);

	const appendAssistantText = useCallback((text: string) => {
		setMessages((current) => {
			const id = assistantIdRef.current;
			if (!id) return current;
			const index = current.findIndex((message) => message.id === id);
			if (index === -1) return current;
			const next = [...current];
			const message = next[index];
			if (!message) return current;
			next[index] = { ...message, text: message.text + text };
			return next;
		});
	}, []);

	const applyFrame = useCallback(
		(frame: NahFrame) => {
			onFrameRef.current?.(frame);

			switch (frame.type) {
				case "turn-start": {
					// The id goes in a local first: the ref is nullable, and the
					// state updater runs later, when the ref could have moved on.
					const id = newId();
					assistantIdRef.current = id;
					setMessages((current) => [
						...current,
						{ id, role: "assistant", text: "" },
					]);
					break;
				}
				case "text-delta":
					appendAssistantText(frame.text);
					break;
				case "tool-approval-request":
					if (!frame.isAutomatic) {
						setPendingApprovals((current) => [
							...current,
							{
								approvalId: frame.approvalId,
								toolCallId: frame.toolCallId,
								toolName: frame.toolName,
								input: frame.input,
								...(frame.reason === undefined ? {} : { reason: frame.reason }),
							},
						]);
					}
					break;
				case "tool-suspended":
					setPendingSuspensions((current) => [
						...current,
						{
							toolCallId: frame.toolCallId,
							toolName: frame.toolName,
							payload: frame.payload,
							...(frame.input === undefined ? {} : { input: frame.input }),
						},
					]);
					break;
				case "finish":
					setPendingApprovals(frame.pendingApprovals);
					setPendingSuspensions(frame.pendingSuspensions);
					break;
				case "error":
					setError(new Error(frame.error.message));
					break;
				default:
					break;
			}
		},
		[appendAssistantText],
	);

	const post = useCallback(
		async (body: Record<string, unknown>) => {
			abortRef.current?.abort();
			const controller = new AbortController();
			abortRef.current = controller;

			setStatus("submitted");
			setError(null);

			try {
				const response = await fetch(api, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ ...body, sessionId: sessionIdRef.current }),
					signal: controller.signal,
				});

				if (!response.ok || !response.body) {
					const text = await response.text().catch(() => "");
					throw new Error(
						text || `The turn failed with ${response.status}.`,
					);
				}

				for await (const frame of parseEventStream(response)) {
					if (frame.type === "text-delta" || frame.type === "step-start") {
						setStatus("streaming");
					}
					applyFrame(frame);
				}
				setStatus("idle");
			} catch (caught) {
				if ((caught as Error)?.name === "AbortError") {
					setStatus("idle");
					return;
				}
				setError(caught instanceof Error ? caught : new Error(String(caught)));
				setStatus("error");
			} finally {
				if (abortRef.current === controller) abortRef.current = null;
			}
		},
		[api, applyFrame],
	);

	const send = useCallback(
		async (text: string) => {
			const trimmed = text.trim();
			if (!trimmed) return;
			setMessages((current) => [
				...current,
				{ id: newId(), role: "user", text: trimmed },
			]);
			await post({ input: trimmed });
		},
		[post],
	);

	const approve = useCallback(
		async (approvalId: string, approved: boolean, reason?: string) => {
			setPendingApprovals((current) =>
				current.filter((pending) => pending.approvalId !== approvalId),
			);
			await post({
				approvals: {
					[approvalId]: { approved, ...(reason === undefined ? {} : { reason }) },
				},
			});
		},
		[post],
	);

	const answer = useCallback(
		async (toolCallId: string, value: unknown) => {
			setPendingSuspensions((current) =>
				current.filter((pending) => pending.toolCallId !== toolCallId),
			);
			await post({ resumeData: { [toolCallId]: value } });
		},
		[post],
	);

	const stop = useCallback(() => {
		abortRef.current?.abort();
	}, []);

	const reset = useCallback(() => {
		abortRef.current?.abort();
		assistantIdRef.current = null;
		setMessages([]);
		setPendingApprovals([]);
		setPendingSuspensions([]);
		setError(null);
		setStatus("idle");
	}, []);

	return useMemo(
		() => ({
			messages,
			status,
			error,
			pendingApprovals,
			pendingSuspensions,
			send,
			approve,
			answer,
			stop,
			reset,
		}),
		[
			messages,
			status,
			error,
			pendingApprovals,
			pendingSuspensions,
			send,
			approve,
			answer,
			stop,
			reset,
		],
	);
};
