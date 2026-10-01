import { describe, expect, it } from "vitest";
import { MockLanguageModelV2 } from "ai/test";
import { simulateReadableStream } from "ai";
import type { LanguageModelV2StreamPart } from "@ai-sdk/provider";

import {
  cacheOptions,
  contextManagementOptions,
  supportsCaching,
  withCachedToolSchemas,
} from "../src/cache.js";
import { runAgent } from "../src/agent.js";

const USAGE = { inputTokens: 10, outputTokens: 2, totalTokens: 12 };

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
  it("marks every tool definition", () => {
    const tools = withCachedToolSchemas({ a: { description: "x" }, b: { description: "y" } }, "anthropic");
    for (const tool of Object.values(tools)) {
      expect((tool as { providerOptions?: { anthropic?: { cacheControl?: unknown } } }).providerOptions?.anthropic?.cacheControl)
        .toEqual({ type: "ephemeral", ttl: "5m" });
    }
  });

  it("leaves tools untouched for providers that ignore breakpoints", () => {
    const tools = { a: { description: "x" } };
    expect(withCachedToolSchemas(tools, "openai")).toBe(tools);
  });

  it("preserves other provider options on a tool", () => {
    const tools = {
      a: { description: "x", providerOptions: { openai: { parallelToolCalls: false } } },
    };
    const out = withCachedToolSchemas(tools, "anthropic") as Record<
      string,
      { providerOptions: Record<string, Record<string, unknown>> }
    >;
    expect(out.a!.providerOptions.openai).toEqual({ parallelToolCalls: false });
    expect(out.a!.providerOptions.anthropic).toBeDefined();
  });

  it("passes non-object tools through unchanged", () => {
    expect(withCachedToolSchemas({ a: undefined }, "anthropic").a).toBeUndefined();
  });
});

describe("caching reaches the model call", () => {
  const capture = async (cacheProvider: string | undefined) => {
    const seen: Array<Record<string, unknown>> = [];
    let call = 0;
    const model = new MockLanguageModelV2({
      doStream: async (options: Record<string, unknown>) => {
        seen.push(options);
        const done = call++ > 0;
        const chunks: LanguageModelV2StreamPart[] = [];
        if (!done) {
          chunks.push({ type: "tool-call", toolCallId: "c", toolName: "probe", input: "{}" });
        } else {
          chunks.push(
            { type: "text-start", id: "t" },
            { type: "text-delta", id: "t", delta: "ok" },
            { type: "text-end", id: "t" },
          );
        }
        chunks.push({ type: "finish", finishReason: done ? "stop" : "tool-calls", usage: USAGE });
        return { stream: simulateReadableStream({ chunkDelayInMs: 0, chunks }) };
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
    const anthropic = (seen[0]!.providerOptions as { anthropic: Record<string, unknown> }).anthropic;
    // Context editing rides in the same provider block as the cache breakpoint.
    const edits = (anthropic.contextManagement as { edits: Array<{ type: string }> }).edits;
    expect(edits[0]!.type).toBe("clear_tool_uses_20250919");
  });

  it("sends none for a provider that would ignore them", async () => {
    const seen = await capture("openai");
    expect(seen[0]!.providerOptions).toBeUndefined();
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
    expect(options.anthropic.anthropicBeta).toContain("context-management-2025-06-27");
  });

  it("pins read/edit/write so the agent keeps what it read and changed", () => {
    const options = contextManagementOptions("anthropic") as {
      anthropic: { contextManagement: { edits: Array<{ excludeTools?: string[] }> } };
    };
    expect(options.anthropic.contextManagement.edits[0]!.excludeTools).toEqual([
      "read",
      "edit",
      "write",
    ]);
  });

  it("triggers far below the API default, because our transcripts never get that big", () => {
    const options = contextManagementOptions("anthropic") as {
      anthropic: { contextManagement: { edits: Array<{ trigger: { value: number } }> } };
    };
    // A measured run burned 383k input across 22 steps with no single request
    // above ~35k, so the 100k default would never have fired.
    expect(options.anthropic.contextManagement.edits[0]!.trigger.value).toBeLessThan(100_000);
  });

  it("honours explicit overrides", () => {
    const options = contextManagementOptions("anthropic", {
      triggerTokens: 12_000,
      keepToolUses: 2,
      excludeTools: ["grep"],
    }) as { anthropic: { contextManagement: { edits: Array<Record<string, unknown>> } } };
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
