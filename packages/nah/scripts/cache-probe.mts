/**
 * Did the prompt cache actually read?
 *
 * Not a question the transcript can answer: `cache_read_input_tokens` is reported
 * by the provider per request, and nothing persisted it, so "our caching might
 * not be working" was a standing unknown. It matters more than usual here,
 * because a 1-hour cache *write* costs 2x the base input price - a prefix written
 * every step and never read is not a miss, it is a doubling of the bill.
 *
 * Sends the same request three times: twice with an identical cache-marked
 * prefix, then once unmarked as a control. The second call is the one that can
 * read, so the three together separate "cache failing" from "provider does not
 * report cache fields at all".
 *
 *   npx tsx scripts/cache-probe.mts [provider:modelId]
 *
 * With no argument it resolves the model the same way the CLI does, so it needs
 * no configuration beyond whatever /provider already stored.
 */
import { streamText, tool } from "ai";
import { z } from "zod";
import { cacheAccountingFor, cacheOptions, supportsCaching } from "@astracollab/not-another-harness";

import { resolveModel } from "../src/model.js";

/**
 * Comfortably over every documented minimum cacheable prefix (512-4096 tokens by
 * model), so a miss cannot be explained by falling short of the threshold.
 */
const FILLER = `You are a cache probe. Reply with the single word: ok.
Reference material, repeated so the prefix clears any minimum cacheable length:
${Array.from({ length: 220 }, (_, i) => `line ${i}: the quick brown fox jumps over the lazy dog; pack my box with five dozen liquor jugs.`).join("\n")}`;

type Reading = { input: number; cached: number; total: number };

const probe = async (model: Awaited<ReturnType<typeof resolveModel>>, provider: string, marked: boolean): Promise<Reading> => {
  const result = await streamText({
    model: model.model,
    system: FILLER,
    prompt: "Reply with the single word: ok.",
    tools: { noop: tool({ description: "Never called.", inputSchema: z.object({}), execute: async () => "noop" }) },
    ...(marked && supportsCaching(provider) ? { providerOptions: cacheOptions(provider, "1h") } : {}),
  });
  for await (const _ of result.textStream) {
    // Drain, so usage settles.
  }
  const usage = (await result.usage) as { inputTokens?: number; cachedInputTokens?: number; totalTokens?: number };
  return { input: usage.inputTokens ?? 0, cached: usage.cachedInputTokens ?? 0, total: usage.totalTokens ?? 0 };
};

const row = (label: string, u: Reading) =>
  `${label.padEnd(11)} input ${String(u.input).padStart(8)}  cached ${String(u.cached).padStart(8)}  total ${String(u.total).padStart(8)}`;

const main = async (): Promise<number> => {
  const model = await resolveModel(process.argv[2]);
  const first = await probe(model, model.provider, true);
  const second = await probe(model, model.provider, true);
  const control = await probe(model, model.provider, false);

  process.stdout.write(`provider ${model.provider}  model ${model.modelId}\n`);
  process.stdout.write(`accounting: ${cacheAccountingFor(model.provider)}  (openrouter folds cached into prompt_tokens)\n`);
  process.stdout.write(`caching honoured for provider: ${supportsCaching(model.provider)}\n\n`);
  process.stdout.write(`${row("1st (write)", first)}\n`);
  process.stdout.write(`${row("2nd (read?)", second)}\n`);
  process.stdout.write(`${row("no cache", control)}\n\n`);

  if (second.cached > 0) {
    const share = second.cached / Math.max(1, second.cached + second.input);
    process.stdout.write(`CACHE IS LIVE: ${second.cached} tokens read (~${Math.round(share * 100)}% of the prefix).\n`);
    process.stdout.write(`At 0.1x read pricing, steps after the first cost about ${(share * 0.9).toFixed(2)}x less than uncached.\n`);
    return 0;
  }

  process.stdout.write("CACHE DID NOT ENGAGE: cachedInputTokens is 0.\n");
  if (control.cached > 0 || control.input === 0) {
    process.stdout.write("The unmarked control behaves oddly, so this may be a reporting gap rather than a failed cache.\n");
  } else {
    process.stdout.write("The unmarked control reports the same shape, so the provider is not surfacing cache fields here.\n");
    process.stdout.write("Compare against the OpenRouter dashboard for the same model before concluding caching is broken.\n");
  }
  return 1;
};

process.exitCode = await main();
