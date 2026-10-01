/**
 * Cognitive memory wiring for the CLI.
 *
 * Two things the default setup did not do, both of which made memory look
 * broken in practice:
 *
 * 1. **Extraction.** The harness fallback is a regex over the user message, so
 *    only "always/never/remember to" was ever learned — a plain project fact was
 *    silently dropped. This drives a small structured extraction from the same
 *    model that runs the turn.
 * 2. **Persistence.** Nothing ever called `onPersist`/`loadSnapshot`, so memory
 *    died with the process and could not carry anything into a later session.
 */
import { promises as fs } from "node:fs";
import { createHash } from "node:crypto";
import * as os from "node:os";
import * as nodePath from "node:path";
import { generateText, type LanguageModel } from "ai";
import { CognitiveMemory } from "@astracollab/not-another-harness";

import { extractDeterministic } from "./memory-rules.js";

export type TurnExtractor = (turn: {
  userMessage: string;
  assistantResponse: string;
}) => Promise<{
  memories: Array<{ content: string; domains?: string[] }>;
  tensions?: Array<{
    claimA: string;
    claimB: string;
    impact: "low" | "medium" | "critical";
    actionableQuestion: string;
  }>;
}>;

const EXTRACT_SCHEMA_HINT = `Reply with a single JSON object and nothing else:
{"memories":[{"content":"one self-contained durable statement","domains":["tag"]}],"tensions":[{"claimA":"...","claimB":"...","impact":"low|medium|critical","actionableQuestion":"..."}]}
Use {"memories":[],"tensions":[]} when there is nothing worth keeping. No prose, no code fences.`;

type Extracted = {
  memories: Array<{ content: string; domains?: string[] }>;
  tensions?: Array<{
    claimA: string;
    claimB: string;
    impact: "low" | "medium" | "critical";
    actionableQuestion: string;
  }>;
};

const IMPACTS = new Set(["low", "medium", "critical"]);

/**
 * Tolerant JSON recovery.
 *
 * Models wrap JSON in prose or code fences, prepend "Here is the JSON:", or
 * trail a sentence after it, so a bare `JSON.parse` on the response is not
 * dependable. Everything is filtered again downstream.
 */
export const parseExtraction = (text: string): Extracted => {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const candidate = fenced?.[1] ?? text;
  const start = candidate.indexOf("{");
  if (start < 0) return { memories: [] };
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < candidate.length; i += 1) {
    const ch = candidate[i]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        try {
          const parsed = JSON.parse(candidate.slice(start, i + 1)) as {
            memories?: unknown;
            tensions?: unknown;
          };
          const memories = Array.isArray(parsed.memories)
            ? (parsed.memories as Array<Record<string, unknown>>)
                .filter((m) => typeof m.content === "string")
                .map((m) => ({
                  content: m.content as string,
                  domains: Array.isArray(m.domains) ? (m.domains as string[]) : [],
                }))
            : [];
          const tensions = Array.isArray(parsed.tensions)
            ? parsed.tensions
                .filter((t): t is Record<string, unknown> => Boolean(t) && typeof t === "object")
                .filter((t) => typeof t.claimA === "string" && typeof t.claimB === "string")
                .map((t) => ({
                  claimA: t.claimA as string,
                  claimB: t.claimB as string,
                  impact: (IMPACTS.has(t.impact as string)
                    ? t.impact
                    : "low") as "low" | "medium" | "critical",
                  actionableQuestion: String(t.actionableQuestion ?? "Clarify before acting."),
                }))
            : [];
          return { memories, tensions };
        } catch {
          return { memories: [] };
        }
      }
    }
  }
  return { memories: [] };
};

