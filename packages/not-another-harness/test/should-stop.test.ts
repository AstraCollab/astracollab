import type { LanguageModelV4StreamPart } from "@ai-sdk/provider";
import { simulateReadableStream } from "ai";
import { tool } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { runAgent } from "../src/agent.js";
import { finishReason, v4Usage } from "./helpers/ai.js";

/**
 * `shouldStop` — a caller's own end-of-run rules.
 *
 * The harness's own guards measure generic things. These tests cover the gap they
 * leave: what a caller knows about its own agent, expressed without re-implementing
 * the loop.
 */

const USAGE = v4Usage({ input: 10, output: 5 });

const textStream = (text: string) =>
	simulateReadableStream<LanguageModelV4StreamPart>({
		chunkDelayInMs: 0,
		chunks: [
			{ type: "text-start", id: "t" },
			{ type: "text-delta", id: "t", delta: text },
			{ type: "text-end", id: "t" },
			{ type: "finish", finishReason: "stop", usage: USAGE },
		],
	});

const readTool = tool({
	description: "read a file",
	inputSchema: z.object({ path: z.string() }),
	execute: async () => "contents",
});

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
								input: { path: "a.ts" },
							},
							{
								type: "finish" as const,
								finishReason: "tool-calls" as const,
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

describe("shouldStop", () => {
	it("ends the run with its own reason", async () => {
		const result = await run({
			model: scripted([{ tool: "read" }, { tool: "read" }, { text: "three" }]),
			maxSteps: 10,
			shouldStop: ({ stepNumber }) => stepNumber >= 2,
		});

		// Its own reason, because a caller rule is neither `max-steps` nor
		// `no-progress`, and reporting it as either sends a reader hunting for a
		// ceiling nobody set.
		expect(result.reason).toBe("stopped-by-caller");
		// The step that triggered the stop still ran; a stop reason is an ending, not
		// a cancellation of work already done.
		expect(result.steps).toBe(3);
	});

	it("never fires before there is a step behind it", async () => {
		// A rule that inspects history has nothing to inspect on step 1. Firing there
		// would end every run before it began.
		let calls = 0;
		const result = await run({
			model: scripted([{ text: "done" }]),
			shouldStop: () => {
				calls += 1;
				return true;
			},
		});

		expect(result.reason).toBe("completed");
		expect(calls).toBe(0);
	});

	it("runs before the generic guards, so a domain rule explains the stop", async () => {
		const result = await run({
			model: scripted([{ tool: "read" }, { tool: "read" }, { text: "c" }]),
			// A tight ceiling that would otherwise report `max-steps`.
			maxSteps: 2,
			shouldStop: () => true,
		});
		expect(result.reason).toBe("stopped-by-caller");
	});

	it("sees the tool calls made so far", async () => {
		// The shape a git-verify or hallucinated-tool rule needs, and the reason this
		// hook is worth having: it is domain knowledge the harness cannot have.
		const seen: Array<Array<string>> = [];
		await run({
			model: scripted([
				{ tool: "read" },
				{ tool: "read" },
				{ tool: "read" },
				{ text: "done" },
			]),
			shouldStop: ({ steps }) => {
				seen.push(steps.flatMap((entry) => [...entry.toolNames]));
				return false;
			},
		});
		expect(seen.at(-1)).toContain("read");
		expect(seen[0]).toEqual(["read", "read"]);
	});

	it("sees the transcript, for rules that read the assistant's text", async () => {
		const lengths: number[] = [];
		await run({
			model: scripted([{ tool: "read" }, { tool: "read" }, { text: "done" }]),
			shouldStop: ({ messages }) => {
				lengths.push(messages.length);
				return false;
			},
		});
		expect(lengths.length).toBeGreaterThan(0);
		expect(lengths.at(-1) ?? 0).toBeGreaterThan(lengths[0] ?? 0);
	});

	it("reports one step's tool calls, not a running total", async () => {
		// A regression guard: these two arrays were declared outside the step loop,
		// so every entry was a cumulative snapshot and `steps[1].toolNames` grew with
		// every call the run had ever made. Any caller rule counting them was wrong.
		const snapshots: Array<
			Array<{ step: number; toolNames: readonly string[] }>
		> = [];
		await run({
			model: scripted([
				{ tool: "read" },
				{ tool: "read" },
				{ tool: "read" },
				{ text: "done" },
			]),
			shouldStop: ({ steps }) => {
				snapshots.push(steps);
				return false;
			},
		});
		expect(snapshots[0]).toEqual([
			{ step: 1, toolNames: ["read"] },
			{ step: 2, toolNames: ["read"] },
		]);
		// One entry per step, each holding only that step's tools.
		expect(
			snapshots.at(-1)?.every((entry) => entry.toolNames.length === 1),
		).toBe(true);
	});

	it("is passed copies, so a rule cannot rewrite the run", async () => {
		await run({
			model: scripted([{ text: "a" }, { text: "b" }]),
			shouldStop: ({ messages }) => {
				// Mutating here must not reach the harness's own array.
				(messages as unknown as Array<{ content: unknown }>)[0] = {
					role: "user",
					content: "tampered",
				} as never;
				return false;
			},
		});
	});

	it("lets the run finish when it declines", async () => {
		const result = await run({
			model: scripted([{ text: "done" }]),
			shouldStop: () => undefined,
		});
		expect(result.reason).toBe("completed");
	});

	it("propagates a throw rather than silently not firing", async () => {
		// A rule that cannot decide must fail loudly; swallowing it would produce runs
		// that ignore a guard and look healthy.
		await expect(
			run({
				model: scripted([{ tool: "read" }, { tool: "read" }]),
				shouldStop: () => {
					throw new Error("rule bug");
				},
			}),
		).rejects.toThrow("rule bug");
	});

	it("awaits an async rule", async () => {
		const result = await run({
			model: scripted([{ tool: "read" }, { tool: "read" }, { text: "c" }]),
			shouldStop: async ({ stepNumber }) => {
				await Promise.resolve();
				return stepNumber >= 2;
			},
		});
		expect(result.reason).toBe("stopped-by-caller");
	});
});
