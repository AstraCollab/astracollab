/**
 * Does the prompt cache hold as a conversation grows?
 *
 * The static probe proves caching works once. It says nothing about a 27-step
 * agent turn, where the prefix grows every step. Two things can break it:
 *
 *  - Anthropic's lookback is a fixed 20 blocks. If a breakpoint ends up more than
 *    20 positions past the last write, it silently finds nothing.
 *  - Anything that changes the prefix - tool definitions, steering - invalidates
 *    the tools and system caches, and with them everything after.
 *
 * Sends N growing turns with the breakpoint pinned the way `withCachedTail` pins
 * it, and prints the cached fraction per turn. That is the number that decides
 * whether replaying the transcript is cheap or expensive.
 */
import { streamText, tool } from "ai";
import { z } from "zod";
import { cacheOptions, supportsCaching } from "not-another-harness";

import { resolveModel } from "../src/model.js";

const FILLER = `You are a cache growth probe. Reply with the single word: ok.
${Array.from({ length: 200 }, (_, i) => `ref ${i}: the quick brown fox jumps over the lazy dog.`).join("\n")}`;

const main = async (): Promise<number> => {
  const turns = Number(process.argv[3] ?? 30);
  const model = await resolveModel(process.argv[2]);
  if (!supportsCaching(model.provider)) {
    process.stdout.write(`provider ${model.provider} is not marked cache-capable; nothing to measure.\n`);
    return 2;
  }

  const tools = {
    noop: tool({ description: "Never called.", inputSchema: z.object({}), execute: async () => "noop" }),
  };
  const messages: Array<{ role: "user" | "assistant"; content: unknown }> = [
    { role: "user", content: "Reply with the single word: ok." },
  ];
  // Pinned the way withCachedTail does: one step behind the live tail.
  let stableThrough = 0;
  let misses = 0;

  process.stdout.write("turn   fresh   cached   hit%\n");
  for (let turn = 1; turn <= turns; turn += 1) {
    const marked = messages.map((m, i) =>
      i === Math.min(stableThrough, messages.length - 1)
        ? {
            ...m,
            providerOptions: {
              ...((m as { providerOptions?: Record<string, unknown> }).providerOptions ?? {}),
              anthropic: {
                cacheControl: cacheOptions(model.provider, "1h").anthropic!.cacheControl,
              },
            },
          }
        : m,
    ) as never;

    const result = await streamText({
      model: model.model,
      system: FILLER,
      messages: marked,
      tools,
    });
    for await (const _ of result.textStream) {
      // Drain.
    }
    const usage = (await result.usage) as { inputTokens?: number; cachedInputTokens?: number };
    const fresh = usage.inputTokens ?? 0;
    const cached = usage.cachedInputTokens ?? 0;
    const hit = cached / Math.max(1, fresh);
    if (turn > 1 && cached === 0) misses += 1;
    process.stdout.write(
      `${String(turn).padStart(4)} ${String(fresh).padStart(7)} ${String(cached).padStart(8)} ${(hit * 100).toFixed(0).padStart(5)}\n`,
    );

    // Each turn adds a real tool round, as an agent does: an assistant turn
    // issuing the call, then the result. A result without its call is rejected
    // by the SDK before the request is built, which is what the first attempt
    // hit.
    messages.push({
      role: "assistant",
      content: [{ type: "tool-call", toolCallId: `t${turn}`, toolName: "noop", input: "{}" }],
    } as never);
    messages.push({
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: `t${turn}`,
          toolName: "noop",
          output: { type: "text", value: `result ${turn} `.repeat(40) },
        },
      ],
    } as never);
    stableThrough = messages.length;
  }

  process.stdout.write(`\nturns with a cold cache after the first: ${misses}/${turns - 1}\n`);
  return misses > 2 ? 1 : 0;
};

process.exitCode = await main();
