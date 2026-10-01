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
import type { MemoryReconciliation } from "@astracollab/not-another-harness";

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
 * Slice the first balanced `{...}` (or `[...]`) out of a model response.
 *
 * A response cannot go straight to `JSON.parse`: models wrap JSON in prose,
 * prepend "Here you go:", or add a closing sentence. Brace counting has to
 * respect string boundaries, or a `}` inside a remembered statement truncates
 * the object and the whole reply is lost.
 */
const sliceBalancedJson = (text: string, opener: "{" | "["): string | null => {
  const start = text.indexOf(opener);
  if (start < 0) return null;
  const close = opener === "{" ? "}" : "]";
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === opener) depth += 1;
    else if (ch === close) {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
};

/**
 * Tolerant JSON recovery.
 *
 * Models wrap JSON in prose or code fences, prepend "Here is the JSON:", or
 * trail a sentence after it, so a bare `JSON.parse` on the response is not
 * dependable. Everything is filtered again downstream.
 */
export const parseExtraction = (text: string): Extracted => {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const slice = sliceBalancedJson(fenced?.[1] ?? text, "{");
  if (!slice) return { memories: [] };
  try {
    const parsed = JSON.parse(slice) as { memories?: unknown; tensions?: unknown };
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
            impact: (IMPACTS.has(t.impact as string) ? t.impact : "low") as
              | "low"
              | "medium"
              | "critical",
            actionableQuestion: String(t.actionableQuestion ?? "Clarify before acting."),
          }))
      : [];
    return { memories, tensions };
  } catch {
    return { memories: [] };
  }
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

const RECONCILE_SCHEMA_HINT = `Reply with a single JSON object and nothing else:
{"verdicts":[{"index":0,"action":"add|merge|replace|reject","content":"the fuller statement, only for merge or replace","reason":"short why"}]}
One verdict per numbered candidate, same order as the list. No prose, no code fences.`;

const ACTIONS = new Set(["add", "merge", "replace", "reject"]);

/**
 * Tolerant verdict recovery, mirroring `parseExtraction`.
 *
 * Three shapes are accepted because models produce all three:
 *   {"verdicts":[...]}  as asked for
 *   [...]               a bare array, dropping the wrapper
 *   {"index":0,...}     a single verdict answered on its own
 *
 * A missing, out-of-range or unrecognised verdict leaves that candidate as
 * "add". Under-merging costs a duplicate entry; a wrong merge loses information
 * permanently, so anything unparsed defaults to keeping both.
 */
export const parseReconciliation = (
  text: string,
  itemCount: number,
): MemoryReconciliation[] => {
  const addAll = Array.from({ length: itemCount }, () => ({ action: "add" as const }));
  if (itemCount === 0) return addAll;

  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const body = fenced?.[1] ?? text;

  const verdicts = ((): unknown[] | null => {
    for (const opener of ["{", "["] as const) {
      const slice = sliceBalancedJson(body, opener);
      if (!slice) continue;
      try {
        const parsed = JSON.parse(slice) as unknown;
        if (Array.isArray(parsed)) return parsed;
        if (parsed && typeof parsed === "object") {
          const wrapped = (parsed as { verdicts?: unknown }).verdicts;
          if (Array.isArray(wrapped)) return wrapped;
          if (typeof (parsed as { action?: unknown }).action === "string") return [parsed];
        }
      } catch {
        // Not this shape. Try the next one rather than giving up.
      }
    }
    return null;
  })();
  if (!verdicts) return addAll;

  const usable = verdicts
    .filter((v): v is Record<string, unknown> => Boolean(v) && typeof v === "object")
    .filter((v) => ACTIONS.has(v.action as string));

  const out: MemoryReconciliation[] = addAll.map((v) => ({ ...v }));
  usable.forEach((verdict, position) => {
    // `index` is what the prompt asks for, but models often omit it and rely on
    // order instead, so fall back to the verdict's own position.
    const hint = verdict.index;
    const index =
      typeof hint === "number" && Number.isInteger(hint)
        ? hint
        : typeof hint === "string" && /^\d+$/.test(hint.trim())
          ? Number(hint.trim())
          : position;
    if (index < 0 || index >= itemCount) return;
    out[index] = {
      action: verdict.action as MemoryReconciliation["action"],
      ...(typeof verdict.content === "string" && verdict.content.trim()
        ? { content: verdict.content.trim() }
        : {}),
      ...(typeof verdict.reason === "string" && verdict.reason.trim()
        ? { reason: verdict.reason.trim() }
        : {}),
    };
  });
  return out;
};

const RECONCILE_INSTRUCTION = `You maintain durable memory for a coding agent. A new candidate statement may restate something already remembered, add detail to it, or contradict it.

Decide:
- "merge" - it says the same thing as something you already hold. Merge them into ONE memory, keeping whichever carries more information. Do not keep both.
- "replace" - it updates or contradicts what you hold about the same subject (for example a changed value, a superseded preference). The newer statement wins.
- "add" - it is genuinely new.
- "reject" - it is not worth remembering at all.

Rules:
- A merged statement must contain every detail from BOTH sides. Never drop an
  id, port, qualifier or condition while merging - if the result would say less
  than one of the two, report "add" instead and keep them apart.
- A restatement is never a second memory. "Likes cheese pizza" and "Loves cheese pizza" are one.
- Do not merge when numbers, dates, names or qualifiers differ; that is "replace", not "merge".
- Prefer "add" when you are unsure. A duplicate costs one entry; a wrong merge loses information permanently.
- Never invent information that is in neither the candidate nor the memories you were given.`;

/**
 * Model-backed adjudicator: mem0's ADD/MERGE/REPLACE/REJECT over recalled
 * candidates, for every candidate in the turn in a single call.
 */
export const createMemoryReconciler = (model: LanguageModel) => {
  return async ({
    items,
  }: {
    items: Array<{ candidate: string; remember: string[] }>;
  }): Promise<MemoryReconciliation[]> => {
    const addAll = items.map(() => ({ action: "add" as const }));
    if (items.length === 0) return addAll;
    try {
      // `generateText` + JSON recovery, not `generateObject`. The previous
      // version called `generateObject` here while the extractor 70 lines above
      // documented exactly why not to: models without structured output throw
      // `AI_NoObjectGeneratedError`, and the catch below turned that into
      // "add" for every candidate. Deduplication was silently inert on those
      // models — a no-op that looked like it was working.
      const result = await generateText({
        model,
        system: `${RECONCILE_INSTRUCTION}\n\n${RECONCILE_SCHEMA_HINT}`,
        prompt: items
          .map(
            ({ candidate, remember }, index) =>
              `${index}. NEW: ${candidate}\n${remember.map((m) => `   remembered: ${m}`).join("\n")}`,
          )
          .join("\n\n"),
        // Adjudication is a background concern; never let it stall a turn.
        maxOutputTokens: 600,
      });
      return parseReconciliation(result.text, items.length);
    } catch {
      return addAll;
    }
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
  /** Adjudicates near-duplicate memories. Omit to fall back to exact-match only. */
  reconciler?: ((input: {
    items: Array<{ candidate: string; remember: string[] }>;
  }) => Promise<MemoryReconciliation[]>) | null;
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
