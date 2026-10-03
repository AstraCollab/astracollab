import type { LanguageModelV4StreamPart } from "@ai-sdk/provider";
import { simulateReadableStream } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";

import { runAgent } from "../src/agent.js";
import { finishReason, v4Usage } from "./helpers/ai.js";

const USAGE = v4Usage({ input: 100, output: 10 });

const modelReturning = (
	reason: "stop" | "length" | "tool-calls",
	chunks: LanguageModelV4StreamPart[],
) =>
	new MockLanguageModelV4({
		doStream: async () => ({
			stream: simulateReadableStream<LanguageModelV4StreamPart>({
				chunkDelayInMs: 0,
				chunks: [
					...chunks,
					{ type: "finish", finishReason: finishReason(reason), usage: USAGE },
				],
			}),
		}),
	});

const runTo = async (
	model: MockLanguageModelV4,
): Promise<{ reason: string; wrapUp: boolean }> => {
	const run = runAgent({
		model: Object.assign(model, {
			modelId: "test/model",
			provider: "openrouter",
		}) as never,
		system: "s",
		prompt: "go",
		tools: {},
	});
	let reason = "";
	let wrapUp = false;
	for await (const event of run.events) {
		if (event.type === "finish") reason = event.reason;
		if (event.type === "wrap-up") wrapUp = true;
	}
	await run.result;
	return { reason, wrapUp };
};

const textChunks: LanguageModelV4StreamPart[] = [
	{ type: "text-start", id: "t" },
	{ type: "text-delta", id: "t", delta: "an answer" },
	{ type: "text-end", id: "t" },
];

describe("output-cap stop is named for what it is", () => {
	it("reports max-output when the reply is cut off by the output cap", async () => {
		const { reason } = await runTo(modelReturning("length", textChunks));
		// Reported as `max-tokens` this reads as an input or spend ceiling, and the
		// reader tunes context - the one knob that cannot help, when the limit was
		// on how much the model wrote. Thinking tokens come out of the same
		// allowance, so a reasoning model trips it easily.
		expect(reason).toBe("max-output");
	});

	it("still reports max-tokens for a genuine spend or token ceiling", async () => {
		const { reason } = await runTo(modelReturning("length", textChunks));
		expect(reason).not.toBe("max-tokens");

		const spend = runAgent({
			model: Object.assign(
				modelReturning("tool-calls", [
					{ type: "tool-call", toolCallId: "c", toolName: "x", input: "{}" },
				]),
				{
					modelId: "test/model",
					provider: "openrouter",
				},
			) as never,
			system: "s",
			prompt: "go",
			tools: {},
			maxSpendUsd: 0.0000001,
			rates: { input: 3, output: 15 },
		});
		let spendReason = "";
		for await (const event of spend.events)
			if (event.type === "finish") spendReason = event.reason;
		await spend.result;
		expect(spendReason).toBe("max-tokens");
	});

	it("reports completed for a normal finish", async () => {
		const { reason } = await runTo(modelReturning("stop", textChunks));
		expect(reason).toBe("completed");
	});

	it("gives a reasoning model room to finish a step by default", async () => {
		// 8k starved a reasoning model: thinking is drawn from the same allowance,
		// so one verbose step ended as truncated rather than done.
		let seen = 0;
		const probe = new MockLanguageModelV4({
			doStream: async (options: { maxOutputTokens?: number }) => {
				seen = options.maxOutputTokens ?? 0;
				return {
					stream: simulateReadableStream<LanguageModelV4StreamPart>({
						chunkDelayInMs: 0,
						chunks: [
							...textChunks,
							{
								type: "finish",
								finishReason: finishReason("stop"),
								usage: USAGE,
							},
						],
					}),
				};
			},
		});
		await runTo(probe);
		expect(seen).toBeGreaterThanOrEqual(16_384);
	});
});
