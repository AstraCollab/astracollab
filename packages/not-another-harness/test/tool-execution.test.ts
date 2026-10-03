import { describe, expect, it } from "vitest";
import type { LanguageModelV4StreamPart } from "@ai-sdk/provider";
import { tool } from "ai";
import { z } from "zod";

import { runAgent } from "../src/agent.js";
import { memorySink, traceRun } from "../src/telemetry.js";
import type { HarnessEvent } from "../src/types.js";
import {
	finishReason,
	scriptedModel,
	textChunks,
	toolCallChunks,
	v4Usage,
} from "./helpers/ai.js";

/**
 * Tool execution, in the fast suite.
 *
 * ## Why this file exists
 *
 * Every `tool-result` in this package used to be typed into a fixture by hand, so
 * a green suite said nothing about whether tools execute at all — and the pinned
 * conclusion was that `MockLanguageModelV4` *could not* be made to execute one,
 * leaving a live provider as the only real coverage. That conclusion was wrong,
 * and the reason it looked true is the subject of the first test: a tool call's
 * `input` is a **string** in a stream part and an **object** in a prompt part, so
 * a fixture copied from the prompt shape compiles through a cast and fails at
 * runtime with `input.trim is not a function`. Every fixture written that way
 * produced a `tool-error` and looked exactly like a tool that declined to answer.
 *
 * With the input stringified, the mock executes tools like anything else — no
 * network, no key, no flake, and the whole loop under test.
 */

const USAGE = v4Usage({ input: 10, output: 5 });

/** A tool that records its call and returns a fixed string. */
const recorder = (log: Array<{ input: unknown; context: unknown }>) =>
	tool({
		description: "Records the call. Always call this.",
		inputSchema: z.object({ step: z.string() }),
		execute: async (input: { step: string }, options: { context?: unknown }) => {
			log.push({ input, context: options?.context });
			return "recorded";
		},
	});

/** A tool that always throws, the way a tool with a bad path or a dead socket does. */
const thrower = (message: string) =>
	tool({
		description: "Always fails.",
		inputSchema: z.object({}),
		execute: async () => {
			throw new Error(message);
		},
	});

const drive = async (options: Parameters<typeof runAgent>[0]) => {
	const handle = runAgent({ system: "s", prompt: "go", maxSteps: 3, ...options });
	const events: HarnessEvent[] = [];
	for await (const event of handle.events) events.push(event);
	return { events, result: await handle.result };
};

const of = <T extends HarnessEvent["type"]>(
	events: HarnessEvent[],
	type: T,
): Extract<HarnessEvent, { type: T }>[] =>
	events.filter((e): e is Extract<HarnessEvent, { type: T }> => e.type === type);

/**
 * A tool call with `input` as an object — the shape a *prompt* part uses, and the
 * one that made this file's subject look impossible.
 */
const objectInputCall = (toolCallId: string, toolName: string, input: unknown) =>
	[
		{ type: "tool-input-start", id: toolCallId, toolName },
		{ type: "tool-input-delta", id: toolCallId, delta: "{}" },
		{ type: "tool-input-end", id: toolCallId },
		{ type: "tool-call", toolCallId, toolName, input },
		{ type: "finish", finishReason: finishReason("tool-calls"), usage: USAGE },
	] as unknown as LanguageModelV4StreamPart[];

