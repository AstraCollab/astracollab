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
import { tool, type Tool } from "ai";
import { z } from "zod";
import type { SessionMemory } from "./memory-backend.js";

export const createRecallTool = (getMemory: () => SessionMemory | undefined): Tool =>
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

      // The adapters absorb their own failures, so this is [] rather than a
      // thrown error: a backend that is down must not look like a tool the model
      // misused. The empty answer below tells it what to say instead of guessing.
      const results = await memory.search(query, limit ?? 6);
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

/**
 * The `remember` tool.
 *
 * `recall` made memory readable and left it unwritable, which is a trap with a
 * specific shape: the agent can be told a fact has changed, agree, and have no
 * way to act on it — so it says it has updated its memory, which is exactly the
 * claim it cannot make true. This is the other half, and it is deliberately
 * conservative about what goes in.
 *
 * Two rules shape the schema. A correction names what it replaces, because
 * storing the right answer next to the wrong one leaves both to be recalled and
 * the stale one is the one that reads as authoritative. And the result reports
 * what the backend did, not what was asked for, because a tool that answers
 * "saved" to a backend that stored nothing is worse than no tool at all.
 */
export const createRememberTool = (getMemory: () => SessionMemory | undefined): Tool =>
  tool({
    description:
      "Record a durable fact about this project in memory, and retire one that is now wrong. " +
      "Use it when the user states something meant to hold from now on (where something is " +
      "deployed, a path, a convention, a host, a constraint) or corrects something you were " +
      "told before — pass the id of what it replaces in `replaces`, so the old one is retired " +
      "rather than left sitting beside it. Do not save what only matters to this turn, and do " +
      "not save what you can read in the repository instead.",
    inputSchema: z.object({
      content: z
        .string()
        .min(3)
        .describe(
          "The fact as one sentence, in the user's terms rather than yours — \"we deploy on netlify\" " +
            "beats \"deployment target updated\". Include the specific value; a fact too vague to act on " +
            "will be recalled and found useless.",
        ),
      domains: z
        .array(z.string())
        .max(5)
        .optional()
        .describe("Short lowercase tags for grouping, e.g. [\"deployment\"], [\"naming\"]"),
      tier: z
        .enum(["L1", "L2", "L3"])
        .optional()
        .describe("L1 (default) is pre-staged into every turn; L2 is recalled on demand; L3 is the archive"),
      replaces: z
        .array(z.string())
        .max(10)
        .optional()
        .describe(
          "Ids of memories this corrects, as reported by the recall tool. Use it when the user " +
            "changes an earlier fact, or when a fact you were told turns out to be wrong.",
        ),
    }),
    execute: async ({ content, domains, tier, replaces }) => {
      const memory = getMemory();
      if (!memory) return "No memory is available in this session.";

      const lines: string[] = [];

      // Retiring first: if this write is refused, the stale fact is still gone
      // and the user is left with neither, which they can see and fix. The other
      // order leaves the wrong answer in place behind a claim it was corrected.
      const gone: string[] = [];
      const notHeld: string[] = [];
      for (const id of replaces ?? []) {
        if (await memory.forget(id)) gone.push(id);
        else notHeld.push(id);
      }
      if (gone.length > 0) lines.push(`Retired ${gone.length} memory id(s): ${gone.join(", ")}`);
      if (notHeld.length > 0) {
        lines.push(`Not held, nothing to retire: ${notHeld.join(", ")} — already gone, or from another backend.`);
      }

      const result = await memory.remember({
        content,
        ...(domains === undefined ? {} : { domains }),
        ...(tier === undefined ? {} : { tier }),
      });

      if (result.merged) {
        lines.push(`Already remembered, not stored twice: ${content}`);
        return lines.join("\n");
      }
      if (result.stored.length === 0) {
        // The backend absorbed its own failure, so this is the only place the
        // user learns a stated fact was dropped. Say it rather than let the
        // conversation continue on the assumption it was kept.
        const why = memory.degraded ? ` (${memory.degraded})` : "";
        lines.push(`NOT stored${why}. Tell the user plainly that it was not remembered — /memory shows the backend.`);
        return lines.join("\n");
      }

      lines.push(`Stored as ${result.stored.join(", ")}: ${content}`);
      return lines.join("\n");
    },
  });
