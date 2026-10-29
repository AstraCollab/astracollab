/**
 * The wire contract, in one file, before any implementation.
 *
 * Two rules run through all of it:
 *
 * - **Literal unions, not `string`.** `tier: MemoryTier` means an editor offers
 *   exactly four values and a typo is a compile error. `tier: string` means a
 *   runtime surprise instead.
 * - **Request and response types are separate.** A request has optional fields
 *   with defaults; a response has ids, timestamps and computed values. Deriving
 *   one from the other produces optional ids and a type that lies about both.
 *
 * Where a request value is constrained by a response value, it is written as a
 * reference (`RememberRequest["items"][number]["tier"]`) so the two cannot drift
 * apart when a new tier is added.
 */

export type MemoryTier = "L0" | "L1" | "L2" | "L3"

export type Impact = "low" | "medium" | "critical"

export type TensionStatus = "active" | "latent" | "resolved"

/** Why a memory body was included. Each reason costs differently. */
export type InclusionReason = "index" | "trigger" | "tension" | "guardrail"

/** Where a statement came from. `rules` means no model was involved. */
export type MemorySource = "rules" | "model" | "api"

export type Scope = "memories:read" | "memories:write" | "stats:read" | "keys:manage"

export interface Memory {
  id: string
  content: string
  gist?: string
  tier: MemoryTier
  domains: string[]
  accessCount: number
  source?: MemorySource
  sessionId?: string
  /** Which project this memory belongs to. Required for multi-project isolation. */
  projectId: string
  /** Which agent created this memory. Required for multi-agent isolation. */
  agentId: string
  /** Type of agent (e.g., "coding", "research", "support"). Optional. */
  agentType?: string
  /** Which library this memory belongs to. Null means the organisation-wide library.
   *  Derived from projectId + agentId when not explicitly set. */
  libraryId?: string | null
  /** Epoch milliseconds. */
  createdAt: number
  lastAccessedAt: number
}

export interface RecallHit {
  memory: Memory
  score: number
}

export interface ContextEntry {
  id: string
  tier: MemoryTier
  reason: InclusionReason
  gist: string
  /** Absent for `index` entries: a line is all those cost. */
  body?: string
  tokens: number
}

export interface ContextReport {
  /** Prepend this to the system prompt. Empty when there is nothing to say. */
  text: string
  entries: ContextEntry[]
  totalTokens: number
  /** True when the token budget forced something out. */
  truncated: boolean
}

export interface RejectedStatement {
  content: string
  reason: string
}

export interface LearnResult {
  /** Newly created. */
  stored: Memory[]
  /** Restatements folded into what was already held, and what survived. */
  mergedInto: Memory[]
  counts: {
    stored: number
    merged: number
    rejected: number
    tensions: number
    promoted: number
  }
  /** Never silent: a client that sent ten and got three needs the other seven. */
  rejected: RejectedStatement[]
}

export interface Claim {
  source: string
  statement: string
  timestamp: number
}

export interface Tension {
  id: string
  status: TensionStatus
  claimA: Claim
  claimB: Claim
  impact: Impact
  actionableQuestion: string
  resolvedBy?: string
  pattern?: string
}

export interface DomainCapability {
  reliabilityScore: number
  sampleCount: number
  knownFailurePatterns: string[]
  recommendedStrategies: string[]
}

export interface SelfModel {
  calibrationFactor: number
  activeDomains: string[]
  domains: Record<string, DomainCapability>
  /** Below the 75% line, a guardrail is injected into every context build. */
  weakDomains: string[]
}

export interface Health {
  ok: boolean
  service: string
  version: string
  /** `rules-only` means no model key is configured; learning is still on. */
  extractor: "rules-only" | "rules+model"
  limits: {
    maxTotalTokens: number
    maxIndexItems: number
    defaultRecallLimit: number
  }
  /** Non-empty only when a setting was present but unusable. */
  problems: string[]
}

export interface Stats {
  memories: {
    total: number
    byTier: Record<MemoryTier, number>
    byProject: Record<string, number>
    byAgent: Record<string, number>
    sessions: number
    firstStoredAt: number
    lastAccessedAt: number
  }
  tensions: { active: number }
  weakDomains: Array<{ domain: string; reliabilityScore: number; sampleCount: number }>
  recent: Memory[]
  activeTensions: Tension[]
}

/* -------------------------------------------------------------------------- */
/* Requests                                                                    */
/* -------------------------------------------------------------------------- */

