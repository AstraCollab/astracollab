import type {
  ArbiterEvaluationResult,
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
  private arbiter: ArbiterFn | null = null;
  private autoExtractMemories: boolean;
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
    this.arbiter = options.arbiter ?? null;
    this.autoExtractMemories = options.autoExtractMemories ?? true;
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
  getPromptContext(currentUserMessage?: string): string {
    const sections: string[] = [];

    // Optional: check fast gate
    if (currentUserMessage) {
      const gateResult = runFastGate(currentUserMessage);
      if (gateResult.action === "inject_caution" && gateResult.cautionNote) {
        sections.push(`### ⚠️ Premise Correction Notice\n${gateResult.cautionNote}`);
      }
    }

    // 1. Build L0 Section (Self-Model & Guardrails)
    const activeDomains = this.selfModel.activeDomains;
    const weakDomains = activeDomains
      .map((d) => ({ domain: d, capability: this.selfModel.domains[d] }))
      .filter((d) => d.capability && d.capability.reliabilityScore < 0.75);

    const l0Parts: string[] = [];

    if (weakDomains.length > 0) {
      l0Parts.push("#### Proprioceptive Guardrails (High Attention Required)");
      for (const { domain, capability } of weakDomains) {
        if (!capability) continue;
        const reliability = Math.round(capability.reliabilityScore * 100);
        l0Parts.push(
          `- Domain **${domain}** (reliability: ${reliability}% over ${capability.sampleCount} tasks)`
        );
        if (capability.knownFailurePatterns.length > 0) {
          l0Parts.push(`  • Known pitfalls: ${capability.knownFailurePatterns.join("; ")}`);
        }
        if (capability.recommendedStrategies.length > 0) {
          l0Parts.push(`  • Recommended approach: ${capability.recommendedStrategies.join("; ")}`);
        }
      }
    }

    // 2. Build L0 Section (Active Tensions - PINNED)
    const activeTensions = Array.from(this.activeTensions.values()).filter(
      (t) => t.status === "active"
    );
    if (activeTensions.length > 0) {
      l0Parts.push("#### 🔴 Active Knowledge Tensions (Contradictions)");
      l0Parts.push(
        "The following contradictions were detected between statements, code, or config. Clarify before assuming:"
      );
      for (const t of activeTensions) {
        l0Parts.push(
          `- **[${t.impact.toUpperCase()}]**: "${t.claimA.statement}" (from ${t.claimA.source}) vs. "${t.claimB.statement}" (from ${t.claimB.source})`
        );
        l0Parts.push(`  ➜ Question: ${t.actionableQuestion}`);
      }
    }

    if (this.activeTaskTrace) {
      l0Parts.push(`#### Active Task Trace\n${this.activeTaskTrace}`);
    }

    if (l0Parts.length > 0) {
      sections.push(`### Memory L0: Core State\n${l0Parts.join("\n")}`);
    }

    // 3. Build L1 Section (Pre-staged Hot Cache)
    const l1Items = Array.from(this.l1HotCache.values());
    if (l1Items.length > 0) {
      const l1Content = l1Items
        .map((m) => {
          const domainLabel = m.metadata.domains.length > 0 ? ` [${m.metadata.domains.join(", ")}]` : "";
          return `• ${domainLabel}${m.content}`;
        })
        .join("\n\n");
      sections.push(`### Memory L1: Pre-Staged Context\n${l1Content}`);
    }

    if (sections.length === 0) {
      return "";
    }

    return `\n## Cognitive Memory State\n${sections.join("\n\n")}\n`;
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

    // 5. Auto-extract new insights if enabled
    if (this.autoExtractMemories && params.assistantResponse.length > 50) {
      this.autoExtractTurnMemory(params.userMessage, params.assistantResponse);
    }

    // 6. Trigger persistence callback if registered
    if (this.onPersist) {
      try {
        await this.onPersist(this.getSnapshot());
      } catch {
        // Non-blocking
      }
    }
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
    const combined = `${params.userMessage} ${params.assistantResponse}`.toLowerCase();
    const promotions: ArbiterEvaluationResult["promotions"] = [];
    const demotions: ArbiterEvaluationResult["demotions"] = [];

    // Find candidates whose domains match current active domains
    for (const candidate of candidates) {
      const matches = candidate.domains.some((d) => combined.includes(d.toLowerCase()));
      if (matches) {
        promotions.push({
          memoryId: candidate.id,
          targetTier: "L1",
          signalType: "anticipatory",
          urgency: 0.8,
        });
      }
    }

    // Demote L1 items that haven't been touched in over 3 turns
    for (const [id, item] of this.l1HotCache.entries()) {
      const isDomainRelevant = item.metadata.domains.some((d) => combined.includes(d.toLowerCase()));
      if (!isDomainRelevant && this.l1HotCache.size > 5) {
        demotions.push({
          memoryId: id,
          targetTier: "L2",
          reason: "Domain no longer active in recent turns",
        });
      }
    }

    return {
      promotions,
      demotions,
      pins: [],
      detectedTensions: [],
    };
  }

  private autoExtractTurnMemory(userMsg: string, assistantReply: string): void {
    // If user provided a critical rule or config preference, store as warm memory
    const preferenceMatch = userMsg.match(/(?:always|never|make sure to|remember to|use)\s+([^\.\n]+)/i);
    if (preferenceMatch && preferenceMatch[1]) {
      const id = `mem-pref-${Date.now()}`;
      const statement = preferenceMatch[1].trim();
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