describe("a tool's execute runs", () => {
	it("is called, and its result reaches the transcript and the events", async () => {
		const log: Array<{ input: unknown; context: unknown }> = [];
		const { events, result } = await drive({
			model: scriptedModel(
				toolCallChunks("record", { step: "s1" }, "t1", USAGE),
				textChunks("done", USAGE),
			),
			tools: { record: recorder(log) },
		});

		expect(log).toEqual([{ input: { step: "s1" }, context: undefined }]);
		expect(of(events, "tool-result")).toMatchObject([
			{
				step: 1,
				toolCallId: "t1",
				toolName: "record",
				output: "recorded",
				isError: false,
			},
		]);
		// The model must see the result too, or the second step is blind.
		const toolMessage = result.messages.find((m) => m.role === "tool");
		expect(toolMessage).toBeDefined();
		expect(result.text).toBe("done");
	});

	it("pairs every call with exactly one result", async () => {
		const log: Array<{ input: unknown; context: unknown }> = [];
		const { events } = await drive({
			model: scriptedModel(
				toolCallChunks("record", { step: "s1" }, "t1", USAGE),
				toolCallChunks("record", { step: "s2" }, "t2", USAGE),
				textChunks("done", USAGE),
			),
			tools: { record: recorder(log) },
		});

		expect(log).toHaveLength(2);
		const calls = of(events, "tool-call").map((e) => e.toolCallId);
		const results = of(events, "tool-result").map((e) => e.toolCallId);
		expect(calls).toEqual(["t1", "t2"]);
		expect(results).toEqual(calls);
	});
});

describe("a tool that fails", () => {
	it("surfaces as an error result rather than vanishing", async () => {
		// This is the assertion the harness could not make before: the SDK reports a
		// thrown tool as a `tool-error` part, and the loop mapped neither that nor
		// anything else, so a failed tool produced a `tool-call` event and then
		// nothing at all. Not an error, not a result — a call that never returned,
		// to every consumer of `events`.
		const log: Array<{ input: unknown; context: unknown }> = [];
		const { events, result } = await drive({
			model: scriptedModel(
				toolCallChunks("record", { step: "s1" }, "t1", USAGE),
				textChunks("moving on", USAGE),
			),
			tools: {
				record: tool({
					description: "Fails.",
					inputSchema: z.object({ step: z.string() }),
					execute: async () => {
						throw new Error("ENOENT: no such file");
					},
				}),
			},
		});

		expect(of(events, "tool-result")).toMatchObject([
			{
				toolCallId: "t1",
				toolName: "record",
				output: "Error: ENOENT: no such file",
				isError: true,
			},
		]);
		// Not a run-level error: the SDK hands the failure to the model as
		// error-text, and a harness that threw would turn one bad `grep` into a
		// dead run.
		expect(of(events, "error")).toHaveLength(0);
		expect(result.text).toBe("moving on");
		expect(log).toHaveLength(0);
	});

	it("marks the tool span as failed in a trace", async () => {
		// The telemetry consumer already read `isError` and set `status: "error"` —
		// a branch no event could reach, because nothing produced an error result.
		// Asserted here over a real run rather than over hand-written events, so
		// the branch and the producer of the events it reads are pinned together.
		const sink = memorySink();
		const handle = runAgent({
			model: scriptedModel(
				toolCallChunks("record", { step: "s1" }, "t1", USAGE),
				textChunks("done", USAGE),
			),
			tools: { record: thrower("nope") },
			system: "s",
			prompt: "go",
			maxSteps: 2,
		});
		await traceRun({ sink }, handle.events);
		await handle.result;

		const toolSpan = sink.spans.find((s) => s.name.startsWith("tool: "));
		expect(toolSpan?.status).toBe("error");
		expect(toolSpan?.attributes["nah.tool.error"]).toBe(true);
	});

	it("reports the fixture trap as an error instead of a silent hang", async () => {
		// Pinned deliberately. An object-shaped `input` — the shape a *prompt* part
		// uses — makes the SDK throw `input.trim is not a function` before the tool
		// is reached. Before `tool-error` was mapped, that was indistinguishable
		// from a model that declined to call anything. If this test ever starts
		// failing because a fixture must be object-shaped again, the SDK changed the
		// stream contract and the fixtures in `helpers/ai.ts` are the thing to fix.
		const log: Array<{ input: unknown; context: unknown }> = [];
		const { events } = await drive({
			model: scriptedModel(
				objectInputCall("t1", "record", { step: "s1" }),
				textChunks("gave up", USAGE),
			),
			tools: { record: recorder(log) },
		});

		expect(log).toHaveLength(0);
		expect(of(events, "tool-call").map((e) => e.toolCallId)).toEqual(["t1"]);
		const [result] = of(events, "tool-result");
		expect(result?.isError).toBe(true);
		expect(result?.output).toContain("trim");
	});
});