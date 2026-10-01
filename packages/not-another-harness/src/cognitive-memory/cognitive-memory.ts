import type {
  ArbiterEvaluationResult,
  MemoryInclusionReason,
  MemoryInjectionEntry,
  MemoryInjectionReport,
  MemoryReconciliation,
  ArbiterFn,
  CognitiveMemoryOptions,
  CognitiveMemoryStateSnapshot,
  KnowledgeTension,
  MemoryItem,
  MemoryTier,
  ProprioceptiveSelfModel,
} from "./types.js";
import { runFastGate } from "./fast-gate.js";

/**
 * CognitiveMemory
 *
 * An intelligent 4-tier cache layer (L0-L3) with:
 * - Anticipatory pre-staging (predicts next turn's needs)
 * - Tension tracking (pinned contradictions in L0)
 * - Proprioceptive self-model (guards weak domains)
 * - Zero added TTFT latency (runs asynchronously post-turn)
 */
/**
 * Relevance scoring, shared by automatic promotion and on-demand `search()`.
 *
 * It used to be a single domain string compared with `turn.includes(domain)`,
 * which almost never matched: a memory tagged "naming-conventions" cannot match
 * a question that says "naming". Overlap over content words works because the
 * memory text and the question share the words that identify the fact.
 */
const STOP_WORDS = new Set([
  "the", "and", "for", "this", "that", "with", "from", "you", "are", "was", "has", "have",
  "what", "which", "when", "were", "will", "your", "our", "its", "not", "but", "all", "any",
  "can", "did", "does", "how", "into", "out", "use", "used", "using", "one", "two", "get",
  "new", "now", "then", "than", "them", "they", "his", "her", "she", "him", "been", "being",
  "there", "here", "also", "just", "like", "make", "made", "need", "want", "about", "after",
  "tell", "know", "give", "show", "please", "would", "could", "should", "will", "shall",
]);

export const relevanceTokens = (value: string): Set<string> =>
  new Set(
    value
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((word) => word.length >= 3 && !STOP_WORDS.has(word)),
  );

/** Jaccard-style overlap of two token sets, normalised by the smaller side. */
export const overlapScore = (query: Set<string>, candidate: Set<string>): number => {
  if (query.size === 0 || candidate.size === 0) return 0;
  let shared = 0;
  for (const word of query) if (candidate.has(word)) shared += 1;
  return shared / Math.min(query.size, candidate.size);
};

/** Minimum overlap before a warm memory is worth pre-staging. */
const PROMOTE_THRESHOLD = 0.12;

/** L1 only starts evicting past this size. */
const DEMOTE_ABOVE = 5;

/**
 * Floor for *candidate* recall, not a similarity decision.
 *
 * Deliberately low. Lexical overlap peaks on identical strings and bottoms out
 * on the paraphrases that actually add information, so a tight gate misses
 * exactly the pairs worth merging. This only decides who gets adjudicated.
 */
const CANDIDATE_FLOOR = 0.3;

/**
 * Tokens that carry a fact's identity: identifiers, numbers, codes.
 *
 * Function words and generic nouns ("file", "name", "project") are dropped
 * because they recur in every restatement and hide real differences.
 */
const distinctiveTokens = (value: string): Set<string> =>
  new Set(
    value
      .toLowerCase()
      .replace(/['']/g, "")
      .split(/[^a-z0-9]+/)
      .filter(Boolean)
      .filter((w) => /\d/.test(w) || w.length >= 4)
      .filter((w) => !FILLER_TOKENS.has(w)),
  );

/**
 * Whether rewriting `original` as `replacement` would drop information.
 *
 * Distinctive tokens are the ones that carry a fact's identity, so a
 * replacement missing one has deleted something - usually the qualifier that
 * made the two statements differ at all ("never production", a build id, a
 * port). Trailing plurals are folded so "deploys" merging into "deploy" is not
 * read as a deletion.
 *
 * Biased towards reporting a loss. A false positive only costs a duplicate
 * entry, which is recoverable; a false negative deletes a fact for good.
 */
const isLossyRewrite = (original: string, replacement: string): boolean => {
  const fold = (tokens: Set<string>): Set<string> =>
    new Set([...tokens].map((t) => (t.length >= 4 && t.endsWith("s") ? t.slice(0, -1) : t)));
  const after = fold(distinctiveTokens(replacement));
  for (const token of fold(distinctiveTokens(original))) {
    if (!after.has(token)) return true;
  }
  return false;
};

/** How many existing memories to put in front of the adjudicator. */
const MAX_CANDIDATES = 8;

