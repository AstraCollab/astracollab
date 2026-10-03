/**
 * Replay a recorded session's token cost under different context policies.
 *
 * A tool-calling loop re-sends its whole transcript every step, so a run's cost
 * is a function of two things: how many steps it took, and how large the
 * transcript was at each of them. Measuring that by running the agent is slow,
 * non-deterministic, and costs money. But the trajectory is already on disk - a
 * session JSONL holds every message - so the cost of a policy change can be
 * computed exactly, offline, with no model involved.
 *
 * This is the tool for answering "what would keepRecentToolCalls: 3 have cost?"
 * without re-running anything. It is a model of the accounting, not a
 * measurement of a live provider: cache reads are billed by the provider and are
 * not visible here, so the numbers are *processed* tokens, which is what the
 * transcript growth actually controls.
 */
import type { ModelMessage } from "ai";

/** Rough characters-per-token. Deliberately the same crude ratio the rest uses. */
const CHARS_PER_TOKEN = 4;

/**
 * Matches `prune.ts`: below this a result is left alone, because the elision
 * note costs more than the content it would replace.
 */
const ELIDE_FLOOR_CHARS = 400;
const ELIDED_NOTE =
	"[output elided: earlier tool result. Re-run the tool if you need it again.]";

const messageChars = (message: ModelMessage): number =>
	messageTokens(message) * CHARS_PER_TOKEN;

export type ContextPolicy =
	| { kind: "none" }
	/** Retain the most recent N tool rounds, elide the rest. */
	| { kind: "recent-rounds"; keep: number }
	/**
	 * Retain rounds until a token budget is spent, always keeping the newest.
	 *
	 * A count is the wrong unit when the distribution is this skewed: in the run
	 * that prompted this, six results held 62% of all tool-output tokens, so
	 * "keep 6" was effectively "keep the six largest".
	 */
	| { kind: "token-budget"; tokens: number };

export type PolicyReport = {
	policy: ContextPolicy;
	/** Tokens sent per step, in step order. */
	perStep: number[];
	/** Sum over all steps: what the run processed. */
	totalProcessed: number;
	/** Largest single request, which is what compaction triggers on. */
	peakRequest: number;
	/** Tool-output tokens still in the final request. */
	tailToolTokens: number;
	/** How many steps would have exceeded a given compaction trigger. */
	stepsOver: (threshold: number) => number;
};

const isReasoningPart = (part: unknown): boolean =>
	typeof part === "object" &&
	part !== null &&
	(part as { type?: string }).type === "reasoning";

export const hasReasoning = (messages: readonly ModelMessage[]): boolean =>
	messages.some(
		(m) => Array.isArray(m.content) && m.content.some(isReasoningPart),
	);

/** Approximate tokens in one message, tool results included. */
export const messageTokens = (message: ModelMessage): number => {
	const content = message.content;
	if (typeof content === "string")
		return Math.ceil(content.length / CHARS_PER_TOKEN);
	if (!Array.isArray(content)) return 0;
	let chars = 0;
	for (const part of content as unknown as Array<Record<string, unknown>>) {
		if (typeof part.text === "string") chars += part.text.length;
		const output = part.output as { value?: unknown } | string | undefined;
		if (typeof output === "string") chars += output.length;
		else if (output && typeof output.value === "string")
			chars += output.value.length;
		else if (part.type === "tool-call")
			chars += JSON.stringify(part.input ?? "").length;
	}
	return Math.ceil(chars / CHARS_PER_TOKEN);
};

const toolResultTokens = (message: ModelMessage): number => {
	if (!Array.isArray(message.content)) return 0;
	let chars = 0;
	for (const part of message.content as unknown as Array<
		Record<string, unknown>
	>) {
		if (part.type !== "tool-result") continue;
		const output = part.output as { value?: unknown } | string | undefined;
		if (typeof output === "string") chars += output.length;
		else if (output && typeof output.value === "string")
			chars += output.value.length;
	}
	return Math.ceil(chars / CHARS_PER_TOKEN);
};

