import { describe, expect, it } from "vitest";
import { tool } from "ai";
import { z } from "zod";

import { runAgent } from "../src/agent.js";

/**
 * Tool execution against a real provider.
 *
 * ## What this file is for now
 *
 * It used to be the *only* coverage of tool execution, because no
 * `MockLanguageModelV4` stream shape was thought to exist that the SDK would
 * execute. One did: a tool call's `input` is a **string** in a stream part and an
 * object in a prompt part, and a fixture copied from the prompt shape produces
 * `input.trim is not a function` — a failure that looks exactly like a tool that
 * declined to answer. `tool-execution.test.ts` now covers execution, error
 * surfacing and `toolsContext` in the fast suite, and pins that trap.
 *
 * So what is left here is the one thing a mock cannot tell you: that a real
 * provider's stream, parsed and executed by the real SDK, runs the tool and
 * delivers the context. Cheap insurance against a fixture that has drifted from
 * the protocol rather than from the SDK.
 *
 * ## Cost
 *
 * One model per test, on a free model, with a one-word prompt and a tool whose
 * input schema requires nothing, so a model cannot fail to produce a valid call.
 * The tool exists only to be called; the point is the call, not what it returns.
 *
 * Skipped without a key, so a machine without one still runs the suite.
 */

const apiKey = process.env.OPENROUTER_API_KEY?.trim();
const MODEL = process.env.NAH_LIVE_TEST_MODEL ?? "stealth/space-bunny-alpha";

/** OpenRouter speaks the OpenAI protocol; the base URL is the only difference. */
const model = () => {
	// Imported lazily so a machine with no provider installed still typechecks.
	const { createOpenAI } = require("@ai-sdk/openai") as typeof import("@ai-sdk/openai");
	const provider = createOpenAI({ apiKey, baseURL: "https://openrouter.ai/api/v1" });
	const any_ = provider as unknown as { chat?: (id: string) => unknown; languageModel?: (id: string) => unknown };
	return (any_.chat ?? any_.languageModel)! (MODEL) as Parameters<typeof runAgent>[0]["model"];
};

type Seen = { context: unknown; path: unknown };

const recorder = (log: Seen[]) =>
	tool({
		description: "Record the call. Always call this.",
		inputSchema: z.object({ path: z.string().optional() }),
		execute: async (input: { path?: string }, options: { context?: unknown }) => {
			log.push({ context: options?.context, path: input.path });
			return "recorded";
		},
	});

const drive = async (options: Parameters<typeof runAgent>[0]) => {
	const handle = runAgent({ system: "You must call the record tool.", maxSteps: 2, ...options });
	const kinds: string[] = [];
	for await (const part of handle.events) kinds.push(part.type);
	return { result: await handle.result, kinds };
};

describe.skipIf(!apiKey)(`tool execution against a real provider (${MODEL})`, () => {
	it("runs a tool's execute and returns its result", async () => {
		const log: Seen[] = [];
		const { kinds, result } = await drive({
			model: model(),
			prompt: "Call the record tool.",
			tools: { record: recorder(log) },
		});

		expect(log).toHaveLength(1);
		expect(kinds).toContain("tool-result");
		// And no swallowed failure: a real provider's call is a shape the SDK executes.
		expect(kinds).not.toContain("error");
		expect(result.messages.some((message) => message.role === "tool")).toBe(true);
	}, 60_000);

	it("delivers toolsContext to the tool", async () => {
		const log: Seen[] = [];
		await drive({
			model: model(),
			prompt: "Call the record tool.",
			tools: { record: recorder(log) },
			// Keyed by tool name. Unkeyed, this reaches nothing and looks identical
			// to the option being broken.
			toolsContext: { record: { actor: { id: "u1" } } },
		});
		expect(log).toHaveLength(1);
		expect(log[0]!.context).toEqual({ actor: { id: "u1" } });
	}, 60_000);

	it("lets prepareStep replace the tool context per step", async () => {
		const log: Seen[] = [];
		await drive({
			model: model(),
			prompt: "Call the record tool.",
			tools: { record: recorder(log) },
			toolsContext: { record: { step: 0 } },
			prepareStep: ({ stepNumber }) => ({
				toolsContext: { record: { step: stepNumber } },
			}),
		});
		expect(log.length).toBeGreaterThan(0);
		expect(log[0]!.context).toEqual({ step: 1 });
	}, 60_000);
});