/**
 * Tool suspension: park a call until it is given a value.
 *
 * ## Why this exists
 *
 * An agent sometimes needs something only a person has — a missing choice, a decision
 * about a plan — and the model cannot proceed without it. Without a primitive for
 * that, the only options are to guess or to end the turn, and both are worse than
 * asking.
 *
 * **The AI SDK has no such primitive.** No suspension, no resume, no parked call —
 * `grep` for `suspend` in `ai`'s types returns nothing. So this is the harness's own,
 * and it follows Mastra's semantics, because a client migrating off Mastra already
 * knows them:
 *
 *  - `suspend(payload)` **throws**. It does not return a sentinel and it does not set
 *    a flag a caller must remember to check. A tool that carried on past a suspend
 *    would have answered a question nobody was asked.
 *  - The tool is **re-run from the top** on resume, statelessly: it checks for resume
 *    data first, returns it, and suspends again otherwise. No coroutine, no parked
 *    stack frame. This is why such a tool must not do work before suspending — that
 *    work happens twice.
 *  - The payload belongs to the tool. The harness carries it as `unknown` and never
 *    looks inside, because "what does this tool need" is not a harness question.
 *
 * ## How it reaches the loop
 *
 * The SDK catches everything thrown from `execute` and reports it as a `tool-error`
 * part. Rather than fight that, the sentinel rides it: {@link isSuspension} identifies
 * it, and the event loop maps it to `tool-suspended` instead of a failure. A different
 * transport — a wrapper that swallowed the throw — would have meant intercepting
 * `execute`, which is the one thing the harness deliberately does not do to tools it
 * does not own.
 */

/** Marker on the thrown value, so it survives however it was wrapped or re-thrown. */
const SUSPENSION = Symbol.for("nah.toolSuspension");

export type Suspension = {
	readonly [SUSPENSION]: true;
	readonly payload: unknown;
	readonly toolCallId: string;
	readonly toolName: string;
	readonly input: unknown;
};

/**
 * Build the error a tool throws to park itself.
 *
 * An `Error` rather than a bare object so it survives a `catch (error) { throw error }`
 * anywhere in between, and so a stack exists if it ever escapes unrecognised.
 */
export const createSuspension = (details: {
	payload: unknown;
	toolCallId: string;
	toolName: string;
	input: unknown;
}): Suspension => {
	const error = new Error(
		`Tool suspended: ${details.toolName} is waiting for a value before it can finish.`,
	) as Error & { -readonly [K in keyof Suspension]: Suspension[K] };
	error[SUSPENSION] = true;
	error.payload = details.payload;
	error.toolCallId = details.toolCallId;
	error.toolName = details.toolName;
	error.input = details.input;
	// Named so a log line says what happened rather than "Error".
	error.name = "ToolSuspended";
	return error;
};

/** Is this thrown value a parked call rather than a failure? */
export const isSuspension = (error: unknown): error is Suspension =>
	typeof error === "object" &&
	error !== null &&
	(error as Partial<Suspension>)[SUSPENSION] === true;

/**
 * The `suspend` function handed to a tool for one call.
 *
 * Typed `never` because it does not return: a tool that keeps going after suspending
 * is a bug, and the type says so. Mastra's docs make the same point about their own
 * version — `suspend()` does not throw *itself*, so code after it still runs.
 */
export const createToolSuspend = (details: {
	toolCallId: string;
	toolName: string;
	input: unknown;
}): ((payload: unknown) => never) => {
	return (payload: unknown): never => {
		throw createSuspension({
			payload,
			toolCallId: details.toolCallId,
			toolName: details.toolName,
			input: details.input,
		});
	};
};
