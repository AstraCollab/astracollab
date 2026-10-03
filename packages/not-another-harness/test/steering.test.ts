import type { LanguageModelV4StreamPart } from "@ai-sdk/provider";
import { simulateReadableStream } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";

import { runAgent } from "../src/agent.js";
import type { HarnessEvent, HarnessRun } from "../src/types.js";
import { finishReason, v4Usage } from "./helpers/ai.js";

const USAGE = v4Usage({ input: 100, output: 20 });

const textStream = (text: string) =>
	simulateReadableStream<LanguageModelV4StreamPart>({
		chunkDelayInMs: 0,
		chunks: [
			{ type: "text-start", id: "t1" },
			{ type: "text-delta", id: "t1", delta: text },
			{ type: "text-end", id: "t1" },
			{ type: "finish", finishReason: finishReason("stop"), usage: USAGE },
		],
	});

const toolCallStream = (id: string) =>
	simulateReadableStream<LanguageModelV4StreamPart>({
		chunkDelayInMs: 0,
		chunks: [
			{
				type: "tool-call",
				toolCallId: id,
				toolName: "read",
				input: JSON.stringify({ path: "x" }),
			},
			{
				type: "finish",
				finishReason: finishReason("tool-calls"),
				usage: USAGE,
			},
		],
	});

/** Scripted model that records the exact prompt each step received. */
const scripted = (steps: Array<"tool" | string>) => {
	const prompts: string[] = [];
	let index = 0;
	const model = new MockLanguageModelV4({
		doStream: async ({ prompt }) => {
			prompts.push(JSON.stringify(prompt));
			const plan = steps[Math.min(index, steps.length - 1)] ?? "done";
			index += 1;
			return {
				stream:
					plan === "tool" ? toolCallStream(`call-${index}`) : textStream(plan),
			};
		},
	});
	return { model, prompts };
};

const drain = async (
	events: AsyncIterable<HarnessEvent>,
): Promise<HarnessEvent[]> => {
	const out: HarnessEvent[] = [];
	for await (const e of events) out.push(e);
	return out;
};

const userTexts = (messages: unknown[]): string[] =>
	messages
		.map((m) => m as { role?: string; content?: unknown })
		.filter((m) => m.role === "user" && typeof m.content === "string")
		.map((m) => m.content as string);

describe("steering", () => {
	it("delivers a steer at the next step boundary, never into the step in flight", async () => {
		const { model, prompts } = scripted(["tool", "steered-done", "final"]);
		const run: HarnessRun = runAgent({
			model,
			system: "s",
			prompt: "start",
			tools: {},
			onStepFinish: (step) => {
				if (step === 1) run.steer("actually use TypeScript");
			},
		});
		const result = await run.result;
		await drain(run.events);

		// Step 1 was already assembled when the steer arrived — it must not appear.
		expect(prompts[0]).not.toContain("actually use TypeScript");
		// Step 2 sees it.
		expect(prompts[1]).toContain("actually use TypeScript");
		expect(result.reason).toBe("completed");
		expect(userTexts(result.messages)).toContain("actually use TypeScript");
	});

	it("delivers a follow-up instead of completing when the model gives a final answer", async () => {
		const { model } = scripted([
			"tool",
			"All done.",
			"Also updated the changelog.",
		]);
		const run = runAgent({ model, system: "s", prompt: "start", tools: {} });
		run.followUp("also update the changelog");

		const result = await run.result;
		const events = await drain(run.events);

		// The run did not stop at the model's first "final" answer.
		expect(result.reason).toBe("completed");
		expect(result.steps).toBe(3);
		expect(result.text).toBe("Also updated the changelog.");
		expect(userTexts(result.messages)).toContain("also update the changelog");

		expect(events.filter((e) => e.type === "user-message")).toEqual([
			{
				type: "user-message",
				text: "also update the changelog",
				delivery: "follow-up",
				phase: "queued",
			},
			{
				type: "user-message",
				text: "also update the changelog",
				delivery: "follow-up",
				phase: "delivered",
			},
		]);
	});

	it("does not let maxSteps discard a message the user deliberately sent", async () => {
		const { model } = scripted(["tool", "tool", "tool", "final"]);
		const run = runAgent({
			model,
			system: "s",
			prompt: "start",
			tools: {},
			maxSteps: 2,
			onStepFinish: (step) => {
				if (step === 1) run.steer("keep going, one more thing");
			},
		});
		const result = await run.result;
		await drain(run.events);

		// maxSteps 2 would have stopped at step 2 with the steer undelivered.
		expect(result.reason).toBe("completed");
		expect(userTexts(result.messages)).toContain("keep going, one more thing");
	});

	it("delivers steers ahead of follow-ups and keeps their order", async () => {
		const { model } = scripted(["tool", "ok"]);
		const run = runAgent({ model, system: "s", prompt: "start", tools: {} });
		run.followUp("second");
		run.steer("first");
		run.steer("first again");

		const result = await run.result;
		await drain(run.events);

		const texts = userTexts(result.messages);
		expect(texts.indexOf("first")).toBeGreaterThanOrEqual(0);
		expect(texts.indexOf("first")).toBeLessThan(texts.indexOf("first again"));
		expect(texts.indexOf("first again")).toBeLessThan(texts.indexOf("second"));
	});

	it("exposes queued messages and rejects them once settled", async () => {
		const { model } = scripted(["tool", "ok"]);
		const run = runAgent({ model, system: "s", prompt: "start", tools: {} });
		expect(run.pending()).toEqual({ steer: [], followUp: [] });

		expect(run.steer("  padded  ")).toBe(true);
		expect(run.pending().steer).toEqual(["padded"]);
		expect(run.steer("   ")).toBe(false);

		await run.result;
		await drain(run.events);

		// A settled run must not silently swallow input.
		expect(run.steer("too late")).toBe(false);
		expect(run.followUp("too late")).toBe(false);
	});

	it("does not drop a steer sent while the model was writing its final answer", async () => {
		// The nastiest timing: the model streams its closing message, the user
		// reacts, and the run would otherwise end right there. Only follow-ups used
		// to be honoured at the completion point, so the steer vanished.
		const { model } = scripted(["All done."]);
		const run = runAgent({
			model,
			system: "s",
			prompt: "start",
			tools: {},
			onStepFinish: (step) => {
				if (step === 1) run.steer("actually also update the changelog");
			},
		});

		const result = await run.result;
		await drain(run.events);

		expect(result.reason).toBe("completed");
		expect(result.steps).toBe(2);
		expect(userTexts(result.messages)).toContain(
			"actually also update the changelog",
		);
	});

	it("interrupt aborts the run and leaves queued messages for the caller", async () => {
		const { model } = scripted(["tool", "tool", "never"]);
		const run = runAgent({ model, system: "s", prompt: "start", tools: {} });
		run.steer("keep this");
		run.interrupt();

		const result = await run.result;
		const events = await drain(run.events);
		expect(result.reason).toBe("aborted");
		expect(
			events.some((e) => e.type === "finish" && e.reason === "aborted"),
		).toBe(true);
		// Queued input survives so the host can decide to replay it.
		expect(run.pending().steer).toEqual(["keep this"]);
	});

	it("still honours an external abort signal", async () => {
		const abort = new AbortController();
		const { model } = scripted(["tool", "tool"]);
		const run = runAgent({
			model,
			system: "s",
			prompt: "start",
			tools: {},
			abortSignal: abort.signal,
		});
		abort.abort();
		const result = await run.result;
		await drain(run.events);
		expect(result.reason).toBe("aborted");
	});
});
