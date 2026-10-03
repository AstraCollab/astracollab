import type { LanguageModelV4StreamPart } from "@ai-sdk/provider";
import { simulateReadableStream } from "ai";
import { tool } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { runAgent } from "../src/agent.js";
import { sessionUpdate as exportedUpdate } from "../src/index.js";
import { sessionUpdate } from "../src/types.js";
import type { HarnessRunResult, ModelMessage } from "../src/types.js";
import { finishReason, v4Usage } from "./helpers/ai.js";

/**
 * `prepareStep` and `sessionUpdate`.
 *
 * The first exists because a model that answers in prose when the task needs the
 * filesystem cannot be corrected by a notification hook, and the second exists
 * because the wrong derivation of "what changed" loses history without throwing.
 */

const USAGE = v4Usage({ input: 10, output: 5 });

const textStream = (text: string, toolName?: string) =>
	simulateReadableStream<LanguageModelV4StreamPart>({
		chunkDelayInMs: 0,
		chunks: [
			...(toolName
				? [
						{
							type: "tool-call" as const,
							toolCallId: `t-${text}`,
							toolName,
							input: { path: "a.ts" },
						},
					]
				: [
						{ type: "text-start" as const, id: "t" },
						{ type: "text-delta" as const, id: "t", delta: text },
						{ type: "text-end" as const, id: "t" },
					]),
			{
				type: "finish",
				finishReason: toolName ? ("tool-calls" as const) : ("stop" as const),
				usage: USAGE,
			},
		],
	});

/** A model that reports the toolChoice it was called with, on every call. */
const scriptedModel = (script: Array<{ text?: string; tool?: string }>) => {
	const seen: Array<{
		toolChoice: unknown;
		temperature: unknown;
		maxOutputTokens: unknown;
	}> = [];
	let index = 0;
	return {
		seen,
		model: new MockLanguageModelV4({
			doStream: async (options: Record<string, unknown>) => {
				seen.push({
					toolChoice: options.toolChoice,
					temperature: options.temperature,
					maxOutputTokens: options.maxOutputTokens,
				});
				const entry = script[Math.min(index, script.length - 1)]!;
				index += 1;
				return { stream: textStream(entry.text ?? "done", entry.tool) };
			},
		}),
	};
};

const tools = {
	read: tool({
		description: "read a file",
		inputSchema: z.object({ path: z.string() }),
		execute: async () => "contents",
	}),
};

const baseRun = {
	system: "s",
	tools,
	abortSignal: undefined as AbortSignal | undefined,
};

const consume = async (
	run: ReturnType<typeof runAgent>,
): Promise<HarnessRunResult> => {
	for await (const _ of run.events) {
		// Drain, so the loop is never blocked on an unconsumed queue.
	}
	return run.result;
};