/** Words that appear in every restatement and so carry no identity. */
const FILLER_TOKENS = new Set([
  "this", "that", "these", "those", "there", "here", "with", "from", "into", "must",
  "should", "always", "never", "under", "over", "about", "after", "before", "when",
  "where", "which", "what", "your", "their", "them", "they", "then", "than", "also",
  "just", "only", "each", "every", "some", "such", "very", "more", "most", "same",
  "file", "files", "name", "names", "project", "repository", "repo", "note",
]);


/** Rough token cost of a string. */
const estimateTokens = (value: string): number => Math.ceil(value.length / 4);

/**
 * Identifiers worth matching a memory against: URLs, dotted paths, SCREAMING
 * names and camelCase/kebab tokens.
 *
 * Aider's repo map calls these `mentioned_idents` and uses them to personalise
 * PageRank; the point is that a user naming a concrete thing is a far stronger
 * signal than the words around it.
 */
export const extractIdentifiers = (text: string): string[] => {
  const found = new Set<string>();
  for (const match of text.match(/\bhttps?:\/\/[^\s<>()[\]"'`]+/g) ?? []) found.add(match);
  for (const match of text.match(/\b(?:\.{0,2}\/)?[\w-]+(?:\/[\w.-]+)+\/?/g) ?? []) {
    if (match.length > 3) found.add(match);
  }
  for (const match of text.match(/\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g) ?? []) found.add(match);
  for (const match of text.match(/\b[A-Z]{2,}[0-9][A-Z0-9-]*\b/g) ?? []) found.add(match);
  for (const match of text.match(/\b[a-z]+(?:[A-Z][a-z0-9]+){1,}\b/g) ?? []) found.add(match);
  for (const match of text.match(/\b[a-z]+(?:-[a-z0-9]+){2,}\b/g) ?? []) found.add(match);
  for (const match of text.match(/\b[0-9a-f]{6,}\b/gi) ?? []) found.add(match);
  return [...found];
};

/** Index line: short, scannable, no body. */
const gistOf = (item: MemoryItem): string => {
  if (item.gist && item.gist.trim().length > 0) return item.gist.trim();
  const first = item.content.split(/(?<=[.!?])\s/)[0] ?? item.content;
  const trimmed = first.trim();
  return trimmed.length > 90 ? `${trimmed.slice(0, 90)}…` : trimmed;
};


/**
 * Instructions about *this conversation* rather than durable facts about the
 * project. "Do not verify the staging build ID against the repository" and "Just
 * remember this" describe how to behave right now, so storing them produces
 * noise that later looks like a project constraint.
 *
 * Deliberately explicit patterns rather than a "is this specific enough?"
 * heuristic — over-filtering would silently lose real memories, which is the
 * worse failure.
 */
const INTERACTION_SCOPED = [
  /\b(?:do not|don'?t|never|no need to)\s+(?:verify|check|confirm|look\s?up|search|investigate|browse|resolve)\b/i,
  /\bjust\s+(?:remember|note|acknowledge|retain|treat)\b/i,
  /\b(?:held|noted|stored|remembered)\s+(?:in|for)\s+(?:this|the)\s+conversation\b/i,
  /\bnot\s+verified\b/i,
  /\bwithout\s+verifying\b/i,
  /\bfor\s+this\s+(?:conversation|session|turn|reply|response)\s+only\b/i,
  /^(?:ok|okay|noted|got it|sure|thanks)\b[.!]?$/i,
];

export const isInteractionScoped = (content: string): boolean =>
  INTERACTION_SCOPED.some((pattern) => pattern.test(content));

export class CognitiveMemory {
  // L0: Pinned core state (identity, self-model, active tensions)
  private activeTensions: Map<string, KnowledgeTension> = new Map();
  private selfModel: ProprioceptiveSelfModel;
  private activeTaskTrace = "";

  // L1: Hot Cache (pre-staged for upcoming turn)
  private l1HotCache: Map<string, MemoryItem> = new Map();

  // L2: Warm Storage (indexed candidates ready for promotion)
  private l2WarmStore: Map<string, MemoryItem> = new Map();

  // L3: Cold Archive (historical, loaded on demand)
  private l3ColdArchive: Map<string, MemoryItem> = new Map();

  private maxL0Tokens: number;
  private maxL1Tokens: number;
  /** Ceiling on everything injected into one prompt, index and bodies together. */
  private maxTotalTokens: number;
  private arbiter: ArbiterFn | null = null;
  private autoExtractMemories: boolean;
  /** Model-backed turn extractor; the regex fallback runs when this is absent. */
  private reconcile?: CognitiveMemoryOptions["reconcile"];
  private extract?: (turn: { userMessage: string; assistantResponse: string }) => Promise<{
    memories: Array<{ content: string; domains?: string[] }>;
    tensions?: Array<{
      claimA: string;
      claimB: string;
      impact: "low" | "medium" | "critical";
      actionableQuestion: string;
    }>;
  }>;
  private onPersist?: (state: CognitiveMemoryStateSnapshot) => Promise<void> | void;

  private stats = {
    totalTurnsProcessed: 0,
    predictionsHit: 0,
    predictionsTotal: 0,
    tensionsDetected: 0,
  };

  constructor(options: CognitiveMemoryOptions = {}) {
    this.maxL0Tokens = options.maxL0Tokens ?? 2000;
    this.maxL1Tokens = options.maxL1Tokens ?? 8000;
    this.maxTotalTokens = options.maxTotalTokens ?? 2000;
    this.arbiter = options.arbiter ?? null;
    this.autoExtractMemories = options.autoExtractMemories ?? true;
    this.extract = options.extract;
    this.reconcile = options.reconcile;
    this.onPersist = options.onPersist;

    this.selfModel = {
      domains: options.initialSelfModel?.domains ?? {},
      calibrationFactor: options.initialSelfModel?.calibrationFactor ?? 1.0,
      activeDomains: options.initialSelfModel?.activeDomains ?? [],
    };
  }

  /**
   * Sub-1ms synchronous call to produce the prompt context block.
   * Concatenates L0 (active tensions + self-model) and pre-staged L1.
   * Adds zero latency to TTFT.
   */
  /**
   * Decide what goes into this turn's prompt, and record why.
   *
   * Follows the index/body split that Claude Code's `MEMORY.md` and Letta's
   * progressive disclosure both converged on: a short index of every memory is
   * always present, and a body is only spent where a deterministic signal earned
   * it. Always injecting bodies costs an order of magnitude more tokens and, per
   * Chroma's context-rot work, injects distractors by construction.
   *
   * @param forceFull memory ids whose body should be included regardless of tier.
   */
  planInjection(options: { userMessage?: string; forceFull?: Iterable<string> } = {}): MemoryInjectionReport {
    const force = new Set(options.forceFull ?? []);
    const sections: string[] = [];
    const entries: MemoryInjectionEntry[] = [];
    let used = 0;
    let truncated = false;

    const include = (
      item: MemoryItem,
      reason: MemoryInclusionReason,
      withBody: boolean
    ): void => {
      const gist = gistOf(item);
      const body = withBody ? item.content : undefined;
      const tags = item.metadata.domains.slice(0, 3);
      const suffix = tags.length > 0 ? ` (${tags.join(", ")})` : "";
      const tokens = estimateTokens(`${gist}${suffix}${body ?? ""}`);
      if (used + tokens > this.maxTotalTokens) {
        truncated = true;
        return;
      }
      used += tokens;
      entries.push({ id: item.id, tier: item.tier, reason, gist, body, tokens });
    };

    // Fast gate: catch a contradiction in what the user just said.
    if (options.userMessage) {
      const gate = runFastGate(options.userMessage);
      if (gate.action === "inject_caution" && gate.cautionNote) {
        sections.push(`### ⚠️ Premise Correction Notice\n${gate.cautionNote}`);
      }
    }

    // Proprioceptive guardrails: domains this agent is weak in.
    const weakDomains = this.selfModel.activeDomains
      .map((d) => ({ d, capability: this.selfModel.domains[d] }))
      .filter((x) => x.capability && x.capability.reliabilityScore < 0.75);
    if (weakDomains.length > 0) {
      const lines = weakDomains.map(({ d, capability }) => {
        const cap = capability!;
        include(
          {
            id: `guardrail-${d}`,
            content: `${d}: reliability ${Math.round(cap.reliabilityScore * 100)}% over ${cap.sampleCount} tasks.${
              cap.knownFailurePatterns.length > 0 ? ` Known pitfalls: ${cap.knownFailurePatterns.join("; ")}` : ""
            }${cap.recommendedStrategies.length > 0 ? ` Approach: ${cap.recommendedStrategies.join("; ")}` : ""}`,
            bookmark: `${d} weak domain`,
            tier: "L0",
            metadata: { domains: [d], createdAt: Date.now(), lastAccessedAt: Date.now(), accessCount: 0 },
          },
          "guardrail",
          true,
        );
        return `- ${d} (${Math.round(cap.reliabilityScore * 100)}% reliable): ${
          cap.knownFailurePatterns.join("; ") || "be careful"
        }`;
      });
      sections.push(`### Proprioceptive Guardrails (High Attention Required)\n${lines.join("\n")}`);
    }

    // Index: one line per memory, bodies withheld unless a trigger earned them.
    const indexLines: string[] = [];
    for (const item of this.l1HotCache.values()) {
      const tags = item.metadata.domains.slice(0, 3);
      const suffix = tags.length > 0 ? ` (${tags.join(", ")})` : "";
      if (force.has(item.id)) {
        include(item, "trigger", true);
        indexLines.push(`- ${item.content}${suffix}`);
      } else {
        include(item, "index", false);
        indexLines.push(`- ${gistOf(item)}${suffix}`);
      }
    }
    if (indexLines.length > 0) {
      sections.push(
        [
          "### Memory index — established earlier in this project",
          "One line per remembered item. Use `recall` to pull a full item, then treat it as true.",
          ...indexLines,
        ].join("\n"),
      );
    }

    // Active tensions earn full bodies: they are prompts to clarify, not trivia.
    const activeTensions = [...this.activeTensions.values()].filter((t) => t.status === "active");
    if (activeTensions.length > 0) {
      const lines = activeTensions.map((t) => {
        include(
          {
            id: t.id,
            content: `${t.claimA.statement} vs ${t.claimB.statement} — ${t.actionableQuestion}`,
            bookmark: t.claimA.statement,
            tier: "L0",
            metadata: { domains: [], createdAt: t.claimA.timestamp, lastAccessedAt: Date.now(), accessCount: 0 },
          },
          "tension",
          true,
        );
        return `- [${t.impact.toUpperCase()}] "${t.claimA.statement}" conflicts with "${t.claimB.statement}". Ask: ${t.actionableQuestion}`;
      });
      sections.push(`### Active Knowledge Tensions (Contradictions)\n${lines.join("\n")}`);
    }

    return {
      text: sections.length > 0 ? `\n## Cognitive Memory State\n${sections.join("\n\n")}\n` : "",
      entries,
      totalTokens: used,
      truncated,
    };
  }

  /** Prompt text only. Prefer `planInjection` when you want to log what went in. */
  getPromptContext(currentUserMessage?: string): string {
    return this.planInjection({ userMessage: currentUserMessage }).text;
  }

  /**
   * Search every tier for memories relevant to `query`.
   *
   * This is the on-demand path, exposed to the agent as a tool. Pre-staging into
   * the prompt is a best-effort optimisation; a model that does not read the
   * block, or whose question shares no words with it, can still ask. Ranking is
   * deterministic — no model involved — so recall does not depend on model
   * quality.
   */
  search(query: string, limit = 8): Array<{ item: MemoryItem; score: number }> {
    const q = relevanceTokens(query);
    if (q.size === 0) return [];

    const pool: MemoryItem[] = [
      ...this.l1HotCache.values(),
      ...this.l2WarmStore.values(),
      ...this.l3ColdArchive.values(),
    ];

    const scored = pool
      .map((item) => ({
        item,
        score: overlapScore(q, relevanceTokens(`${item.content} ${item.metadata.domains.join(" ")}`)),
      }))
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score || a.item.content.length - b.item.content.length);

    // Collapse paraphrases of the same fact to the best-scoring instance.
    const seen: string[] = [];
    const out: Array<{ item: MemoryItem; score: number }> = [];
    for (const entry of scored) {
      const key = entry.item.content.toLowerCase();
      if (seen.some((existing) => overlapScore(relevanceTokens(existing), relevanceTokens(key)) >= 0.8)) {
        continue;
      }
      seen.push(key);
      out.push(entry);
      if (out.length >= Math.max(1, limit)) break;
    }
    return out;
  }

  /**
   * Post-turn asynchronous execution.
   * Fired when the agent finishes streaming its response to the user.
   * Evaluates turn, manages L1 cache, detects tensions, updates self-model.
   */
  async postTurnAsync(params: {
    userMessage: string;
    assistantResponse: string;
    detectedDomains?: string[];
  }): Promise<void> {
    this.stats.totalTurnsProcessed += 1;

    // 1. Update active domains
    if (params.detectedDomains && params.detectedDomains.length > 0) {
      this.selfModel.activeDomains = Array.from(
        new Set([...this.selfModel.activeDomains, ...params.detectedDomains])
      );
    }

    // 2. Select candidates from L2 for Arbiter evaluation
    const candidates = Array.from(this.l2WarmStore.values())
      .slice(0, 20)
      .map((item) => ({
        id: item.id,
        bookmark: item.bookmark,
        domains: item.metadata.domains,
        hasTension: false,
      }));

    const l1Summaries = Array.from(this.l1HotCache.values()).map((m) => ({
      id: m.id,
      bookmark: m.bookmark,
      domains: m.metadata.domains,
    }));

    // 3. Run Arbiter if configured, or use built-in heuristic arbiter
    const evaluation = this.arbiter
      ? await this.arbiter({
          turnText: params.userMessage,
          assistantReply: params.assistantResponse,
          l0Prompt: this.activeTaskTrace,
          l1Summaries,
          candidates,
        })
      : this.runHeuristicArbiter(params, candidates);

    // 4. Apply Arbiter Decision
    this.applyArbiterDecision(evaluation);

    // 5. Learn from the turn. A model-backed extractor is preferred: the regex
    //    fallback only catches "always/never/remember to", so plain project
    //    facts ("the staging URL is X") were never learned at all.
    if (this.autoExtractMemories) {
      if (this.extract) {
        try {
          await this.applyExtraction(
            await this.extract({ userMessage: params.userMessage, assistantResponse: params.assistantResponse }),
          );
        } catch {
          // A failed extraction must not break the turn; the regex fallback below
          // still gets a chance.
          this.autoExtractTurnMemory(params.userMessage, params.assistantResponse);
        }
      } else if (params.assistantResponse.length > 50) {
        this.autoExtractTurnMemory(params.userMessage, params.assistantResponse);
      }
    }

    // 6. Enforce the L0/L1 budgets so the "cache" cannot grow without bound.
    this.enforceBudgets();

    // 7. Trigger persistence callback if registered
    if (this.onPersist) {
      try {
        await this.onPersist(this.getSnapshot());
      } catch {
        // Non-blocking
      }
    }
  }

  /**
   * Fold extracted memories and tensions in, skipping anything already known.
   *
   * Extracted items land in L2 rather than L1: they are candidates, and the
   * arbiter decides what is worth pre-staging. That is what gives the tiering
   * something to actually do — previously nothing ever wrote to L2, so every
   * arbiter run evaluated an empty candidate set.
   */
  private async applyExtraction(result: {
    memories: Array<{ content: string; domains?: string[] }>;
    tensions?: Array<{
      claimA: string;
      claimB: string;
      impact: "low" | "medium" | "critical";
      actionableQuestion: string;
    }>;
  }): Promise<void> {
    // Memories held aside for one batched adjudication at the end of the turn.
    const pending: Array<{ content: string; candidates: MemoryItem[] }> = [];
    for (const memory of result.memories ?? []) {
      const content = memory.content.trim();
      if (content.length < 8 || content.length > 600) continue;
      if (isInteractionScoped(content)) continue;

      // Two stages: recall candidates cheaply, then adjudicate.
      //
      // The safe default when nothing can adjudicate, or when the adjudicator is
      // unsure, is to add. An unmerged duplicate costs one row; a wrong merge
      // corrupts what we believe and is hard to unwind. Zep publishes the same
      // bias: prefer under-merge over over-merge.
      let stored = content;
      const candidates = this.recallSimilar(content);
      if (candidates.length > 0) {
        let verdict: MemoryReconciliation = { action: "add" };
        if (this.reconcile) {
          // Deferred: one adjudicator call for the whole turn, not one per
          // memory. Awaiting inside this loop made a five-memory turn cost six
          // serial model calls.
          // Added optimistically below, then the batch verdict may reject,
          // merge or replace it. Storing first keeps memory available even if
          // the adjudicator is slow or never answers.
          pending.push({ content, candidates });
        } else if (candidates.some((c) => c.content.trim().toLowerCase() === content.trim().toLowerCase())) {
          // Byte-identical restatement: never worth storing twice.
          verdict = { action: "merge" };
        }

        if (verdict.action === "reject") continue;
        if (verdict.action === "merge") {
          // Merge means one memory survives, holding the fuller statement -
          // never "keep both" and never "keep the barer one". A rewrite that
          // would drop information is declined, and falling through stores the
          // restatement separately instead of losing what it added.
          // The incoming statement was never stored, so there is nothing to
          // remove: it folds into the survivor or falls through and is kept.
          if (candidates[0] && this.mergeInto(candidates[0], verdict.content, { text: content, stored: false })) {
            continue;
          }
        }
        if (verdict.action === "replace") {
          // Supersede rather than keep both: the old entry stops being returned.
          this.supersede(candidates.map((c) => c.content));
        }
        stored = verdict.content?.trim() || content;
      }

      const now = Date.now();
      const id = `mem-${now}-${Math.random().toString(36).slice(2, 7)}`;
      // File it in L1, not L2. The user stated this one turn ago, so it is
      // relevant by definition: waiting for the arbiter to promote it added a
      // one-turn lag, which meant a freshly-taught fact was still missing from
      // the very next prompt.
      this.addMemory(
        {
          id,
          content: stored,
          bookmark: stored.slice(0, 80),
          tier: "L1",
          metadata: {
            domains: memory.domains ?? [],
            createdAt: now,
            lastAccessedAt: now,
            accessCount: 1,
          },
        },
        "L1",
      );
    }

    // One adjudicator call for the whole turn. Failures fall back to "keep
    // both", so a flaky model costs duplicates, never lost information.
    if (pending.length > 0 && this.reconcile) {
      let verdicts: MemoryReconciliation[] = [];
      try {
        verdicts = await this.reconcile({
          items: pending.map((p) => ({ candidate: p.content, remember: p.candidates.map((c) => c.content) })),
        });
      } catch {
        verdicts = [];
      }
      for (const [index, entry] of pending.entries()) {
        const verdict = verdicts[index];
        if (!verdict) continue;
        if (verdict.action === "reject") this.removeByContent(entry.content);
        else if (verdict.action === "merge") {
          const survivor = entry.candidates[0];
          // Stored optimistically, so the duplicate is removed on the way in -
          // before the rewrite, never after.
          if (survivor && this.mergeInto(survivor, verdict.content, { text: entry.content, stored: true })) {
            continue;
          }
        } else if (verdict.action === "replace") {
          this.supersede(entry.candidates.map((c) => c.content));
          if (verdict.content) this.replaceByContent(entry.content, verdict.content);
        }
      }
    }

    for (const tension of result.tensions ?? []) {
      const key = `${tension.claimA}::${tension.claimB}`.toLowerCase();
      if (this.activeTensions.has(key)) continue;
      this.addTension({
        id: key,
        status: "active",
        claimA: { source: "user", statement: tension.claimA, timestamp: Date.now() },
        claimB: { source: "conversation", statement: tension.claimB, timestamp: Date.now() },
        impact: tension.impact,
        taskRelevance: 1,
        actionableQuestion: tension.actionableQuestion,
      });
    }
  }

  /** Drop an entry by its exact content. */
  private removeByContent(content: string): void {
    const target = content.trim().toLowerCase();
    for (const map of [this.l1HotCache, this.l2WarmStore, this.l3ColdArchive]) {
      for (const [id, item] of map) {
        if (item.content.trim().toLowerCase() === target) map.delete(id);
      }
    }
  }

  /** Rewrite one entry's text in place, matched on its old value. */
  private replaceByContent(from: string, to: string): void {
    const target = from.trim().toLowerCase();
    for (const map of [this.l1HotCache, this.l2WarmStore, this.l3ColdArchive]) {
      for (const item of map.values()) {
        if (item.content.trim().toLowerCase() === target && !isLossyRewrite(item.content, to)) {
          this.enrich(item, to);
        }
      }
    }
  }

  /** Replace an entry's content, keeping its identity and tags. */
  private enrich(target: MemoryItem, content: string): void {
    target.content = content;
    target.bookmark = content.slice(0, 80);
    target.metadata.lastAccessedAt = Date.now();
  }

  /**
   * Fold a duplicate into its survivor, refusing rewrites that drop anything.
   *
   * `merge` returns the model's idea of the fuller statement, and overwriting
   * with it deletes whatever the model happened to leave out. The under-merge
   * bias covers merging the *wrong* pair, but nothing covered a lossy rewrite
   * of the right pair, so containment is checked first.
   *
   * @returns false when the rewrite would lose information, in which case the
   * caller keeps both entries.
   */
  private mergeInto(
    survivor: MemoryItem,
    replacement: string | undefined,
    duplicate: { text: string; stored: boolean },
  ): boolean {
    const text = replacement?.trim();
    // Both statements are checked, not just the survivor: a merge has to carry
    // everything either one held, so dropping the *incoming* qualifier loses it
    // just as permanently as dropping the survivor's.
    if (
      text &&
      (isLossyRewrite(survivor.content, text) || isLossyRewrite(duplicate.text, text))
    ) {
      return false;
    }
    // Remove the duplicate BEFORE rewriting the survivor: afterwards the two
    // hold the same text, so removing by content would match both.
    if (duplicate.stored) this.removeByContent(duplicate.text);
    if (text) this.enrich(survivor, text);
    return true;
  }

  /** Retire the entries a replacement supersedes, keeping them out of retrieval. */
  private supersede(contents: string[]): void {
    const targets = new Set(contents.map((c) => c.trim().toLowerCase()));
    for (const map of [this.l1HotCache, this.l2WarmStore, this.l3ColdArchive]) {
      for (const [id, item] of map) {
        if (targets.has(item.content.trim().toLowerCase())) map.delete(id);
      }
    }
  }

  /**
   * Existing memories worth adjudicating a candidate against.
   *
   * Cheap and deliberately over-inclusive. An identical string short-circuits
   * because it is never worth a model call; anything else above the recall floor
   * is offered to the adjudicator, which decides.
   */
  private recallSimilar(content: string): MemoryItem[] {
    const needle = distinctiveTokens(content);
    if (needle.size === 0) return [];
    const existing = [
      ...this.l1HotCache.values(),
      ...this.l2WarmStore.values(),
      ...this.l3ColdArchive.values(),
    ];

    const scored = existing
      .map((item) => {
        const have = distinctiveTokens(item.content);
        let shared = 0;
        for (const word of needle) if (have.has(word)) shared += 1;
        return { item, exact: item.content.trim().toLowerCase() === content.trim().toLowerCase(), score: have.size ? shared / Math.min(needle.size, have.size) : 0 };
      })
      // An exact restatement is certain; the rest are merely candidates.
      .filter((entry) => entry.exact || entry.score >= CANDIDATE_FLOOR)
      .sort((a, b) => Number(b.exact) - Number(a.exact) || b.score - a.score);

    return scored.slice(0, MAX_CANDIDATES).map((entry) => entry.item);
  }

  /**
   * Keep the pinned tiers within budget.
   *
   * `maxL0Tokens`/`maxL1Tokens` were stored but never read, so L1 grew for the
   * lifetime of the process. Evict least-recently-accessed first, and demote to
   * L2 rather than dropping, so nothing is lost.
   */
  private enforceBudgets(): void {
    const trim = (map: Map<string, MemoryItem>, budget: number): void => {
      if (budget <= 0) return;
      let total = 0;
      for (const item of map.values()) total += item.content.length / 4;
      if (total <= budget) return;
      const ordered = [...map.values()].sort(
        (a, b) => a.metadata.lastAccessedAt - b.metadata.lastAccessedAt,
      );
      for (const item of ordered) {
        if (total <= budget) break;
        map.delete(item.id);
        total -= item.content.length / 4;
        // Demote rather than discard: it can be promoted again later.
        this.l2WarmStore.set(item.id, { ...item, tier: "L2" });
      }
    };
    trim(this.l1HotCache, this.maxL1Tokens);
  }

  /**
   * Add a known tension manually or from an external source.
   */
  addTension(tension: KnowledgeTension): void {
    this.activeTensions.set(tension.id, tension);
    this.stats.tensionsDetected += 1;
  }

  /**
   * Mark a tension resolved with an optional reusable pattern.
   */
  resolveTension(id: string, resolution: { resolvedBy: string; pattern: string }): boolean {
    const t = this.activeTensions.get(id);
    if (!t) return false;
    t.status = "resolved";
    t.resolution = {
      resolvedAt: Date.now(),
      resolvedBy: resolution.resolvedBy,
      pattern: resolution.pattern,
    };
    return true;
  }

  /**
   * Add a memory directly to L2 warm storage or promote to L1.
   */
  addMemory(item: MemoryItem, targetTier: MemoryTier = "L2"): void {
    item.tier = targetTier;
    if (targetTier === "L1") {
      this.l1HotCache.set(item.id, item);
    } else if (targetTier === "L2") {
      this.l2WarmStore.set(item.id, item);
    } else if (targetTier === "L3") {
      this.l3ColdArchive.set(item.id, item);
    }
  }

  /**
   * Update the proprioceptive capability record for a domain.
   */
  recordDomainOutcome(domain: string, success: boolean, failurePattern?: string): void {
    const current = this.selfModel.domains[domain] ?? {
      reliabilityScore: 0.8,
      sampleCount: 0,
      knownFailurePatterns: [],
      recommendedStrategies: [],
    };

    const newSampleCount = current.sampleCount + 1;
    // Moving average update
    const weight = 1 / Math.min(newSampleCount, 10);
    const outcomeVal = success ? 1.0 : 0.0;
    const newScore = current.reliabilityScore * (1 - weight) + outcomeVal * weight;

    if (!success && failurePattern && !current.knownFailurePatterns.includes(failurePattern)) {
      current.knownFailurePatterns.push(failurePattern);
    }

    this.selfModel.domains[domain] = {
      reliabilityScore: Number(newScore.toFixed(3)),
      sampleCount: newSampleCount,
      knownFailurePatterns: current.knownFailurePatterns,
      recommendedStrategies: current.recommendedStrategies,
    };
  }

  getSnapshot(): CognitiveMemoryStateSnapshot {
    return {
      l0: {
        tensions: Array.from(this.activeTensions.values()),
        selfModel: JSON.parse(JSON.stringify(this.selfModel)),
        activeTaskTrace: this.activeTaskTrace,
      },
      l1: Array.from(this.l1HotCache.values()),
      l2: Array.from(this.l2WarmStore.values()),
      l3: Array.from(this.l3ColdArchive.values()),
      stats: { ...this.stats },
    };
  }

  loadSnapshot(snapshot: CognitiveMemoryStateSnapshot): void {
    this.activeTensions.clear();
    for (const t of snapshot.l0.tensions) {
      this.activeTensions.set(t.id, t);
    }
    this.selfModel = snapshot.l0.selfModel;
    this.activeTaskTrace = snapshot.l0.activeTaskTrace;

    this.l1HotCache.clear();
    for (const m of snapshot.l1) {
      this.l1HotCache.set(m.id, m);
    }

    this.l2WarmStore.clear();
    for (const m of snapshot.l2) {
      this.l2WarmStore.set(m.id, m);
    }

    this.l3ColdArchive.clear();
    for (const m of snapshot.l3) {
      this.l3ColdArchive.set(m.id, m);
    }

    this.stats = { ...snapshot.stats };
  }

  private applyArbiterDecision(evaluation: ArbiterEvaluationResult): void {
    // 1. Promotions to L1
    for (const p of evaluation.promotions) {
      const memory = this.l2WarmStore.get(p.memoryId) ?? this.l3ColdArchive.get(p.memoryId);
      if (memory) {
        memory.tier = "L1";
        memory.metadata.lastAccessedAt = Date.now();
        memory.metadata.accessCount += 1;
        this.l1HotCache.set(memory.id, memory);
        this.l2WarmStore.delete(memory.id);
        this.l3ColdArchive.delete(memory.id);
      }
    }

    // 2. Demotions to L2
    for (const d of evaluation.demotions) {
      const memory = this.l1HotCache.get(d.memoryId);
      if (memory) {
        memory.tier = "L2";
        this.l2WarmStore.set(memory.id, memory);
        this.l1HotCache.delete(memory.id);
      }
    }

    // 3. New Tensions
    for (const t of evaluation.detectedTensions) {
      const tensionId = `tension-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      this.addTension({
        id: tensionId,
        status: "active",
        claimA: { source: "current conversation", statement: t.claimA, timestamp: Date.now() },
        claimB: { source: "known state / files", statement: t.claimB, timestamp: Date.now() },
        impact: t.impact,
        taskRelevance: 1.0,
        actionableQuestion: t.actionableQuestion,
      });
    }

    // 4. Self-Model Updates
    if (evaluation.selfModelUpdate) {
      const { domain, success, failurePatternObserved } = evaluation.selfModelUpdate;
      if (success !== undefined) {
        this.recordDomainOutcome(domain, success, failurePatternObserved);
      }
    }
  }

  /**
   * Fast default heuristic arbiter when an LLM arbiter model is not supplied.
   */
  private runHeuristicArbiter(
    params: { userMessage: string; assistantResponse: string },
    candidates: Array<{ id: string; bookmark: string; domains: string[] }>
  ): ArbiterEvaluationResult {
    const promotions: ArbiterEvaluationResult["promotions"] = [];
    const demotions: ArbiterEvaluationResult["demotions"] = [];

    const turn = relevanceTokens(`${params.userMessage} ${params.assistantResponse}`);
    const scored = candidates
      .map((candidate) => ({
        candidate,
        score: overlapScore(
          turn,
          relevanceTokens(`${candidate.bookmark} ${candidate.domains.join(" ")}`),
        ),
      }))
      .filter((entry) => entry.score > PROMOTE_THRESHOLD)
      .sort((a, b) => b.score - a.score)
      .slice(0, 3);

    for (const { candidate, score } of scored) {
      promotions.push({
        memoryId: candidate.id,
        targetTier: "L1",
        signalType: "anticipatory",
        urgency: Math.min(1, score),
      });
    }

    for (const item of this.l1HotCache.values()) {
      const relevant =
        overlapScore(turn, relevanceTokens(`${item.bookmark} ${item.metadata.domains.join(" ")}`)) > 0;
      if (!relevant && this.l1HotCache.size > DEMOTE_ABOVE) {
        demotions.push({
          memoryId: item.id,
          targetTier: "L2",
          reason: "Not referenced in recent turns",
        });
      }
    }

    if (process.env.NAH_MEMORY_DEBUG) {
      console.log(
        `    [arbiter] scored=${JSON.stringify(scored.map((e) => ({ id: e.candidate.id, score: Number(e.score.toFixed(2)) })))} promotions=${promotions.length} demotions=${demotions.length}`,
      );
    }

    return { promotions, demotions, pins: [], detectedTensions: [] };
  }

  private autoExtractTurnMemory(userMsg: string, assistantReply: string): void {
    // If user provided a critical rule or config preference, store as warm memory
    const preferenceMatch = userMsg.match(/(?:always|never|make sure to|remember to|use)\s+([^\.\n]+)/i);
    if (preferenceMatch && preferenceMatch[1]) {
      const id = `mem-pref-${Date.now()}`;
      const statement = preferenceMatch[1].trim();
      if (isInteractionScoped(`User preference: ${statement}`)) return;
      this.addMemory({
        id,
        content: `User preference: ${statement}`,
        bookmark: `User preference: ${statement.slice(0, 80)}`,
        tier: "L1", // Pre-stage directly into hot cache
        metadata: {
          domains: this.selfModel.activeDomains,
          createdAt: Date.now(),
          lastAccessedAt: Date.now(),
          accessCount: 1,
        },
      }, "L1");
    }
  }
}