export interface RememberRequest {
  items: Array<{
    content: string
    domains?: string[]
    tier?: MemoryTier
    /** Project this memory belongs to. Required. */
    projectId: string
    /** Agent that created this memory. Required. */
    agentId: string
    /** Type of agent (e.g., "coding", "research", "support"). Optional. */
    agentType?: string
  }>
  /** Groups memories from one conversation. */
  sessionId?: string
  /** Default projectId for items that don't specify one. */
  projectId?: string
  /** Default agentId for items that don't specify one. */
  agentId?: string
  /** Default agentType for items that don't specify one. */
  agentType?: string
  /** Which library to scope this operation to. Null means the organisation-wide library.
   *  @deprecated Use projectId + agentId instead. Kept for backward compatibility. */
  libraryId?: string | null
}

export interface ListMemoriesParams {
  limit?: number
  tier?: MemoryTier
  /** Filter by project. */
  projectId?: string
  /** Filter by agent. */
  agentId?: string
  /** Filter by agent type. */
  agentType?: string
  /** Which library to scope the list to. Null means the organisation-wide library.
   *  @deprecated Use projectId + agentId instead. Kept for backward compatibility. */
  libraryId?: string | null
}

export interface RecallRequest {
  query: string
  limit?: number
  /** Filter by project. */
  projectId?: string
  /** Filter by agent. */
  agentId?: string
  /** Filter by agent type. */
  agentType?: string
  /** Include memories from all agents in the project (opt-in cross-agent recall). */
  includeAllAgents?: boolean
  /** Which library to scope the recall to. Null means the organisation-wide library.
   *  @deprecated Use projectId + agentId instead. Kept for backward compatibility. */
  libraryId?: string | null
}

export interface RecallResponse {
  results: RecallHit[]
  /** True when nothing matched, so the model can admit ignorance. */
  empty: boolean
}

export interface TurnRequest {
  userMessage: string
  assistantResponse: string
  sessionId?: string
  /** Project this turn belongs to. */
  projectId?: string
  /** Agent processing this turn. */
  agentId?: string
}

export interface ContextRequest {
  /** The message about to be answered. Drives the triggers. */
  userMessage?: string
  /** Ids whose body to include regardless of tier. */
  forceFull?: string[]
  maxTokens?: number
  /** Project to scope the context build to. */
  projectId?: string
  /** Agent to scope the context build to. */
  agentId?: string
  /** Include memories from all agents in the project. */
  includeAllAgents?: boolean
}

export interface AddTensionRequest {
  claimA: string
  claimB: string
  impact?: Impact
  actionableQuestion: string
  /** Project this tension belongs to. */
  projectId?: string
  /** Agent this tension belongs to. */
  agentId?: string
}

export interface ResolveTensionRequest {
  resolvedBy: string
  /** The reusable pattern the resolution revealed. */
  pattern?: string
  /** Project this tension belongs to. */
  projectId?: string
  /** Agent this tension belongs to. */
  agentId?: string
}

export interface DomainOutcomeRequest {
  domain: string
  success: boolean
  failurePattern?: string
  strategy?: string
  /** Project this outcome belongs to. */
  projectId?: string
  /** Agent this outcome belongs to. */
  agentId?: string
}

/* -------------------------------------------------------------------------- */
/* Client configuration                                                        */
/* -------------------------------------------------------------------------- */

export interface CognitiveMemoryConfig {
  apiKey: string
  /**
   * Where the service is.
   *
   * Defaults to `COGNITIVE_MEMORY_URL`, then to the origin of the page in a
   * browser, then to the hosted service — in that order. The default is the
   * hosted service rather than `localhost`, because an agent that was not told
   * a base URL was never going to find the service on its own machine.
   */
  baseUrl?: string
  /** Per-request timeout in ms. */
  timeout?: number
  /** Retries for transient failures. 0 disables. */
  retry?: number
  /**
   * Log every request and response.
   *
   * On by default for anyone who has been burned by a wrong base URL, which is
   * everyone exactly once.
   */
  debug?: boolean
  headers?: Record<string, string>
  /** Default projectId for all requests. Required for multi-project isolation. */
  projectId?: string
  /** Default agentId for all requests. Required for multi-agent isolation. */
  agentId?: string
  /** Default agentType for all requests. */
  agentType?: string
}

/** The error envelope every non-2xx response carries. */
export interface CognitiveMemoryErrorBody {
  error: string
  message: string
  requiredScope?: string
  resource?: string
  id?: string
  issues?: string[]
}
