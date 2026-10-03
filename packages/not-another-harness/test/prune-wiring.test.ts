import type { LanguageModelV4StreamPart } from "@ai-sdk/provider";
import { simulateReadableStream } from "ai";
import { tool } from "ai";
import type { ModelMessage } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { runAgent } from "../src/agent.js";
import { finishReason, v4Usage } from "./helpers/ai.js";

const USAGE = v4Usage({ input: 100, output: 10 });

/**
 * A model that calls a tool for `steps` rounds, then answers.
 *
 * Every request is captured as plain text so a test can assert on how much of
 * the transcript the provider was actually asked to read.
 */
const probingModel = (steps: number, captured: string[]) =>
	new MockLanguageModelV4({
		doStream: async (options) => {
			// Tool results carry their text under `output.value`, not `text`, so a
			// capture that only reads `text` silently ignores every result - which is
			// exactly the content these assertions are about.
			const flat: string[] = [];
			const push = (value: unknown): void => {
				if (typeof value === "string") flat.push(value);
			};
			for (const part of (options.prompt ?? []) as Array<{
				content?: unknown;
			}>) {
				push(part.content);
				if (Array.isArray(part.content)) {
					for (const piece of part.content as Array<{
						text?: string;
						output?: { value?: unknown } | string;
					}>) {
						push(piece.text);
						if (typeof piece.output === "string") push(piece.output);
						else push(piece.output?.value);
					}
				}
			}
			captured.push(flat.join("\n"));
			const n = captured.length - 1;
			const last = n >= steps;
			const chunks: LanguageModelV4StreamPart[] = last
				? [
						{ type: "text-start", id: "t" },
						{ type: "text-delta", id: "t", delta: "done" },
						{ type: "text-end", id: "t" },
					]
				: [
						{
							type: "tool-call",
							toolCallId: `c${n}`,
							toolName: "probe",
							input: "{}",
						},
					];
			return {
				stream: simulateReadableStream<LanguageModelV4StreamPart>({
					chunkDelayInMs: 0,
					chunks: [
						...chunks,
						{
							type: "finish",
							finishReason: finishReason(last ? "stop" : "tool-calls"),
							usage: USAGE,
						},
					],
				}),
			};
		},
	});

const bigResult = (id: string): string => `result-${id}-${"x".repeat(4000)}`;

/** A transcript that already contains reasoning, so the guard has something to see. */
const seededReasoning: ModelMessage[] = [
	{
		role: "assistant",
		content: [
			{
				type: "reasoning",
				text: "thinking about the approach",
				providerOptions: {},
			},
			{ type: "text", text: "looking around" },
		],
	} as unknown as ModelMessage,
];

const run = async (modelId: string, provider: string): Promise<string[]> => {
	const captured: string[] = [];
	const result = runAgent({
		model: Object.assign(probingModel(4, captured), { modelId, provider }),
		system: "s",
		prompt: "go",
		messages: seededReasoning,
		// The CLI passes the resolved provider here, and it is the same value the
		// prune guard consults.
		cacheProvider: provider as never,
		tools: {
			probe: tool({
				inputSchema: z.object({}),
				execute: async () => bigResult("payload"),
			}),
		},
		pruneToolResults: { keepRecentToolCalls: 1 },
	});
	for await (const _ of result.events) {
		// Drain, so every step runs.
	}
	await result.result;
	return captured;
};

describe("pruning is skipped when the provider can cache", () => {
	const run = async (provider: string, modelId: string): Promise<string> => {
		const captured: string[] = [];
		const result = runAgent({
			model: Object.assign(probingModel(4, captured), { modelId, provider }),
			system: "s",
			prompt: "go",
			messages: seededReasoning,
			cacheProvider: provider as never,
			tools: {
				probe: tool({
					inputSchema: z.object({}),
					execute: async () => bigResult("payload"),
				}),
			},
			pruneToolResults: { keepRecentToolCalls: 1 },
		});
		for await (const _ of result.events) {
			// Drain, so every step runs.
		}
		await result.result;
		return captured.at(-1) ?? "";
	};

	it("leaves the transcript alone on a cacheable provider", async () => {
		// Eliding rewrites bytes behind the cache breakpoint, so the prefix hash
		// stops matching. Measured on the configured model: 3,242 cached tokens per
		// turn with a stable prefix, 487 with old results rewritten. Trading a 0.1x
		// discount for a smaller prompt is a bad deal.
		const last = await run("openrouter", "stealth/space-bunny-alpha");
		expect(last).not.toContain("[output elided");
	});

	it("still prunes on a provider with no cache to lose", async () => {
		const last = await run("openai", "gpt-5");
		expect(last).toContain("[output elided");
	});

	it("still refuses to prune an Anthropic model's reasoning transcript", async () => {
		// Reached through a cacheable provider, so pruning is off anyway - but the
		// signature guard has to hold for a non-caching Anthropic route too.
		const last = await run(
			"a-non-caching-anthropic-proxy",
			"claude-sonnet-4-5",
		);
		expect(last).not.toContain("[output elided");
	});
});
