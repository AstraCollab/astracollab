/**
 * The `recall` tool.
 *
 * Pre-staging memories into the system prompt is a best-effort optimisation: a
 * model may not read the block, and a question that shares no words with a
 * memory will not have it staged at all. This gives the agent an explicit,
 * deterministic way to ask for what it remembers — ranking happens in
 * `CognitiveMemory.search`, with no model in the loop, so recall does not
 * degrade when the model is weak.
 */
import { tool } from "ai";
import { z } from "zod";
import type { CognitiveMemory } from "@astracollab/not-another-harness";

export const createRecallTool = (getMemory: () => CognitiveMemory | undefined) =>
  tool({
    description:
      "Search your memory of this project for earlier facts, preferences and conventions. " +
      "Use it when the user refers to something established earlier (a URL, id, host, path, " +
      "naming rule, or constraint) and it is not in the current conversation, or when you are " +
      "about to contradict something you were told before. It searches what you were actually " +
      "told — it does not guess.",
    inputSchema: z.object({
      query: z
        .string()
        .min(2)
        .describe("What to look for, in your own words, e.g. \"staging build id\" or \"file naming\""),
      limit: z.number().int().min(1).max(20).optional().describe("Max results (default 6)"),
    }),
    execute: async ({ query, limit }) => {
      const memory = getMemory();
      if (!memory) return "No memory is available in this session.";

      const results = memory.search(query, limit ?? 6);
      if (results.length === 0) {
        return `No stored memory matches "${query}". If you were not told, say so rather than guessing.`;
      }

      const lines = results.map(({ item, score }) => {
        const domains = item.metadata.domains.slice(0, 3);
        const tag = domains.length > 0 ? ` (${domains.join(", ")})` : "";
        return `- ${item.content}${tag} [${item.tier}, relevance ${score.toFixed(2)}]`;
      });
      return `Remembered (${results.length} match${results.length === 1 ? "" : "es"}):\n${lines.join("\n")}`;
    },
  });