/**
 * Indexes of the tool-round boundaries in the transcript.
 *
 * A "round" is one tool result. Pruning works from the end backwards, and the
 * harness guarantees at least the newest round survives, because eliding
 * everything leaves the model unable to see what it just did.
 */
const toolRoundIndexes = (messages: readonly ModelMessage[]): number[] => {
	const out: number[] = [];
	messages.forEach((message, index) => {
		if (!Array.isArray(message.content)) return;
		const isResult = (message.content as Array<{ type?: string }>).some(
			(p) => p.type === "tool-result",
		);
		if (isResult) out.push(index);
	});
	return out;
};

const pruneThrough = (
	messages: readonly ModelMessage[],
	policy: ContextPolicy,
): ModelMessage[] => {
	if (policy.kind === "none") return [...messages];
	const rounds = toolRoundIndexes(messages);
	if (rounds.length === 0) return [...messages];

	// Index from which content stays intact; everything before it is elided.
	let keepFrom = rounds[rounds.length - 1]!;
	if (policy.kind === "recent-rounds") {
		const keep = Math.max(1, policy.keep);
		keepFrom = rounds[Math.max(0, rounds.length - keep)]!;
	} else {
		let budget = policy.tokens;
		for (let i = rounds.length - 1; i >= 0; i -= 1) {
			const cost = toolResultTokens(messages[rounds[i]!]!);
			if (i === rounds.length - 1) {
				// The newest round is always kept, whatever it costs.
				budget -= cost;
				keepFrom = rounds[i]!;
				continue;
			}
			if (cost > budget) break;
			budget -= cost;
			keepFrom = rounds[i]!;
		}
	}
	return messages.map((message, index) => {
		if (index >= keepFrom) return message;
		// Same floor as the real pruner: a result is only elided when it is big
		// enough for the placeholder to be a saving. Replacing a 12-token result
		// with a 20-token note grows the transcript, and every step pays for it.
		if (messageChars(message) < ELIDE_FLOOR_CHARS) return message;
		return {
			role: "tool",
			content: [
				{ type: "tool-result", output: { type: "text", value: ELIDED_NOTE } },
			],
		} as unknown as ModelMessage;
	});
};

/**
 * Replay `messages` and report what each policy would have cost.
 *
 * Steps are the assistant turns: each one is a request in which the whole
 * preceding transcript is resent, so the step's cost is the size of the
 * transcript up to that point.
 */
export const analysePolicies = (
	messages: readonly ModelMessage[],
	policies: readonly ContextPolicy[],
	/** Static prefix resent every step: system prompt plus tool schemas. */
	staticPrefixTokens = 0,
): PolicyReport[] => {
	const stepIndexes = messages
		.map((message, index) => (message.role === "assistant" ? index : -1))
		.filter((index) => index >= 0);

	return policies.map((policy) => {
		const perStep: number[] = [];
		for (const index of stepIndexes) {
			const slice = pruneThrough(messages.slice(0, index + 1), policy);
			const body = slice.reduce(
				(sum, message) => sum + messageTokens(message),
				0,
			);
			perStep.push(body + staticPrefixTokens);
		}
		const tail = pruneThrough(messages, policy).reduce(
			(sum, m) => sum + toolResultTokens(m),
			0,
		);
		return {
			policy,
			perStep,
			totalProcessed: perStep.reduce((a, b) => a + b, 0),
			peakRequest: perStep.reduce((a, b) => Math.max(a, b), 0),
			tailToolTokens: tail,
			stepsOver: (threshold: number) =>
				perStep.filter((n) => n > threshold).length,
		};
	});
};

/** Parse a session JSONL into the message stream the harness would hold. */
export const messagesFromSessionJsonl = (jsonl: string): ModelMessage[] => {
	const out: ModelMessage[] = [];
	for (const line of jsonl.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		let entry: { message?: ModelMessage };
		try {
			entry = JSON.parse(trimmed) as { message?: ModelMessage };
		} catch {
			continue;
		}
		const message = entry.message;
		if (
			!message ||
			(message.role !== "user" &&
				message.role !== "assistant" &&
				message.role !== "tool")
		) {
			continue;
		}
		out.push(message);
	}
	return out;
};
