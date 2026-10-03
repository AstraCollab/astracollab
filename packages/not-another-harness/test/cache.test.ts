import type { LanguageModelV4StreamPart } from "@ai-sdk/provider";
import { simulateReadableStream } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";

import type { ModelMessage } from "ai";
import { runAgent } from "../src/agent.js";
import {
	MAX_CACHE_BREAKPOINTS,
	cacheOptions,
	contextManagementOptions,
	supportsCaching,
	withCachedTail,
	withCachedToolSchemas,
} from "../src/cache.js";
import { finishReason, v4Usage } from "./helpers/ai.js";

const USAGE = v4Usage({ input: 10, output: 2 });

describe("cache breakpoint detection", () => {
	it("enables Anthropic and OpenRouter, not unknown providers", () => {
		expect(supportsCaching("anthropic")).toBe(true);
		expect(supportsCaching("openrouter")).toBe(true);
		expect(supportsCaching("openai")).toBe(false);
		expect(supportsCaching(undefined)).toBe(false);
	});

	it("emits an ephemeral breakpoint with the requested ttl", () => {
		expect(cacheOptions("anthropic")).toEqual({
			anthropic: { cacheControl: { type: "ephemeral", ttl: "5m" } },
		});
		expect(cacheOptions("anthropic", "1h")).toEqual({
			anthropic: { cacheControl: { type: "ephemeral", ttl: "1h" } },
		});
		expect(cacheOptions("openai")).toBeUndefined();
	});
});

describe("tool schema caching", () => {
	it("marks only the last tool, since a breakpoint covers the whole prefix", () => {
		// A breakpoint marks a prefix ending at its block, so the final tool carries
		// the entire tool block into cache. Marking each tool spends the provider's
		// four-breakpoint budget to say one thing N times — and the excess is
		// discarded silently, so the unmarked tools are re-billed in full on every
		// step with nothing in the logs.
		const tools = withCachedToolSchemas(
			{
				a: { description: "x" },
				b: { description: "y" },
				c: { description: "z" },
			},
			"anthropic",
		);
		const byName = tools as Record<
			string,
			{ providerOptions?: { anthropic?: { cacheControl?: unknown } } }
		>;
		const marked = (name: string) =>
			byName[name]?.providerOptions?.anthropic?.cacheControl;
		expect(marked("a")).toBeUndefined();
		expect(marked("b")).toBeUndefined();
		expect(marked("c")).toEqual({ type: "ephemeral", ttl: "5m" });
	});

	it("stays within the provider breakpoint budget for a realistic tool count", () => {
		// An 11-tool session previously emitted 11 markers; 4 survived and 7 were
		// dropped by the SDK validator. One marker is all that is needed.
		const tools: Record<string, unknown> = {};
		for (const name of [
			"read",
			"list",
			"grep",
			"edit",
			"write",
			"outline",
			"bash",
			"glob",
			"recall",
			"task_ledger",
			"delegate_task",
		]) {
			tools[name] = { description: name };
		}
		const out = withCachedToolSchemas(tools, "anthropic");
		const count = Object.values(out).filter((t) =>
			Boolean(
				(t as { providerOptions?: { anthropic?: { cacheControl?: unknown } } })
					.providerOptions?.anthropic?.cacheControl,
			),
		).length;
		expect(count).toBe(1);
		expect(count).toBeLessThanOrEqual(MAX_CACHE_BREAKPOINTS);
	});

	it("leaves tools untouched for providers that ignore breakpoints", () => {
		const tools = { a: { description: "x" } };
		expect(withCachedToolSchemas(tools, "openai")).toBe(tools);
	});

	it("preserves other provider options on the marked tool", () => {
		const tools = {
			a: { description: "x" },
			b: {
				description: "y",
				providerOptions: { openai: { parallelToolCalls: false } },
			},
		};
		const out = withCachedToolSchemas(tools, "anthropic") as Record<
			string,
			{ providerOptions?: Record<string, Record<string, unknown>> }
		>;
		expect(out.b?.providerOptions?.openai).toEqual({
			parallelToolCalls: false,
		});
		expect(out.b?.providerOptions?.anthropic).toBeDefined();
		// The earlier tool is untouched, so its own options survive as-is.
		expect(
			(out.a as { providerOptions?: unknown }).providerOptions,
		).toBeUndefined();
	});

	it("passes non-object tools through unchanged", () => {
		expect(
			withCachedToolSchemas({ a: undefined }, "anthropic").a,
		).toBeUndefined();
	});

	it("returns an empty tool set unchanged", () => {
		const empty = {};
		expect(withCachedToolSchemas(empty, "anthropic")).toBe(empty);
	});
});

