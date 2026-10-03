import { describe, expect, it } from "vitest";
import { tool } from "ai";
import { z } from "zod";

import { runAgent } from "../src/agent.js";
import { scriptedModel, textChunks, toolCallChunks, v4Usage } from "./helpers/ai.js";
import type { ToolContextMap } from "../src/types.js";

/**
 * `toolsContext`: per-step values a tool reads as `options.context`.
 *
 * ## The mistake this file exists to prevent
 *
 * The SDK reads a tool's context as `toolsContext[toolName]` — a map keyed by tool
 * name, one slice per tool. Handing it a single shared object is not a shape it
 * rejects or warns about; it reads as *the context of a tool whose name happens to
 * be `actor`*, so every real tool receives `undefined` and the wiring looks
 * installed. That is how this option spent a long time believed broken: it was
 * forwarded correctly and keyed wrongly, in a package whose own tests could not
 * execute a tool at all, so nothing could say so. See `tool-execution.test.ts`,
 * which can now, and the pinning of the wrong shape below.
 */

const USAGE = v4Usage({ input: 10, output: 5 });

type Seen = { context: unknown };

const recorder = (log: Seen[]) =>
	tool({
		description: "Records the call. Always call this.",
		inputSchema: z.object({ step: z.string() }),
		execute: async (_input: { step: string }, options: { context?: unknown }) => {
			log.push({ context: options?.context });
			return "recorded";
		},
	});

/** Call `record` once, then answer in text on every later step. */
const callsRecordThenAnswers = () =>
	scriptedModel(toolCallChunks("record", { step: "s1" }, "t1", USAGE), textChunks("done", USAGE));

const drive = async (options: Parameters<typeof runAgent>[0]) => {
	const handle = runAgent({ system: "s", prompt: "go", maxSteps: 4, ...options });
	for await (const _ of handle.events) {
		// Drained, because a run only advances while someone is reading.
	}
	return handle.result;
};

describe("toolsContext", () => {
	it("reaches the tool it is keyed by", async () => {
		const log: Seen[] = [];
		await drive({
			model: callsRecordThenAnswers(),
			tools: { record: recorder(log) },
			toolsContext: { record: { actor: { id: "u1" } } },
		});

		expect(log).toEqual([{ context: { actor: { id: "u1" } } }]);
	});

	it("is read per tool, so a key that is not a tool name reaches nothing", async () => {
		// The failure mode, pinned: one shared object instead of one slice per tool.
		// Nothing throws, no warning is logged, and the tool sees `undefined` — so
		// this reads as "context is not delivered" and sends the next person looking
		// for a forwarding bug that does not exist.
		const log: Seen[] = [];
		await drive({
			model: callsRecordThenAnswers(),
			tools: { record: recorder(log) },
			toolsContext: { actor: { id: "u1" } } as ToolContextMap,
		});

		expect(log).toHaveLength(1);
		expect(log[0]?.context).toBeUndefined();
	});

	it("leaves a tool without a slice alone", async () => {
		const log: Seen[] = [];
		await drive({
			model: callsRecordThenAnswers(),
			tools: { record: recorder(log) },
			toolsContext: { someOtherTool: { actor: "u1" } },
		});

		expect(log[0]?.context).toBeUndefined();
	});

	it("can be replaced per step by prepareStep", async () => {
		// The reason this option exists: a step counter cannot be closed over,
		// because the tools are built once, before any step has run.
		const log: Seen[] = [];
		const seen: number[] = [];
		await drive({
			model: scriptedModel(
				toolCallChunks("record", { step: "s1" }, "t1", USAGE),
				toolCallChunks("record", { step: "s2" }, "t2", USAGE),
				textChunks("done", USAGE),
			),
			tools: { record: recorder(log) },
			toolsContext: { record: { step: "run" } },
			prepareStep: ({ stepNumber }) => {
				seen.push(stepNumber);
				return { toolsContext: { record: { step: stepNumber } } };
			},
		});

		// `prepareStep` is per step and does not carry forward, so each step
		// recomputes from `stepNumber`. A value that did carry forward would show
		// `[1, 1]` here and quietly hand every later step the first step's context.
		expect(seen).toEqual([1, 2, 3]);
		expect(log).toEqual([{ context: { step: 1 } }, { context: { step: 2 } }]);
	});

	it("falls back to the run's context on a step that overrides nothing", async () => {
		const log: Seen[] = [];
		await drive({
			model: scriptedModel(
				toolCallChunks("record", { step: "s1" }, "t1", USAGE),
				toolCallChunks("record", { step: "s2" }, "t2", USAGE),
				textChunks("done", USAGE),
			),
			tools: { record: recorder(log) },
			toolsContext: { record: { step: "run" } },
			// Only the first step overrides; the second returns nothing.
			prepareStep: ({ stepNumber }) =>
				stepNumber === 1 ? { toolsContext: { record: { step: 1 } } } : {},
		});

		expect(log).toEqual([{ context: { step: 1 } }, { context: { step: "run" } }]);
	});

	it("survives the harness's tool wrappers", async () => {
		// Dedupe, read-coverage and cache marking each rebuild the tool set. A
		// wrapper that rebuilt a tool from its `execute` alone would drop the
		// context on the floor, and only a tool that is actually called would notice.
		// Two steps here, because dedupe's memo is per step by design: an identical
		// call in the next step is a deliberate re-run, not a duplicate.
		const log: Seen[] = [];
		await drive({
			model: scriptedModel(
				toolCallChunks("record", { step: "s1" }, "t1", USAGE),
				toolCallChunks("record", { step: "s1" }, "t2", USAGE),
				textChunks("done", USAGE),
			),
			tools: { record: recorder(log) },
			toolsContext: { record: { actor: "u1" } },
			cacheProvider: "anthropic",
		});

		expect(log).toEqual([
			{ context: { actor: "u1" } },
			{ context: { actor: "u1" } },
		]);
	});
});