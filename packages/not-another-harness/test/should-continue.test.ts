import type { LanguageModelV4StreamPart } from "@ai-sdk/provider";
import { simulateReadableStream } from "ai";
import { tool } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { runAgent } from "../src/agent.js";
import { finishReason, v4Usage } from "./helpers/ai.js";

/**
 * `shouldContinue` — a caller's veto over the run's own "the model is done".
 *
 * A step that ends with no tool calls is a final answer, and the harness reports
 * it as one. For a long-running agent that is the ordinary way a working run
 * dies: the model narrates its next move, emits no call for it, and the loop
 * winds up over a task that is visibly half done. These tests cover the hook
 * that lets a caller say so.
 */

const USAGE = v4Usage({ input: 10, output: 5 });

const textStream = (text: string) =>
	simulateReadableStream<LanguageModelV4StreamPart>({
		chunkDelayInMs: 0,
		chunks: [
			{ type: "text-start", id: "t" },
			{ type: "text-delta", id: "t", delta: text },
			{ type: "text-end", id: "t" },
			{ type: "finish", finishReason: finishReason("stop"), usage: USAGE },
		],
	});

const readTool = tool({
	description: "read a file",
	inputSchema: z.object({ path: z.string() }),
	execute: async () => "contents",
});

const writeTool = tool({
	description: "write a file",
	inputSchema: z.object({ path: z.string() }),
	execute: async () => "written",
});

/** A tool call the model makes, so a run has a step that worked. */
const toolCallStream = (id: string) =>
	simulateReadableStream<LanguageModelV4StreamPart>({
		chunkDelayInMs: 0,
		chunks: [
			{
				type: "tool-call",
				toolCallId: id,
				toolName: "read",
				input: JSON.stringify({ path: "a.ts" }),
			},
			{ type: "finish", finishReason: finishReason("tool-calls"), usage: USAGE },
		],
	});

/**
 * A hook that says yes once.
 *
 * A hook that always says yes never lets the run end, which is the caller's
 * choice to make — a test that wants to observe one continuation asks for one.
 */
const once = () => {
	let asked = 0;
	return () => {
		asked += 1;
		return asked === 1;
	};
};

const run = async (options: Parameters<typeof runAgent>[0]) => {
	const handle = runAgent({
		system: "s",
		prompt: "go",
		tools: { read: readTool },
		...options,
	});
	for await (const _ of handle.events) {
		// Drained so the loop is never blocked on an unconsumed queue.
	}
	return handle.result;
};

/** A model that replays a script, one entry per request. */
const scripted = (script: Array<{ text?: string; tool?: string }>) => {
	let index = 0;
	return new MockLanguageModelV4({
		doStream: async () => {
			const entry = script[Math.min(index, script.length - 1)]!;
			index += 1;
			if (entry.tool) {
				return {
					stream: simulateReadableStream<LanguageModelV4StreamPart>({
						chunkDelayInMs: 0,
						chunks: [
							{
								type: "tool-call" as const,
								toolCallId: `t${index}`,
								toolName: entry.tool,
								input: JSON.stringify({ path: "a.ts" }),
							},
							{
								type: "finish" as const,
								finishReason: finishReason("tool-calls"),
								usage: USAGE,
							},
						],
					}),
				};
			}
			return { stream: textStream(entry.text ?? "done") };
		},
	});
};