describe("moving tail breakpoint", () => {
	const messages: ModelMessage[] = [
		{ role: "user", content: "one" },
		{ role: "assistant", content: [{ type: "text", text: "two" }] },
		{ role: "user", content: "three" },
		{ role: "assistant", content: [{ type: "text", text: "four" }] },
	];

	const cacheControlAt = (msgs: ModelMessage[], index: number) =>
		(
			msgs[index] as {
				providerOptions?: { anthropic?: { cacheControl?: unknown } };
			}
		).providerOptions?.anthropic?.cacheControl;

	it("marks the message that the previous request already sent", () => {
		// Marking the very last message would write a fresh cache entry on every
		// step and read nothing back. The prefix must be one a prior request wrote.
		const out = withCachedTail(messages, 2, "anthropic");
		expect(cacheControlAt(out, 2)).toEqual({ type: "ephemeral", ttl: "5m" });
		expect(cacheControlAt(out, 3)).toBeUndefined();
	});

	it("never rewrites message content, so thinking signatures stay valid", () => {
		const withThinking: ModelMessage[] = [
			{
				role: "assistant",
				content: [
					{ type: "reasoning", text: "thought", signature: "sig" } as never,
				],
			},
			{ role: "user", content: "next" },
		];
		const out = withCachedTail(withThinking, 0, "anthropic");
		expect(out[0]?.content).toEqual(withThinking[0]?.content);
		expect(JSON.stringify(out[0]?.content)).toContain("sig");
	});

	it("clamps a stale index rather than marking a message that does not exist", () => {
		// After compaction the transcript is shorter than the index the previous
		// request used. Reading past the end would mark nothing and silently lose
		// the cache entirely.
		const out = withCachedTail(messages, 99, "anthropic");
		expect(cacheControlAt(out, messages.length - 1)).toBeDefined();
		expect(out).toHaveLength(messages.length);
	});

	it("is a no-op for providers that ignore breakpoints", () => {
		expect(withCachedTail(messages, 2, "openai")).toEqual(messages);
	});
});

