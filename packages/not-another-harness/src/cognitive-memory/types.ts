/**
 * Cognitive Memory types and contracts for not-another-harness.
 */

export type MemoryTier = "L0" | "L1" | "L2" | "L3";

export type TensionStatus = "active" | "latent" | "resolved";

export type TensionImpact = "low" | "medium" | "critical";

export interface KnowledgeTension {
  id: string;
  status: TensionStatus;
  claimA: {
    source: string;
    statement: string;
    timestamp: number;
  };
  claimB: {
    source: string;
    statement: string;
    timestamp: number;
  };
  impact: TensionImpact;
  taskRelevance: number; // 0.0 - 1.0
  actionableQuestion: string;
  resolution?: {
    resolvedAt: number;
    resolvedBy: string;
    pattern: string;
  };
}

export interface DomainCapability {
  reliabilityScore: number; // 0.0 - 1.0 (historical success rate)
  sampleCount: number;
  knownFailurePatterns: string[];
  recommendedStrategies: string[];
}

export interface ProprioceptiveSelfModel {
  /** Map of domain tag (e.g. "auth", "db-migration", "css") to capability stats */
  domains: Record<string, DomainCapability>;
  /** Overall calibration score (1.0 = well-calibrated, <0.7 = overconfident) */
  calibrationFactor: number;
  /** Active domains detected in current work */
  activeDomains: string[];
}

export interface MemoryMetadata {
  domains: string[];
  isFailurePattern?: boolean;
  isSuccessfulStrategy?: boolean;
  isGuardrail?: boolean;
  sourceSessionId?: string;
  createdAt: number;
  lastAccessedAt: number;
  accessCount: number;
}

export interface MemoryItem {
  id: string;
  content: string;
  /** Dense 1-2 sentence representation for fast arbiter scanning */
  bookmark: string;
  /**
   * Short label shown in the pre-staged index (Claude Code's `MEMORY.md` pattern:
   * the index is always in context, the body is fetched on demand). Falls back to
   * a truncation of `content` when the extractor did not supply one.
   */
  gist?: string;
  /** Dense embedding vector (empty array if embedding disabled) */
  embedding?: number[];
  tier: MemoryTier;
  metadata: MemoryMetadata;
}

/** Why a memory ended up in the prompt — the thing you tune once you log it. */
export type MemoryInclusionReason =
  /** Shown in the always-present index as a gist only. */
  | "index"
  /** Unseen identifier in the user's message matched this memory: body included. */
  | "trigger"
  /** Active knowledge tension: body included. */
  | "tension"
  /** Proprioceptive guardrail: body included. */
  | "guardrail";

export interface MemoryInjectionEntry {
  id: string;
  tier: MemoryTier;
  reason: MemoryInclusionReason;
  /** Index line only. */
  gist: string;
  /** Present only when the body was worth the tokens. */
  body?: string;
  /** Rough token cost of what was included. */
  tokens: number;
}

/** What was put in the prompt this turn, and why. */
export interface MemoryInjectionReport {
  text: string;
  entries: MemoryInjectionEntry[];
  totalTokens: number;
  /** True when the total budget forced something out. */
  truncated: boolean;
}

export interface TrajectoryPrediction {
  predictedDomains: string[];
  predictedFiles: string[];
  prefetchMemoryIds: string[];
  confidence: number;
}

export interface ArbiterEvaluationResult {
  promotions: Array<{
    memoryId: string;
    targetTier: "L1";
    signalType: "anticipatory" | "tension" | "proprioceptive" | "recency";
    urgency: number; // 0.0 - 1.0
  }>;
  demotions: Array<{
    memoryId: string;
    targetTier: "L2";
    reason: string;
  }>;
  pins: Array<{
    memoryId: string;
    targetTier: "L0";
    reason: string;
  }>;
  detectedTensions: Array<{
    claimA: string;
    claimB: string;
    impact: TensionImpact;
    actionableQuestion: string;
  }>;
  trajectoryPrediction?: TrajectoryPrediction;
  selfModelUpdate?: {
    domain: string;
    success?: boolean;
    failurePatternObserved?: string;
  };
}

export type ArbiterFn = (params: {
  turnText: string;
  assistantReply: string;
  l0Prompt: string;
  l1Summaries: Array<{ id: string; bookmark: string; domains: string[] }>;
  candidates: Array<{ id: string; bookmark: string; domains: string[]; hasTension?: boolean }>;
}) => Promise<ArbiterEvaluationResult>;

export interface CognitiveMemoryOptions {
  /** Maximum token budget for L0 (default: 2000) */
  maxL0Tokens?: number;
  /** Maximum token budget for L1 hot cache (default: 8000) */
  maxL1Tokens?: number;
  /** Ceiling on everything injected into a single prompt (index + bodies). Default 2000. */
  maxTotalTokens?: number;
  /** Custom Arbiter evaluator function (e.g. powered by Jev, Gemini Flash, or local model) */
  arbiter?: ArbiterFn;
  /** Initial self-model */
  initialSelfModel?: Partial<ProprioceptiveSelfModel>;
  /** Auto-extract candidate items from completed turns (default: true) */
  autoExtractMemories?: boolean;
  /**
   * Model-backed turn extractor. Preferred over the built-in regex, which only
   * recognises "always/never/make sure to/remember to" and therefore never
   * learned ordinary project facts. Return an empty array to learn nothing.
   */
  extract?: (turn: { userMessage: string; assistantResponse: string }) => Promise<{
    memories: Array<{ content: string; domains?: string[] }>;
    tensions?: Array<{
      claimA: string;
      claimB: string;
      impact: "low" | "medium" | "critical";
      actionableQuestion: string;
    }>;
  }>;
  /** Persistence callback to save L2/L3 state */
  onPersist?: (state: CognitiveMemoryStateSnapshot) => Promise<void> | void;
}

export interface CognitiveMemoryStateSnapshot {
  l0: {
    tensions: KnowledgeTension[];
    selfModel: ProprioceptiveSelfModel;
    activeTaskTrace: string;
  };
  l1: MemoryItem[];
  l2: MemoryItem[];
  l3: MemoryItem[];
  stats: {
    totalTurnsProcessed: number;
    predictionsHit: number;
    predictionsTotal: number;
    tensionsDetected: number;
  };
}
