/**
 * Test fixtures for the AI SDK's provider-level types.
 *
 * The shape of `usage` changed in a way that a mechanical rename cannot absorb:
 * on v5 it was three flat numbers, and on v7 the prompt is broken out into
 * `total` / `noCache` / `cacheRead` / `cacheWrite`. A test that says
 * `{ inputTokens: 10 }` now means "inputTokens is a number", which is wrong at
 * every level — so fixtures are built here, where the new shape is written once
 * and a mismatch is one error instead of thirty.
 *
 * The same argument covers the stream fixtures below: a tool call's `input` is a
 * string in a stream part and an object in a prompt part, which is one of those
 * differences that compiles only through a cast and fails only at runtime.
 */
import type {
	LanguageModelV4FinishReason,
	LanguageModelV4StreamPart,
	LanguageModelV4Usage,
} from "@ai-sdk/provider";
import { simulateReadableStream } from "ai";
import { MockLanguageModelV4 } from "ai/test";

export interface UsageInput {
	/** Prompt tokens in total, cache included — what a provider reports. */
	readonly input?: number;
	readonly output?: number;
	/** Of the prompt, how much was served from cache. */
	readonly cacheRead?: number;
	/** Of the prompt, how much was written to cache on this request. */
	readonly cacheWrite?: number;
	readonly reasoning?: number;
}

/**
 * A complete `LanguageModelV4Usage`.
 *
 * `noCache` is derived rather than accepted, because a fixture that sets a total
 * and a cacheRead while leaving the uncached part at zero describes a request
 * that cannot happen — and the whole point of these tests is that the harness
 * adds the pieces back up correctly.
 */
export const v4Usage = ({
	input = 0,
	output = 0,
	cacheRead = 0,
	cacheWrite = 0,
	reasoning = 0,
}: UsageInput = {}): LanguageModelV4Usage => ({
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

/**
 * A `finishReason` in the shape the provider now emits.
 *
 * In v5 it was the bare string `"stop"`. In v7 it is an object pairing a
 * normalised `unified` reason with whatever the provider actually said, so a
 * fixture written as a string is not merely untyped — it describes the old
 * protocol. Built here so the shape is written once.
 */
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

/**
 * One response's worth of stream parts: text, or a tool call.
 *
 * ## Why the tool-call shape is built here and not in each test
 *
 * `LanguageModelV4ToolCall.input` is a **string** — stringified JSON — while
 * `LanguageModelV4ToolCallPart.input` (the same field on a *prompt* part) is an
 * object. A stream part built from the prompt shape typechecks in neither
 * direction: it compiles only through a cast, and at runtime the SDK calls
 * `.trim()` on it, so the tool fails with `input.trim is not a function` and the
 * run reports a `tool-error` where a result was expected.
 *
 * That mistake is invisible in a fixture and total in a run — it looks exactly
 * like a tool that declined to answer. The three chunks below are what a provider
 * actually sends: the arguments stream in as text, then the call arrives whole.
 */
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

/**
 * A model that plays one script per call, repeating the last one.
 *
 * Repeating rather than throwing is what makes a script ending in `textChunks`
 * behave like "then keep answering": the run keeps stepping and the transcript
 * keeps growing, without the script having to know the step limit. A script ending
 * in a tool call repeats that call, which is a fixture's own doing.
 *
 * The stream is built per call rather than once, because a `ReadableStream` can be
 * consumed exactly once — a shared instance would hand step 2 an already-closed
 * stream, and the failure would look like a provider bug.
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