describe("caching reaches the model call", () => {
	const capture = async (cacheProvider: string | undefined) => {
		const seen: Array<Record<string, unknown>> = [];
		let call = 0;
		const model = new MockLanguageModelV4({
			doStream: async (options: Record<string, unknown>) => {
				seen.push(options);
				const done = call++ > 0;
				const chunks: LanguageModelV4StreamPart[] = [];
				if (!done) {
					chunks.push({
						type: "tool-call",
						toolCallId: "c",
						toolName: "probe",
						input: "{}",
					});
				} else {
					chunks.push(
						{ type: "text-start", id: "t" },
						{ type: "text-delta", id: "t", delta: "ok" },
						{ type: "text-end", id: "t" },
					);
				}
				chunks.push({
					type: "finish",
					finishReason: finishReason(done ? "stop" : "tool-calls"),
					usage: USAGE,
				});
				return {
					stream: simulateReadableStream({ chunkDelayInMs: 0, chunks }),
				};
			},
		});

		const tools = { probe: { execute: async () => "r" } };
		const run = runAgent({
			model: model as never,
			system: "sys",
			prompt: "go",
			tools: tools as never,
			maxSteps: 3,
			compaction: "off",
			cacheProvider,
		});
		for await (const _ of run.events) {
			// drain
		}
		await run.result;
		return seen;
	};

	it("sends breakpoints when the provider supports them", async () => {
		const seen = await capture("anthropic");
		const anthropic = (
			seen[0]?.providerOptions as { anthropic: Record<string, unknown> }
		).anthropic;
		// Context editing rides in the same provider block as the cache breakpoint.
		const edits = (
			anthropic.contextManagement as { edits: Array<{ type: string }> }
		).edits;
		expect(edits[0]?.type).toBe("clear_tool_uses_20250919");
	});

	it("keeps the request-level breakpoint when context editing is also set", async () => {
		// Both options live under the same provider key, so merging them with a plain
		// spread lets the second erase the first. That silently uncached the system
		// prompt: requests still succeeded, they just stopped being cheap, and the
		// only symptom was a bill.
		const seen = await capture("anthropic");
		const anthropic = (
			seen[0]?.providerOptions as { anthropic: Record<string, unknown> }
		).anthropic;
		expect(anthropic.cacheControl).toEqual({ type: "ephemeral", ttl: "5m" });
		expect(anthropic.contextManagement).toBeDefined();
	});

	it("marks the transcript tail on the request that carries it", async () => {
		// The tail is the only part of the request that grows, so it is the only part
		// worth spending a breakpoint on for a long run.
		const seen = await capture("anthropic");
		const prompt = seen[0]?.prompt as Array<Record<string, unknown>>;
		const marked = prompt.filter((message) => {
			const options = (
				message.providerOptions as
					| { anthropic?: { cacheControl?: unknown } }
					| undefined
			)?.anthropic;
			return Boolean(options?.cacheControl);
		});
		expect(marked.length).toBe(1);
	});

	it("sends none for a provider that would ignore them", async () => {
		const seen = await capture("openai");
		expect(seen[0]?.providerOptions).toBeUndefined();
	});
});

describe("server-side context editing", () => {
	it("asks the API to clear old tool results, keeping recent rounds", () => {
		const options = contextManagementOptions("anthropic") as {
			anthropic: {
				contextManagement: { edits: Array<Record<string, unknown>> };
				anthropicBeta: string[];
			};
		};
		const edit = options.anthropic.contextManagement.edits[0]!;
		expect(edit.type).toBe("clear_tool_uses_20250919");
		expect(edit.trigger).toEqual({ type: "input_tokens", value: 40_000 });
		expect(edit.keep).toEqual({ type: "tool_uses", value: 6 });
		// Results only — the model should still see what it asked for.
		expect(edit.clearToolInputs).toBe(false);
		expect(options.anthropic.anthropicBeta).toContain(
			"context-management-2025-06-27",
		);
	});

	it("pins read/edit/write so the agent keeps what it read and changed", () => {
		const options = contextManagementOptions("anthropic") as {
			anthropic: {
				contextManagement: { edits: Array<{ excludeTools?: string[] }> };
			};
		};
		expect(options.anthropic.contextManagement.edits[0]?.excludeTools).toEqual([
			"read",
			"edit",
			"write",
		]);
	});

	it("triggers far below the API default, because our transcripts never get that big", () => {
		const options = contextManagementOptions("anthropic") as {
			anthropic: {
				contextManagement: { edits: Array<{ trigger: { value: number } }> };
			};
		};
		// A measured run burned 383k input across 22 steps with no single request
		// above ~35k, so the 100k default would never have fired.
		expect(
			options.anthropic.contextManagement.edits[0]?.trigger.value,
		).toBeLessThan(100_000);
	});

	it("honours explicit overrides", () => {
		const options = contextManagementOptions("anthropic", {
			triggerTokens: 12_000,
			keepToolUses: 2,
			excludeTools: ["grep"],
		}) as {
			anthropic: {
				contextManagement: { edits: Array<Record<string, unknown>> };
			};
		};
		const edit = options.anthropic.contextManagement.edits[0]!;
		expect(edit.trigger).toEqual({ type: "input_tokens", value: 12_000 });
		expect(edit.keep).toEqual({ type: "tool_uses", value: 2 });
		expect(edit.excludeTools).toEqual(["grep"]);
	});

	it("sends nothing for providers that do not support it", () => {
		expect(contextManagementOptions("openai")).toBeUndefined();
		expect(contextManagementOptions(undefined)).toBeUndefined();
	});
});
