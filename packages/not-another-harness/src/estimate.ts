/**
 * Transcript size estimation.
 *
 * Budget and compaction decisions need a cheap, allocation-light estimate of
 * what the next request actually carries. Serializing the transcript with
 * `JSON.stringify` on every step is both expensive and systematically biased
 * (property names, escaping, punctuation), which made the harness compact
 * transcripts that were nowhere near a context limit. This walks the message
 * parts directly instead.
 */

const CHARS_PER_TOKEN = 4;

/** Rough per-part overhead for tool schemas, ids, and role framing. */
const PART_OVERHEAD_CHARS = 48;

export const estimateTextTokens = (text: string): number =>
	Math.ceil(text.length / CHARS_PER_TOKEN);

const toolOutputLength = (output: unknown): number => {
	if (typeof output === "string") return output.length;
	if (output && typeof output === "object" && "value" in output) {
		const value = (output as { value: unknown }).value;
		if (typeof value === "string") return value.length;
		try {
			return JSON.stringify(value ?? null).length;
		} catch {
			return 0;
		}
	}
	try {
		return JSON.stringify(output ?? null).length;
	} catch {
		return 0;
	}
};

/** Approximate the token cost of a single message. */
export const estimateMessageTokens = (message: unknown): number => {
	const content = (message as { content?: unknown } | null)?.content;
	if (typeof content === "string")
		return estimateTextTokens(content) + PART_OVERHEAD_CHARS;
	if (!Array.isArray(content)) return PART_OVERHEAD_CHARS;

	let chars = 0;
	for (const part of content as Array<Record<string, unknown>>) {
		const type = part?.type;
		if (type === "text") {
			chars += typeof part.text === "string" ? part.text.length : 0;
		} else if (type === "tool-call") {
			const name = typeof part.toolName === "string" ? part.toolName : "";
			let inputLength = 0;
			try {
				inputLength = JSON.stringify(part.input ?? null).length;
			} catch {
				inputLength = 0;
			}
			chars += name.length + inputLength;
		} else if (type === "tool-result") {
			chars += toolOutputLength(part.output);
		}
		chars += PART_OVERHEAD_CHARS;
	}
	return Math.ceil(chars / CHARS_PER_TOKEN) + PART_OVERHEAD_CHARS;
};

/** Approximate the token cost of a full request payload (system + transcript). */
export const estimateRequestTokens = (
	system: string | undefined,
	messages: unknown[],
): number => {
	let total = system ? estimateTextTokens(system) + PART_OVERHEAD_CHARS : 0;
	for (const message of messages) {
		total += estimateMessageTokens(message);
	}
	return total;
};
