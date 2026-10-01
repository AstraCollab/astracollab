import { Schema } from "effect"

import { InclusionReason, MemoryTier, TensionImpact, TensionStatus } from "./memory"

/**
 * The wire contract.
 *
 * Every request body and query string is declared here as a schema, next to the
 * domain model rather than inside a handler, so the shape a client depends on
 * can be read in one place and validated the same way on every route. Unknown
 * fields are rejected rather than ignored: a typo in `limt` that is silently
 * dropped is a limit the caller believes they set.
 */

const NonEmpty = Schema.String.pipe(Schema.check(Schema.isMinLength(1)))
const ShortText = Schema.String.pipe(Schema.check(Schema.isMaxLength(200)))
const LongText = Schema.String.pipe(Schema.check(Schema.isMaxLength(4000)))

export const RememberBody = Schema.Struct({
  items: Schema.Array(
    Schema.Struct({
      content: LongText,
      domains: Schema.optional(Schema.Array(ShortText)),
      /** Which cache tier to file it under. Defaults to L1. */
      tier: Schema.optional(MemoryTier)
    })
  ).pipe(Schema.check(Schema.isMinLength(1))),
  /** Groups memories that came from one conversation. */
  sessionId: Schema.optional(Schema.String),
  /**
   * Fold restatements into what is already held. On by default: a storage layer
   * that accumulates paraphrases becomes unsearchable within a week.
   */
  reconcile: Schema.optional(Schema.Boolean)
})

export const RecallBody = Schema.Struct({
  query: NonEmpty.pipe(Schema.check(Schema.isMaxLength(2000))),
  limit: Schema.optional(Schema.Number)
})

export const TurnBody = Schema.Struct({
  userMessage: Schema.String.pipe(Schema.check(Schema.isMaxLength(20000))),
  assistantResponse: Schema.String.pipe(Schema.check(Schema.isMaxLength(20000))),
  sessionId: Schema.optional(Schema.String)
})

export const ContextBody = Schema.Struct({
  /** The message about to be answered. Drives the fast gate and the triggers. */
  userMessage: Schema.optional(Schema.String.pipe(Schema.check(Schema.isMaxLength(20000)))),
  /** Memory ids whose body should be included regardless of tier. */
  forceFull: Schema.optional(Schema.Array(Schema.String)),
  /** Override the service-wide injection budget for this call. */
  maxTokens: Schema.optional(Schema.Number),
  sessionId: Schema.optional(Schema.String)
})

export const TensionBody = Schema.Struct({
  claimA: LongText,
  claimB: LongText,
  impact: Schema.optional(TensionImpact),
  actionableQuestion: Schema.String.pipe(Schema.check(Schema.isMaxLength(500)))
})

export const ResolveTensionBody = Schema.Struct({
  resolvedBy: Schema.String.pipe(Schema.check(Schema.isMaxLength(200))),
  /** The reusable pattern the resolution revealed, if there was one. */
  pattern: Schema.optional(Schema.String.pipe(Schema.check(Schema.isMaxLength(1000))))
})

export const DomainOutcomeBody = Schema.Struct({
  domain: NonEmpty.pipe(Schema.check(Schema.isMaxLength(100))),
  success: Schema.Boolean,
  failurePattern: Schema.optional(Schema.String.pipe(Schema.check(Schema.isMaxLength(500)))),
  strategy: Schema.optional(Schema.String.pipe(Schema.check(Schema.isMaxLength(500))))
})

export const PromoteBody = Schema.Struct({ tier: MemoryTier })

export const IssueKeyBody = Schema.Struct({
  name: NonEmpty.pipe(Schema.check(Schema.isMaxLength(100))),
  scopes: Schema.optional(
    Schema.Array(Schema.Literals(["memories:read", "memories:write", "stats:read", "keys:manage"]))
  ),
  expiresInDays: Schema.optional(Schema.Number)
})

/** Memory as it goes out over the wire. */
export const MemoryView = Schema.Struct({
  id: Schema.String,
  content: Schema.String,
  gist: Schema.optional(Schema.String),
  tier: MemoryTier,
  domains: Schema.Array(Schema.String),
  accessCount: Schema.Number,
  source: Schema.optional(Schema.String),
  sessionId: Schema.optional(Schema.String),
  createdAt: Schema.Number,
  lastAccessedAt: Schema.Number
})

export const RecallHitView = Schema.Struct({
  memory: MemoryView,
  score: Schema.Number
})

export const ContextView = Schema.Struct({
  text: Schema.String,
  entries: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      tier: MemoryTier,
      reason: InclusionReason,
      gist: Schema.String,
      body: Schema.optional(Schema.String),
      tokens: Schema.Number
    })
  ),
  totalTokens: Schema.Number,
  truncated: Schema.Boolean
})

export const TensionView = Schema.Struct({
  id: Schema.String,
  status: TensionStatus,
  claimA: Schema.Struct({ source: Schema.String, statement: Schema.String, timestamp: Schema.Number }),
  claimB: Schema.Struct({ source: Schema.String, statement: Schema.String, timestamp: Schema.Number }),
  impact: TensionImpact,
  actionableQuestion: Schema.String,
  resolvedBy: Schema.optional(Schema.String),
  pattern: Schema.optional(Schema.String)
})

export type RememberBody = typeof RememberBody.Type
export type RecallBody = typeof RecallBody.Type
export type TurnBody = typeof TurnBody.Type
export type ContextBody = typeof ContextBody.Type
export type TensionBody = typeof TensionBody.Type
export type ResolveTensionBody = typeof ResolveTensionBody.Type
export type DomainOutcomeBody = typeof DomainOutcomeBody.Type
export type IssueKeyBody = typeof IssueKeyBody.Type
export type MemoryView = typeof MemoryView.Type
