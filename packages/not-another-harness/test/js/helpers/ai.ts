/**
 * Test fixtures for the provider-level types.
 *
 * Built in one place because the shapes here are the ones that are easy to get
 * wrong: a tool call's arguments arrive as a **string** in a stream part and as
 * an **object** in a prompt part, and a fixture written in the prompt shape
 * typechecks only through a cast and then fails at runtime with
 * `input.trim is not a function` — which looks exactly like a tool that
 * declined to answer.
 */
import type {
	LanguageModelV4FinishReason,
	LanguageModelV4StreamPart,
	LanguageModelV4Usage,
} from "@ai-sdk/provider";
import { simulateReadableStream } from "ai";
import { MockLanguageModelV4 } from "ai/test";

export const v4Usage = ({
	input = 0,
	output = 0,
	cacheRead = 0,
	cacheWrite = 0,
	reasoning = 0,
}: {
	input?: number;
	output?: number;
	cacheRead?: number;
	cacheWrite?: number;
	reasoning?: number;
} = {}): LanguageModelV4Usage => ({
	inputTokens: {
		total: input,
		noCache: Math.max(0, input - cacheRead - cacheWrite),
		cacheRead,
		cacheWrite,
	},
	outputTokens: {
		total: output,
		text: Math.max(0, output - reasoning),
		reasoning,
	},
});

export const finishReason = (
	unified:
		| "stop"
		| "length"
		| "content-filter"
		| "tool-calls"
		| "error"
		| "other",
	raw?: string,
): LanguageModelV4FinishReason => ({ unified, raw });

/** One response of plain text. */
export const textChunks = (
	text: string,
	usage: LanguageModelV4Usage = v4Usage(),
): LanguageModelV4StreamPart[] => [
	{ type: "text-start", id: "text-1" },
	{ type: "text-delta", id: "text-1", delta: text },
	{ type: "text-end", id: "text-1" },
	{ type: "finish", finishReason: finishReason("stop"), usage },
];

/** One response that calls a tool. */
export const toolCallChunks = (
	toolName: string,
	input: unknown,
	toolCallId = "call-1",
	usage: LanguageModelV4Usage = v4Usage(),
): LanguageModelV4StreamPart[] => [
	{ type: "tool-input-start", id: toolCallId, toolName },
	{ type: "tool-input-delta", id: toolCallId, delta: JSON.stringify(input) },
	{ type: "tool-input-end", id: toolCallId },
	{ type: "tool-call", toolCallId, toolName, input: JSON.stringify(input) },
	{ type: "finish", finishReason: finishReason("tool-calls"), usage },
];

/**
 * A model that plays one script per call, repeating the last one.
 *
 * The stream is built per call because a `ReadableStream` can be consumed
 * exactly once: a shared instance would hand step 2 an already-closed stream,
 * and the failure would look like a provider bug.
 */
export const scriptedModel = (
	...scripts: ReadonlyArray<readonly LanguageModelV4StreamPart[]>
): MockLanguageModelV4 => {
	let call = 0;
	return new MockLanguageModelV4({
		doStream: async () => {
			const script = scripts[Math.min(call, scripts.length - 1)] ?? [];
			call += 1;
			return {
				stream: simulateReadableStream<LanguageModelV4StreamPart>({
					chunkDelayInMs: 0,
					chunks: [...script],
				}),
			};
		},
	});
};

/** A model that records the prompts it was given. */
export const recordingModel = (
	...scripts: ReadonlyArray<readonly LanguageModelV4StreamPart[]>
): { model: MockLanguageModelV4; prompts: unknown[] } => {
	const prompts: unknown[] = [];
	let call = 0;
	const model = new MockLanguageModelV4({
		doStream: async ({ prompt }) => {
			prompts.push(prompt);
			const script = scripts[Math.min(call, scripts.length - 1)] ?? [];
			call += 1;
			return {
				stream: simulateReadableStream<LanguageModelV4StreamPart>({
					chunkDelayInMs: 0,
					chunks: [...script],
				}),
			};
		},
	});
	return { model, prompts };
};