describe("shouldContinue", () => {
	it("keeps a run going when the caller says the task is not done", async () => {
		// The model stops after a step of work. Without a continuation this is the
		// end of the run, over a task the caller says is unfinished.
		const result = await run({
			model: scripted([
				{ tool: "read" },
				{ tool: "read" },
				{ text: "all done" },
			]),
			// Once, so the run ends rather than being talked back into working
			// forever — which is the caller's choice to make, not the harness's.
			shouldContinue: once(),
		});

		// The run went past the model's own stop and took another step.
		expect(result.steps).toBe(4);
		expect(result.continuations).toBe(1);
		expect(result.reason).toBe("completed");
	});

	it("instructs the model to carry on rather than to summarise", async () => {
		const prompts: string[] = [];
		let call = 0;
		const model = new MockLanguageModelV4({
			doStream: async ({ prompt }) => {
				prompts.push(JSON.stringify(prompt));
				const index = call;
				call += 1;
				return {
					stream: index === 0 ? toolCallStream("c0") : textStream("done"),
				};
			},
		});

		await run({ model, shouldContinue: once() });

		// The instruction lands in the transcript, as a user turn, so the model
		// reads it as something to act on rather than as narration. It is the
		// third request: the first asked for the task, the second followed the
		// tool call, the third carries what the caller said.
		expect(prompts[2]).toContain("the task is not finished");
	});

	it("respects a caller that declines", async () => {
		const result = await run({
			model: scripted([{ tool: "read" }, { text: "done" }]),
			shouldContinue: () => false,
		});

		expect(result.reason).toBe("completed");
		expect(result.continuations).toBe(0);
		expect(result.steps).toBe(2);
	});

	it("grants a fresh step window, so a step ceiling cannot drop the continuation", async () => {
		// A ceiling of 3 would end the run at step 3. The continuation is a
		// message the caller chose to send, and an unattended bound must not
		// discard it.
		const result = await run({
			model: scripted([
				{ tool: "read" },
				{ text: "stopping" },
				{ tool: "read" },
				{ text: "now done" },
			]),
			maxSteps: 3,
			shouldContinue: once(),
		});

		expect(result.continuations).toBe(1);
		expect(result.steps).toBe(4);
		// `completed`, not `max-steps`: the run reached the model's own ending
		// rather than the ceiling it was given.
		expect(result.reason).toBe("completed");
	});

	it("leaves a wrapped-up run alone", async () => {
		// A wrap-up exists to hand off a run a rail stopped, and a continuation
		// would reopen exactly the work that wind-down is closing.
		const result = await run({
			model: scripted([{ tool: "read" }, { text: "stopping" }]),
			maxSteps: 1,
			shouldContinue: () => true,
		});

		expect(result.continuations).toBe(0);
		expect(result.wrappedUp).toBe(true);
	});

	it("is consulted from the first step", async () => {
		// Unlike `shouldStop`, which is skipped on step 1 because a rule reading
		// step history has nothing to read there, a continuation is the opposite
		// question — "is this really the end?" — and the caller answers it from its
		// own state. A model whose first answer is a preamble is the case that
		// needs it.
		let calls = 0;
		const result = await run({
			model: scripted([{ text: "stopping" }]),
			shouldContinue: () => {
				calls += 1;
				return false;
			},
		});

		expect(calls).toBe(1);
		expect(result.reason).toBe("completed");
	});

	it("sees how many mutating calls the run has made", async () => {
		// The signal a caller needs to tell "working" from "answering": a run
		// that has edited or run something is not stalled, whatever it said.
		const seen: number[] = [];
		await run({
			model: scripted([{ tool: "read" }, { text: "a" }]),
			tools: { read: readTool, write: writeTool },
			shouldContinue: ({ mutations }) => {
				seen.push(mutations);
				return false;
			},
		});
		expect(seen).toEqual([0]);
	});

	it("counts a mutating tool as work", async () => {
		const seen: number[] = [];
		await run({
			model: scripted([{ tool: "write" }, { text: "a" }]),
			tools: { read: readTool, write: writeTool },
			shouldContinue: ({ mutations }) => {
				seen.push(mutations);
				return false;
			},
		});
		expect(seen).toEqual([1]);
	});

	it("reports the continuation on the event stream", async () => {
		// A UI has to be able to say *why* the agent kept going after the model
		// stopped, and a message nobody typed cannot be shown as a steering
		// message.
		const handle = runAgent({
			system: "s",
			prompt: "go",
			tools: { read: readTool },
			model: scripted([{ tool: "read" }, { text: "stopping" }, { text: "done" }]),
			shouldContinue: once(),
		});
		const deliveries: string[] = [];
		for await (const event of handle.events) {
			if (event.type === "user-message") deliveries.push(event.delivery);
		}
		await handle.result;

		expect(deliveries).toEqual(["continuation"]);
	});

	it("propagates a throw rather than silently not firing", async () => {
		await expect(
			run({
				model: scripted([{ tool: "read" }, { text: "a" }]),
				shouldContinue: () => {
					throw new Error("rule bug");
				},
			}),
		).rejects.toThrow("rule bug");
	});

	it("awaits an async rule", async () => {
		const result = await run({
			model: scripted([{ tool: "read" }, { text: "a" }]),
			shouldContinue: async () => {
				await Promise.resolve();
				return false;
			},
		});
		expect(result.reason).toBe("completed");
	});
});
