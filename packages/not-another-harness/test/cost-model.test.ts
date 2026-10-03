import { describe, expect, it } from "vitest";

import type { ModelMessage } from "ai";
import {
	type ContextPolicy,
	analysePolicies,
	hasReasoning,
	messageTokens,
	messagesFromSessionJsonl,
} from "../src/cost-model.js";

const bigResult = (id: string, chars: number): ModelMessage =>
	({
		role: "tool",
		content: [
			{
				type: "tool-result",
				toolCallId: id,
				output: { type: "text", value: "x".repeat(chars) },
			},
		],
	}) as unknown as ModelMessage;

const call = (id: string): ModelMessage =>
	({
		role: "assistant",
		content: [
			{ type: "tool-call", toolCallId: id, toolName: "probe", input: "{}" },
		],
	}) as unknown as ModelMessage;

/** user, then five rounds of assistant-call + tool-result, then a final reply. */
const transcript = (): ModelMessage[] => [
	{ role: "user", content: "go" } as ModelMessage,
	...Array.from({ length: 5 }, (_, i) => [
		call(`c${i}`),
		bigResult(`c${i}`, 4000),
	]).flat(),
	{
		role: "assistant",
		content: [{ type: "text", text: "done" }],
	} as unknown as ModelMessage,
];

describe("cost model", () => {
	it("counts a tool result's text, wherever it is nested", () => {
		expect(messageTokens(bigResult("a", 400))).toBeGreaterThan(90);
		const inline = {
			role: "tool",
			content: [{ type: "tool-result", output: "y".repeat(400) }],
		} as unknown as ModelMessage;
		expect(messageTokens(inline)).toBeGreaterThan(90);
	});

	it("grows the request with every step, since the transcript is resent", () => {
		const [report] = analysePolicies(transcript(), [{ kind: "none" }]);
		expect(report?.perStep.length).toBe(6);
		for (let i = 1; i < report?.perStep.length; i += 1) {
			expect(report?.perStep[i]!).toBeGreaterThan(report?.perStep[i - 1]!);
		}
	});

	it("counts the static prefix into every step", () => {
		const withPrefix = analysePolicies(
			transcript(),
			[{ kind: "none" }],
			1000,
		)[0]!;
		const without = analysePolicies(transcript(), [{ kind: "none" }])[0]!;
		expect(withPrefix.totalProcessed - without.totalProcessed).toBe(1000 * 6);
	});

	it("prunes old rounds and always keeps the newest", () => {
		const [report] = analysePolicies(transcript(), [
			{ kind: "recent-rounds", keep: 1 },
		]);
		expect(report?.tailToolTokens).toBeGreaterThan(0);
		expect(report?.totalProcessed).toBeLessThan(
			analysePolicies(transcript(), [{ kind: "none" }])[0]?.totalProcessed,
		);
	});

	it("is not defeated by a skewed distribution, which a count is", () => {
		// The huge result sits *inside* a 3-round window, where position alone keeps
		// it. A token budget drops it and keeps the cheap rounds around it instead.
		const skewed: ModelMessage[] = [
			{ role: "user", content: "go" } as ModelMessage,
			call("a"),
			bigResult("a", 2_000),
			call("b"),
			bigResult("b", 40_000),
			call("c"),
			bigResult("c", 200),
			call("d"),
			bigResult("d", 200),
		];
		const byCount = analysePolicies(skewed, [
			{ kind: "recent-rounds", keep: 3 },
		])[0]!;
		const byBudget = analysePolicies(skewed, [
			{ kind: "token-budget", tokens: 400 },
		])[0]!;
		expect(byCount.tailToolTokens).toBeGreaterThan(5_000);
		expect(byBudget.tailToolTokens).toBeLessThan(500);
	});

	it("keeps monotonically fewer rounds as the count falls", () => {
		const reports = analysePolicies(transcript(), [
			{ kind: "recent-rounds", keep: 5 },
			{ kind: "recent-rounds", keep: 3 },
			{ kind: "recent-rounds", keep: 1 },
		]);
		expect(reports[0]?.totalProcessed).toBeGreaterThan(
			reports[1]?.totalProcessed,
		);
		expect(reports[1]?.totalProcessed).toBeGreaterThan(
			reports[2]?.totalProcessed,
		);
	});

	it("never retains more tool output than no pruning at all", () => {
		// The earlier version of this test asserted the policies were ordered by
		// cost, which is false: a generous token budget can keep more rounds than a
		// tight count. What must hold is only that pruning never adds.
		const reports = analysePolicies(transcript(), [
			{ kind: "none" },
			{ kind: "recent-rounds", keep: 8 },
			{ kind: "recent-rounds", keep: 3 },
			{ kind: "token-budget", tokens: 500 },
			{ kind: "token-budget", tokens: 5_000 },
		]);
		const none = reports[0]!;
		for (const report of reports.slice(1)) {
			expect(report.tailToolTokens).toBeLessThanOrEqual(none.tailToolTokens);
			expect(report.totalProcessed).toBeLessThanOrEqual(none.totalProcessed);
		}
	});

	it("keeps the newest round even when it alone busts the budget", () => {
		const messages: ModelMessage[] = [
			{ role: "user", content: "go" } as ModelMessage,
			call("a"),
			bigResult("a", 100_000),
		];
		const [report] = analysePolicies(messages, [
			{ kind: "token-budget", tokens: 10 },
		]);
		expect(report?.tailToolTokens).toBeGreaterThan(1000);
	});

	it("reports steps over a compaction trigger", () => {
		const [report] = analysePolicies(transcript(), [{ kind: "none" }]);
		expect(report?.stepsOver(0)).toBe(report?.perStep.length);
		expect(report?.stepsOver(Number.MAX_SAFE_INTEGER)).toBe(0);
	});

	it("detects reasoning, which decides whether pruning may run", () => {
		expect(hasReasoning(transcript())).toBe(false);
		expect(
			hasReasoning([
				{
					role: "assistant",
					content: [{ type: "reasoning", text: "hmm" }],
				} as unknown as ModelMessage,
			]),
		).toBe(true);
	});

	it("reads messages out of a session file and skips non-message records", () => {
		const jsonl = [
			JSON.stringify({ kind: "usage", id: "u1", at: "x", totalTokens: 5 }),
			JSON.stringify({
				kind: "message",
				id: "m1",
				at: "x",
				message: { role: "user", content: "hi" },
			}),
			"not json at all",
			JSON.stringify({
				kind: "message",
				id: "m2",
				at: "x",
				message: { role: "assistant", content: "yo" },
			}),
		].join("\n");
		expect(messagesFromSessionJsonl(jsonl)).toEqual([
			{ role: "user", content: "hi" },
			{ role: "assistant", content: "yo" },
		]);
	});
});
