/**
 * Does rewriting old tool results break the prompt cache?
 *
 * A run reported 2% cached. The suspected cause is client-side pruning: eliding
 * a tool result changes bytes that sit *before* the cache breakpoint, so the
 * prefix hash no longer matches what the previous request wrote. That would
 * trade a 0.1x discount for a marginally smaller prompt - a bad deal whenever
 * the prefix is above the minimum cacheable length, which 8k is.
 *
 * Sends a growing conversation twice: once with the tail left alone, once with
 * an old tool result rewritten each turn the way a pruner would.
 */
import { streamText, tool } from "ai";
import { z } from "zod";
import { cacheOptions, supportsCaching } from "@astracollab/not-another-harness";

import { resolveModel } from "../src/model.js";

const FILLER = `cache probe. Reply with the single word: ok.
${Array.from({ length: 150 }, (_, i) => `ref ${i}: the quick brown fox jumps over the lazy dog.`).join("\n")}`;

const main = async (): Promise<number> => {
  const model = await resolveModel(process.argv[2]);
  if (!supportsCaching(model.provider)) return 2;
  const tools = { noop: tool({ description: "n", inputSchema: z.object({}), execute: async () => "noop" }) };
  const rounds = Number(process.argv[3] ?? 8);

  for (const rewrite of [false, true]) {
    const messages: Array<Record<string, unknown>> = [
      { role: "user", content: [{ type: "text", text: "Reply with the single word: ok." }] },
    ];
    let stableThrough = 0;
    const hits: number[] = [];
    for (let turn = 1; turn <= rounds; turn += 1) {
      // A pruner elides the OLDEST tool result once it falls out of the window,
      // which rewrites bytes behind the breakpoint.
      if (rewrite && messages.length > 6) {
        const idx = messages.findIndex((m) => JSON.stringify(m).includes("tool-result"));
        if (idx >= 0) {
          messages[idx] = {
            role: "tool",
            content: [{ type: "tool-result", toolCallId: "c0", toolName: "noop", output: { type: "text", value: "[output elided]" } }],
          };
        }
      }
      const marked = messages.map((m, i) =>
        i === Math.min(stableThrough, messages.length - 1)
          ? { ...m, providerOptions: { anthropic: { cacheControl: cacheOptions(model.provider, "1h").anthropic!.cacheControl } } }
          : m,
      );
      const result = await streamText({ model: model.model, system: FILLER, messages: marked as never, tools });
      for await (const _ of result.textStream) { /* drain */ }
      const usage = (await result.usage) as { inputTokens?: number; cachedInputTokens?: number };
      hits.push(usage.cachedInputTokens ?? 0);
      messages.push({ role: "assistant", content: [{ type: "tool-call", toolCallId: `t${turn}`, toolName: "noop", input: "{}" }] } as never);
      messages.push({ role: "tool", content: [{ type: "tool-result", toolCallId: `t${turn}`, toolName: "noop", output: { type: "text", value: `result ${turn} `.repeat(60) } }] } as never);
      stableThrough = messages.length;
    }
    const later = hits.slice(2);
    const avg = later.length ? Math.round(later.reduce((a, b) => a + b, 0) / later.length) : 0;
    process.stdout.write(`${rewrite ? "rewriting old results (pruner on) " : "prefix left stable             "} avg cached after turn 2: ${avg}\n`);
  }
  return 0;
};

process.exitCode = await main();