describe("prepareStep", () => {
	it("forces a tool call on the first step and stops forcing after one", async () => {
		// The rule the migration needs: require a tool until the agent has used one.
		const scripted = scriptedModel([{ tool: "read" }, { text: "all done" }]);
		const result = await consume(
			runAgent({
				...baseRun,
				model: scripted.model,
				prompt: "read a.ts",
				prepareStep: ({ steps }) =>
					steps.length === 0 ? { toolChoice: "required" } : {},
			}),
		);

		// The provider sees what streamText normalised it to, not the string passed in.
		expect(scripted.seen.map((call) => call.toolChoice)).toEqual([
			{ type: "required" },
			{ type: "auto" },
		]);
		expect(result.reason).toBe("completed");
	});

	it("reports which tools ran, per step", async () => {
		const scripted = scriptedModel([
			{ tool: "read" },
			{ tool: "read" },
			{ text: "done" },
		]);
		const seen: number[] = [];
		await consume(
			runAgent({
				...baseRun,
				model: scripted.model,
				prompt: "read a.ts twice",
				prepareStep: (context) => {
					seen.push(context.stepNumber);
					return context.stepNumber === 3 ? { toolChoice: "none" } : undefined;
				},
			}),
		);

		// 1-based, and it keeps counting across steps.
		expect(seen).toEqual([1, 2, 3]);
	});

	it("passes the step number and the transcript before the step", async () => {
		const scripted = scriptedModel([{ tool: "read" }, { text: "done" }]);
		const contexts: Array<{
			stepNumber: number;
			messages: number;
			steps: unknown;
		}> = [];
		await consume(
			runAgent({
				...baseRun,
				model: scripted.model,
				prompt: "read a.ts",
				prepareStep: (context) => {
					contexts.push({
						stepNumber: context.stepNumber,
						messages: context.messages.length,
						steps: context.steps,
					});
					return undefined;
				},
			}),
		);

		expect(contexts[0]?.stepNumber).toBe(1);
		// Step 2's context already knows about step 1's tool call, which is the whole
		// reason `steps` is on the context at all.
		expect(contexts[1]?.steps).toEqual([{ step: 1, toolNames: ["read"] }]);
		expect(contexts[1]?.messages).toBeGreaterThan(contexts[0]?.messages);
	});

	it("applies a static toolChoice to every step", async () => {
		const scripted = scriptedModel([{ tool: "read" }, { tool: "read" }]);
		await consume(
			runAgent({
				...baseRun,
				model: scripted.model,
				prompt: "read a.ts",
				toolChoice: "required",
			}),
		);
		expect(
			scripted.seen.every(
				(call) => JSON.stringify(call.toolChoice) === '{"type":"required"}',
			),
		).toBe(true);
	});

	it("lets prepareStep override the run's toolChoice for one step", async () => {
		const scripted = scriptedModel([{ tool: "read" }, { text: "done" }]);
		await consume(
			runAgent({
				...baseRun,
				model: scripted.model,
				prompt: "read a.ts",
				toolChoice: "required",
				prepareStep: ({ stepNumber }) =>
					stepNumber === 2 ? { toolChoice: "none" } : {},
			}),
		);
		expect(
			scripted.seen.map((call) => (call.toolChoice as { type: string }).type),
		).toEqual(["required", "none"]);
	});

	it("overrides temperature and output cap for one step", async () => {
		const scripted = scriptedModel([{ text: "done" }]);
		await consume(
			runAgent({
				...baseRun,
				model: scripted.model,
				prompt: "hi",
				prepareStep: () => ({ temperature: 0.9, maxOutputTokens: 128 }),
			}),
		);
		expect(scripted.seen[0]?.temperature).toBe(0.9);
		expect(scripted.seen[0]?.maxOutputTokens).toBe(128);
	});

	it("does not pin a tool choice when the caller does not ask for one", async () => {
		// streamText resolves an unset toolChoice to "auto" today, so this only pins
		// the harness's own behaviour: it forwards nothing rather than sending "auto"
		// and freezing a default the SDK owns.
		const scripted = scriptedModel([{ text: "done" }]);
		await consume(
			runAgent({ ...baseRun, model: scripted.model, prompt: "hi" }),
		);
		expect((scripted.seen[0]?.toolChoice as { type: string }).type).toBe(
			"auto",
		);
	});

	it("hands over a snapshot, not the run's own bookkeeping", async () => {
		// A live array would let a consumer rewrite what later steps see, and would
		// make the context change under them mid-run.
		const scripted = scriptedModel([{ tool: "read" }, { tool: "read" }]);
		const contexts: Array<Array<{ step: number }>> = [];
		await consume(
			runAgent({
				...baseRun,
				model: scripted.model,
				prompt: "read a.ts twice",
				prepareStep: (context) => {
					contexts.push(context.steps as Array<{ step: number }>);
					return undefined;
				},
			}),
		);
		// Nothing has run when step 1 is prepared, so its snapshot is empty — and it
		// stays empty afterwards, which is what a copy gives and a shared reference
		// does not (by the end, two steps have been recorded into the live array).
		expect(contexts[0]?.map((entry) => entry.step)).toEqual([]);
		expect(contexts[0]).toHaveLength(0);
	});

	it("ends the run when the hook throws", async () => {
		// Swallowing would make a broken hook indistinguishable from one that decided
		// not to require a tool, which is exactly the failure nobody can debug.
		const scripted = scriptedModel([{ text: "done" }]);
		const run = runAgent({
			...baseRun,
			model: scripted.model,
			prompt: "hi",
			prepareStep: () => {
				throw new Error("hook exploded");
			},
		});
		await expect(run.result).rejects.toThrow("hook exploded");
		expect(scripted.seen).toHaveLength(0);
	});
});

describe("sessionUpdate", () => {
	const message = (text: string): ModelMessage => ({
		role: "user",
		content: text,
	});
	const result = (messages: ModelMessage[], compactions: number) =>
		({ messages, compactions }) as Pick<
			HarnessRunResult,
			"messages" | "compactions"
		>;

	it("appends when the run only added messages", () => {
		const before = [message("a"), message("b")];
		const after = [...before, message("c"), message("d")];
		expect(sessionUpdate(before, result(after, 0))).toEqual({
			mode: "append",
			messages: after.slice(2),
		});
	});

	it("replaces after a compaction, because the tail is not an append delta", () => {
		// The bug this exists for: after compaction, result.messages shares no prefix
		// with the input, so slice() returns the wrong messages and appending them
		// loses the middle of the conversation. Silently.
		const before = Array.from({ length: 40 }, (_, index) =>
			message(`m${index}`),
		);
		const compacted = [
			message("summary of 0..30"),
			before[39]!,
			message("new"),
		];
		const update = sessionUpdate(before, result(compacted, 1));
		expect(update.mode).toBe("replace");
		expect(update.messages).toBe(compacted);
	});

	it("replaces when the transcript shrank without a compaction being counted", () => {
		// Defensive: a store must never be handed an append it cannot apply.
		const before = [message("a"), message("b"), message("c")];
		expect(sessionUpdate(before, result([message("a")], 0)).mode).toBe(
			"replace",
		);
	});

	it("accepts a length as well as the transcript", () => {
		expect(
			sessionUpdate(2, result([message("a"), message("b"), message("c")], 0)),
		).toEqual({
			mode: "append",
			messages: [message("c")],
		});
	});

	it("is exported from the package root as well as the module", () => {
		expect(exportedUpdate).toBe(sessionUpdate);
	});
});
