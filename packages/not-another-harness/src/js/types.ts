/**
 * The wire protocol between a Next.js route handler and its browser client.
 *
 * ## Why this file exists
 *
 * The harness has an event stream, but it is an in-process `AsyncIterable` — a
 * Node object with a lifetime of one function call. A browser cannot consume
 * that: the request ends, the process may be recycled, and the events are gone.
 *
 * So there has to be a *transport* contract between the two, and it has to be
 * written down rather than implied. This is that contract. It is deliberately
 * narrow: every frame is a small JSON object with a `type`, so a client can
 * `switch` on it, and an event this runtime does not know about is skipped
 * rather than crashing the connection.
 *
 * ## The one rule that shapes everything else
 *
 * **A turn can stop and be continued by a later request.** The harness ends a
 * run with `awaiting-approval` when a tool needs a person's decision, and with
 * `suspended` when a tool parked itself waiting for a value. Neither is an
 * error: the run is *paused*, and the pause has to survive the end of the HTTP
 * response.
 *
 * That is why the transcript lives in a store and not in the request, why
 * `finish` carries `pendingApprovals` and `pendingSuspensions`, and why a
 * resume is a fresh request carrying the decision rather than a second message
 * on the same connection. A protocol that could not express "the run paused,
 * answer this, carry on" would force every client to reimplement the pause on
 * its own, and they would all get it slightly wrong.
 */

import type {
	HarnessRequestBreakdown,
	HarnessSteerDelivery,
	HarnessStopReason,
	HarnessUsage,
	PendingApproval,
	PendingSuspension,
	ToolApprovalAnswers,
} from "../types.js";

/**
 * A failure, flattened into something a browser can show.
 *
 * The harness reports errors as `unknown` — an `Error`, a string, whatever the
 * provider threw — and that value is not safe to put on the wire: it can carry
 * a stack trace, an API key in a message, or a `cause` chain nobody asked for.
 * So the runtime reduces it to a name and a message, and keeps the original
 * on the server, where the logs are.
 */
export type NahError = {
	/** The error's constructor name, or `"Error"`. */
	name: string;
	/** The message, truncated. */
	message: string;
};

/** The events a client can receive. */
export type NahEvent =
	/**
	 * The runtime accepted a request and is about to run the harness.
	 *
	 * Separate from the harness's own `run-start` because this one is about the
	 * *request* — it is emitted before the agent exists, and it is the frame a
	 * client can rely on to know the server understood what was asked.
	 */
	| { type: "turn-start"; turnId: string; resumed: boolean }
	/** The harness started a run. `stepBudget` is null when the run is unbounded. */
	| { type: "run-start"; stepBudget: number | null; tokenBudget: number }
	| { type: "step-start"; step: number }
	| { type: "text-delta"; step: number; text: string }
	| {
			type: "tool-call";
			step: number;
			toolCallId: string;
			toolName: string;
			input: unknown;
	  }
	| {
			type: "tool-result";
			step: number;
			toolCallId: string;
			toolName: string;
			output: string;
			isError: boolean;
	  }
	/**
	 * A tool is waiting for a decision.
	 *
	 * The call has **not run** and will not until the decision comes back in a
	 * later request. A client that renders only `tool-call` and `tool-result`
	 * shows a call that hangs forever.
	 */
	| {
			type: "tool-approval-request";
			step: number;
			approvalId: string;
			toolCallId: string;
			toolName: string;
			input: unknown;
			reason?: string;
			/** True when the gate decided on its own. Nothing is waiting. */
			isAutomatic: boolean;
	  }
	/** A held call was answered. */
	| {
			type: "tool-approval-response";
			step: number;
			approvalId: string;
			toolCallId: string;
			approved: boolean;
			reason?: string;
	  }
	/**
	 * A tool parked itself and is waiting for a value.
	 *
	 * Different from an approval: the tool *ran*, and decided it needed
	 * something. An approval is a yes/no permission question; this carries an
	 * open-ended typed value the tool defines.
	 */
	| {
			type: "tool-suspended";
			step: number;
			toolCallId: string;
			toolName: string;
			payload: unknown;
			input?: unknown;
	  }
	/** A parked call was answered and its tool re-ran. */
	| { type: "tool-resumed"; step: number; toolCallId: string; toolName: string }
	| {
			type: "step-finish";
			step: number;
			usage: HarnessUsage;
			request: HarnessRequestBreakdown;
	  }
	| {
			type: "compacted";
			droppedMessages: number;
			keptMessages: number;
			summaryChars: number;
	  }
	/** The run is ending by design, not because it broke. */
	| { type: "wrap-up"; reason: HarnessStopReason }
	| {
			type: "user-message";
			text: string;
			delivery: HarnessSteerDelivery;
			phase: "queued" | "delivered";
	  }
	/**
	 * The run ended.
	 *
	 * Carries the pending decisions, because this frame is the only place a
	 * client learns what it still owes the run. The harness's own `finish` event
	 * does not have them — they live on the result — so the runtime merges them
	 * in rather than forwarding the event unchanged.
	 */
	| {
			type: "finish";
			reason: HarnessStopReason;
			text: string;
			usage: HarnessUsage;
			/** Calls waiting for a decision. Non-empty only on `awaiting-approval`. */
			pendingApprovals: PendingApproval[];
			/** Calls parked by a tool. Non-empty only on `suspended`. */
			pendingSuspensions: PendingSuspension[];
	  }
	| { type: "error"; error: NahError }
	/** Keep-alive. Carries nothing; a proxy would drop an idle stream without it. */
	| { type: "ping" };