const EXTRACT_INSTRUCTION = `You maintain durable memory for a coding agent.

The <user> block is the authoritative source. Record what the USER asserted or
required, even if the assistant hedged, refused to verify, or disagreed — the
user's statement is the signal, not the assistant's confidence. A turn where the
assistant said "I can't confirm that" but the user stated a concrete value still
contains a durable fact.

Extract only what will still be true and useful in a LATER session:
- project facts (URLs, paths, ports, deployment names, service names, versions)
- user preferences and conventions (naming, style, tooling choices)
- constraints the user stated (never do X, always do Y)

Rules:
- One self-contained sentence per memory. No pronouns that depend on this conversation.
- Skip anything already obvious from the repo, anything one-off to this task, and
  anything the assistant merely guessed.
- Prefer recording the user's concrete assertions (URLs, ids, paths, names,
  conventions). Do not withhold a fact just because the assistant was unsure.
- If nothing is worth keeping, return an empty memories array.
- Report a tension only when two statements genuinely contradict.`;

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}…` : text);

/**
 * Build a model-backed extractor.
 *
 * Deliberately `generateText` + JSON recovery rather than `generateObject`:
 * `generateObject` needs a provider that can emit structured output, and
 * several OpenRouter models (reasoning/stealth routes especially) throw
 * `AI_NoObjectGeneratedError`. Text + recovery works with any model.
 */
export const createTurnExtractor = (model: LanguageModel): TurnExtractor => {
  return async ({ userMessage, assistantResponse }) => {
    const result = await generateText({
      model,
      system: `${EXTRACT_INSTRUCTION}\n\n${EXTRACT_SCHEMA_HINT}`,
      prompt: [
        "<user>",
        clip(userMessage, 2000),
        "</user>",
        "<assistant>",
        clip(assistantResponse, 2000),
        "</assistant>",
      ].join("\n"),
      // Extraction is a background concern; never let it stall a turn.
      maxOutputTokens: 600,
    });
    const parsed = parseExtraction(result.text);
    return {
      memories: parsed.memories
        .filter((m) => m.content.trim().length >= 8 && m.content.trim().length <= 600)
        .map((m) => ({ content: m.content.trim(), domains: m.domains ?? [] })),
      tensions: parsed.tensions ?? [],
    };
  };
};

/** Where memory for a given working directory is stored. */
export const memoryFileFor = (cwd: string): string =>
  nodePath.join(
    os.homedir(),
    ".nah",
    "memory",
    `${createHash("sha1").update(nodePath.resolve(cwd)).digest("hex").slice(0, 12)}.json`,
  );

/** Invoked after each successful persist; used by the live eval to await background work. */
let onPersisted: (() => void) | null = null;
export const setMemoryPersistedHook = (fn: (() => void) | null): void => {
  onPersisted = fn;
};

export type MemoryOptions = {
  /** Omit to build a memory that only uses the built-in regex extraction. */
  extractor?: TurnExtractor | null;
  cwd: string;
  /** Set false to skip loading and saving (e.g. --no-session). */
  persist?: boolean;
};

export type PreparedMemory = {
  memory: CognitiveMemory;
  path: string;
  /** True when a previous session's memory was restored. */
  restored: boolean;
};

/**
 * Build the CLI's CognitiveMemory: model-backed extraction, on-disk persistence,
 * and any state left by a previous run in this directory.
 */
export const prepareMemory = async (options: MemoryOptions): Promise<PreparedMemory> => {
  const path = memoryFileFor(options.cwd);
  const persist = options.persist !== false;

  const debug = process.env.NAH_MEMORY_DEBUG === "1";
  const extract = options.extractor
    ? async (turn: { userMessage: string; assistantResponse: string }) => {
        // A question is a lookup, not a lesson. Extracting from recall turns
        // stored the assistant's own answers back as memories, which duplicated
        // facts and evicted the real ones.
        const isQuestion = turn.userMessage.includes("?");
        if (isQuestion) {
          if (debug) console.log("  [memory] extract skipped (user asked a question)");
          return { memories: [] };
        }

        // Deterministic first, so a plainly-stated fact is captured even if the
        // model refuses, hedges, or returns nothing.
        const rules = extractDeterministic(turn.userMessage);
        if (debug) {
          console.log(`  [memory] rules -> ${rules.length} memories`);
          for (const m of rules) console.log(`             - ${m.content.slice(0, 80)}`);
        }

        try {
          const result = await options.extractor!(turn);
          if (debug) {
            console.log(
              `  [memory] model -> ${result.memories.length} memories, ${result.tensions?.length ?? 0} tensions`,
            );
            for (const m of result.memories) console.log(`             - ${m.content.slice(0, 80)}`);
          }
          return { memories: [...rules, ...result.memories], tensions: result.tensions };
        } catch (error) {
          if (debug) console.log(`  [memory] model extract THREW: ${String(error).slice(0, 160)}`);
          return { memories: rules };
        }
      }
    : undefined;

  const memory = new CognitiveMemory({
    ...(extract ? { extract } : {}),
    ...(persist
      ? {
          onPersist: async (snapshot) => {
            await fs.mkdir(nodePath.dirname(path), { recursive: true });
            await fs.writeFile(path, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
            // Persisting is the last step of postTurnAsync, so it doubles as the
            // signal that a turn's background work has finished.
            if (process.env.NAH_MEMORY_DEBUG) {
              console.log(`  [memory] persisted after turn: l1=${snapshot.l1.length} l2=${snapshot.l2.length}`);
            }
            onPersisted?.();
          },
        }
      : {}),
  });

  let restored = false;
  if (persist) {
    try {
      const raw = await fs.readFile(path, "utf8");
      memory.loadSnapshot(JSON.parse(raw) as Parameters<CognitiveMemory["loadSnapshot"]>[0]);
      restored = memory.getSnapshot().l1.length + memory.getSnapshot().l2.length > 0;
    } catch {
      // No prior memory for this directory.
    }
  }

  return { memory, path, restored };
};