/**
 * One frame on the wire.
 *
 * The envelope is on every frame rather than on some of them, because a client
 * that has to ask "which run was that?" before it can render anything is a
 * client that gets it wrong when two turns overlap.
 *
 * `seq` is monotonic per session and is what the SSE `id:` field carries, so a
 * client that reconnects can say "I got up to 42" and be given the rest.
 */
export type NahFrame = NahEvent & {
	/** Monotonic per session, starting at 1. */
	seq: number;
	sessionId: string;
	/** The turn this frame belongs to. */
	runId: string;
	/** Milliseconds since the epoch. */
	at: number;
};

/**
 * What a `POST` to the turn endpoint carries.
 *
 * `input` and the resume payloads are mutually exclusive, and the runtime
 * refuses a request that carries both. That is not a stylistic choice: the
 * harness reads a decision from the *last* message of the transcript only, so
 * a request carrying a decision and a new instruction would push the decision
 * out of the position the SDK looks in — the approval would be silently
 * ignored, the tool would never run, and the run would report success having
 * done nothing.
 */
export type NahTurnRequest = {
	/** The conversation. Generated by the server when absent. */
	sessionId?: string;
	/** The user's message. Absent on a resume. */
	input?: string;
	/** Answers to held calls, keyed by `approvalId`. */
	approvals?: ToolApprovalAnswers;
	/** Answers to parked calls, keyed by `toolCallId`. */
	resumeData?: Record<string, unknown>;
	/** Trusted context injected by the server adapter; never accept this from client JSON. */
	requestContext?: unknown;
};

/**
 * What a `POST` to the turn endpoint can ask for besides a turn.
 *
 * A discriminated union rather than loose booleans, because "steer with no
 * text" and "steer with text" are different requests and a boolean pair
 * admits a third one that means neither.
 */
export type NahActionRequest =
	| { action: "steer"; sessionId: string; text: string }
	| { action: "abort"; sessionId: string };

/** The shape of a `POST` body. */
export type NahPostRequest =
	| ({ action?: "turn" } & NahTurnRequest)
	| NahActionRequest;

/** The response to a steer or abort. */
export type NahActionResponse = {
	/** False when no run for that session is live in this process. */
	ok: boolean;
	/** Why it was refused, when it was. */
	reason?: string;
};
