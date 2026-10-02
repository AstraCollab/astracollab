import { createHash } from "node:crypto"

import { Context, Effect, Layer, Random, Result } from "effect"

import { mergeBudgets, settings, type EffectiveBudgets } from "../config"
import { InvalidRequest, NotFound, StorageFailure } from "../domain/errors"
import {
  Claim,
  DomainCapability,
  estimateTokens,
  gistOf,
  InclusionReason,
  KnowledgeTension,
  MemoryInjectionEntry,
  MemoryInjectionReport,
  MemoryItem,
  MemoryMetadata,
  MemorySource,
  MemoryTier,
  ProprioceptiveSelfModel
} from "../domain/memory"
import {
  CANDIDATE_FLOOR,
  COLLAPSE_THRESHOLD,
  extractDeterministic,
  extractIdentifiers,
  isInteractionScoped,
  isLossyRewrite,
  MAX_CANDIDATES,
  normalise,
  overlapScore,
  PROMOTE_THRESHOLD,
  relevanceTokens,
  runFastGate,
  similarity
} from "@astracollab/cogmem"
import { MemoryStore } from "../services/memory-store"
import { TurnExtractor } from "./turn-extractor"

/**
 * The memory engine: what a service should remember, what it should be told, and
 * what it just learned.
 *
 * The behaviour is ported from the in-process `CognitiveMemory`, but two things
 * changed and both are consequences of being a service:
 *
 * 1. **State is a database, not a Map.** Tiering still exists, but it is a
 *    column rather than four in-process caches, so two agents hitting the same
 *    tenant see the same memory and a deploy does not forget it.
 * 2. **Nothing is inferred from a "turn" the caller did not send.** The harness
 *    calls `postTurnAsync` after streaming a reply; a service cannot observe
 *    that, so the client posts the turn. The engine is the same, the trigger is
 *    the caller's job.
 */

/**
 * A stable id for a contradiction.
 *
 * The organisation is part of the hash, not just of the row. Ids derived from the
 * claims alone are a cross-tenant collision waiting to happen: two organisations
 * that hit the same disagreement produced the same primary key, and the second
 * to be written silently took over the first one's row.
 */
const tensionId = (organizationId: string, claimA: string, claimB: string): string =>
  createHash("sha256")
    .update(`${organizationId}\u0000${normalise(claimA)}\u0000${normalise(claimB)}`)
    .digest("hex")
    .slice(0, 24)

const emptySelfModel = (): ProprioceptiveSelfModel =>
  new ProprioceptiveSelfModel({ domains: {}, calibrationFactor: 1, activeDomains: [] })

const isDuplicateOf = (a: string, b: string): boolean => similarity(a, b) >= COLLAPSE_THRESHOLD

export interface RejectedStatement {
  readonly content: string
  readonly reason: string
}

export interface LearnOutcome {
  /** Newly created rows. */
  readonly stored: Array<MemoryItem>
  /**
   * Restatements that were folded into something already held, with the memory
   * that survived. Reported alongside `stored` rather than mixed into it, so a
   * client can tell "I added this" from "you already knew this".
   */
  readonly mergedInto: Array<MemoryItem>
  /** Folded into something already held, rather than stored twice. */
  readonly merged: number
  /**
   * Statements that were not stored, each with the reason. Reported rather than
   * dropped: a client that asked for ten facts and got three back needs to know
   * why the other seven are missing.
   */
  readonly rejected: Array<RejectedStatement>
  readonly tensions: number
  readonly promotions: number
}

export interface RecallHit {
  readonly item: MemoryItem
  readonly score: number
}

export interface MemoryEngineService {
  /** One memory, by id, for this tenant. */
  readonly get: (organizationId: string, id: string) => Effect.Effect<MemoryItem, NotFound | StorageFailure>

  /**
   * Store statements the caller states outright.
   *
   * `reconcile` defaults to true: near-duplicates are folded into what is
   * already held, because a storage layer that accumulates restatements becomes
   * unsearchable within a week.
   */
  readonly remember: (input: {
    readonly organizationId: string
    readonly items: ReadonlyArray<{ readonly content: string; readonly domains?: ReadonlyArray<string>; readonly tier?: MemoryTier }>
    readonly sessionId?: string | undefined
    readonly source?: MemorySource | undefined
    readonly reconcile?: boolean | undefined
  }) => Effect.Effect<LearnOutcome, StorageFailure | InvalidRequest>

  /**
   * Rank everything held against a query.
   *
   * Deterministic: no model, no embedding service, no ranking drift between
   * deploys. A memory layer whose recall quality changes with a provider's
   * availability is not a storage layer.
   */
  readonly recall: (input: {
    readonly organizationId: string
    readonly query: string
    readonly limit?: number | undefined
  }) => Effect.Effect<Array<RecallHit>, StorageFailure>

  /**
   * Build the block to prepend to a system prompt.
   *
   * Index by default, bodies on demand: a one-line index of everything held is
   * cheap, and a full body is spent only where a deterministic signal earned it.
   */
  readonly planContext: (input: {
    readonly organizationId: string
    readonly userMessage?: string | undefined
    readonly forceFull?: ReadonlyArray<string> | undefined
    readonly maxTokens?: number | undefined
  }) => Effect.Effect<MemoryInjectionReport, StorageFailure>

  /**
   * Learn from a completed turn, the way the harness does after a reply streams.
   *
   * Deterministic extraction runs first so a plainly-stated fact is captured
   * even when the model is unavailable, refuses, or returns nothing.
   */
  readonly learnFromTurn: (input: {
    readonly organizationId: string
    readonly userMessage: string
    readonly assistantResponse: string
    readonly sessionId?: string | undefined
  }) => Effect.Effect<LearnOutcome, StorageFailure | InvalidRequest>

  readonly listTensions: (
    organizationId: string,
    status?: KnowledgeTension["status"]
  ) => Effect.Effect<Array<KnowledgeTension>, StorageFailure>

  readonly addTension: (input: {
    readonly organizationId: string
    readonly claimA: string
    readonly claimB: string
    readonly impact?: KnowledgeTension["impact"]
    readonly actionableQuestion: string
  }) => Effect.Effect<KnowledgeTension, StorageFailure>

  readonly resolveTension: (input: {
    readonly organizationId: string
    readonly id: string
    readonly resolvedBy: string
    readonly pattern?: string | undefined
  }) => Effect.Effect<KnowledgeTension, NotFound | StorageFailure>

  readonly selfModel: (organizationId: string) => Effect.Effect<ProprioceptiveSelfModel, StorageFailure>

  /**
   * Record how a domain went, which is what turns "the agent is unreliable at
   * migrations" into a guardrail in the next prompt.
   */
  readonly recordDomainOutcome: (input: {
    readonly organizationId: string
    readonly domain: string
    readonly success: boolean
    readonly failurePattern?: string | undefined
    readonly strategy?: string | undefined
  }) => Effect.Effect<DomainCapability, StorageFailure>

  readonly forget: (organizationId: string, id: string) => Effect.Effect<boolean, StorageFailure>
  readonly list: (organizationId: string, options?: { readonly tiers?: ReadonlyArray<MemoryTier>; readonly limit?: number }) => Effect.Effect<Array<MemoryItem>, StorageFailure>
  readonly promote: (organizationId: string, id: string, tier: MemoryTier) => Effect.Effect<void, NotFound | StorageFailure>

  /**
   * Edit what a memory says.
   *
   * Deliberately narrow: identity, creation time and access counters are not
   * editable, so a rewritten memory keeps the history of how often it was
   * actually used. An "edit" that resets `lastAccessedAt` would quietly demote a
   * memory that was in every prompt, which is the opposite of what editing a
   * memory is for.
   */
  readonly edit: (
    organizationId: string,
    id: string,
    patch: {
      readonly content?: string | undefined
      readonly gist?: string | undefined
      readonly domains?: ReadonlyArray<string> | undefined
    }
  ) => Effect.Effect<MemoryItem, NotFound | StorageFailure | InvalidRequest>

  /** A page of memories with the counts behind the filters, for the library. */
  readonly page: (
    organizationId: string,
    query: {
      readonly text?: string | undefined
      readonly tiers?: ReadonlyArray<string> | undefined
      readonly domain?: string | undefined
      readonly source?: string | undefined
      readonly sort?: "recent" | "created" | "accessed" | "alpha" | undefined
      readonly limit?: number | undefined
      readonly offset?: number | undefined
    }
  ) => Effect.Effect<
    {
      readonly rows: Array<MemoryItem>
      readonly total: number
      readonly offset: number
      readonly limit: number
      readonly facets: {
        readonly tiers: Record<string, number>
        readonly sources: Record<string, number>
        readonly domains: ReadonlyArray<{ readonly name: string; readonly count: number }>
      }
    },
    StorageFailure
  >

  /** Tier change or deletion across a selection. Returns how many rows moved. */
  readonly applyTo: (
    organizationId: string,
    ids: ReadonlyArray<string>,
    action: "forget" | { readonly tier: MemoryTier }
  ) => Effect.Effect<number, StorageFailure>

  /**
   * Forget every memory this organisation holds.
   *
   * The danger zone. Memories only — keys, contradictions and the self-model
   * survive, because "start the memory over" and "revoke every credential" are
   * separate decisions and a button that did both would be one nobody presses.
   */
  readonly forgetEverything: (organizationId: string) => Effect.Effect<number, StorageFailure>

  /** Reopen a resolved contradiction, or put a latent one back to active. */
  readonly setTensionStatus: (
    organizationId: string,
    id: string,
    status: KnowledgeTension["status"]
  ) => Effect.Effect<KnowledgeTension, NotFound | StorageFailure>

  readonly forgetTension: (organizationId: string, id: string) => Effect.Effect<boolean, StorageFailure>

  /**
   * Forget a domain entirely: its score, its guardrail, and its samples.
   *
   * All three, because a reset that left the history behind would let the score
   * rebuild from the same evidence that produced the wrong one.
   */
  readonly forgetDomain: (
    organizationId: string,
    domain: string
  ) => Effect.Effect<{ readonly samples: number }, StorageFailure>

  /** The budgets in force for this organisation, overrides included. */
  readonly budgets: (organizationId: string) => Effect.Effect<EffectiveBudgets, StorageFailure>

  /**
   * Recall with the reason attached.
   *
   * The score alone is the gap this service claims to close: "why did this
   * match" is answerable because ranking is token overlap, so the overlapping
   * terms can be named instead of guessed at.
   */
  readonly explainRecall: (
    input: {
      readonly organizationId: string
      readonly query: string
      readonly limit?: number | undefined
    }
  ) => Effect.Effect<
    ReadonlyArray<{
      readonly item: MemoryItem
      readonly score: number
      readonly matched: ReadonlyArray<string>
    }>,
    StorageFailure
  >

  /**
   * Memories similar enough to a candidate that a restatement should be folded
   * in rather than stored twice.
   */
  readonly candidatesFor: (organizationId: string, content: string) => Effect.Effect<Array<MemoryItem>, StorageFailure>
}

/** Ids that are unique per row and readable in a log. */
const newId = (prefix: string): Effect.Effect<string> =>
  Effect.gen(function*() {
    const suffix = yield* Random.nextInt
    const noise = yield* Random.nextInt
    return `${prefix}-${suffix.toString(36)}${noise.toString(36).padStart(4, "0")}${Date.now().toString(36)}`
  })

const makeMemoryEngine = Effect.gen(function*() {
  const store = yield* MemoryStore
  const config = yield* settings
  const extractor = yield* TurnExtractor

  const now = Effect.clockWith((clock) => clock.currentTimeMillis)

  /**
   * The budgets for one organisation.
   *
   * Read per call rather than captured once: the dashboard can change a
   * deployment's budget at runtime, and a value cached in the layer would keep
   * applying the old one until the next deploy — which is exactly the kind of
   * "I changed it and nothing happened" that erodes trust in a tuning knob.
   */
  const budgetsFor = (organizationId: string): Effect.Effect<EffectiveBudgets, StorageFailure> =>
    store.getSettings(organizationId).pipe(
      Effect.map(
        (overrides) =>
          mergeBudgets(
            config,
            overrides ?? {
              maxTotalTokens: null,
              maxIndexItems: null,
              defaultRecallLimit: null
            }
          )
      )
    )

  /**
   * Store one statement, folding it into something already held when it is a
   * restatement of it.
   *
   * The bias is deliberate and is the single most important decision in this
   * file: when in doubt, keep both. An unmerged duplicate costs one row. A wrong
   * merge rewrites a fact and the qualifier that made the two statements differ
   * is gone for good.
   */
  const storeStatement = (
    organizationId: string,
    statement: {
      readonly content: string
      readonly domains: ReadonlyArray<string>
      readonly source: MemorySource
      readonly sessionId?: string | undefined
      readonly tier?: MemoryTier | undefined
    }
  ): Effect.Effect<
    | { readonly stored: MemoryItem; readonly merged: false; readonly mergedInto?: undefined }
    | { readonly stored: null; readonly merged: true; readonly mergedInto: MemoryItem },
    InvalidRequest | NotFound | StorageFailure
  > =>
    Effect.gen(function*() {
      const content = statement.content.trim()
      if (content.length < 3) {
        return yield* new InvalidRequest({ message: "A memory needs at least 3 characters." })
      }
      if (content.length > 4000) {
        return yield* new InvalidRequest({ message: "A memory is capped at 4000 characters." })
      }
      if (isInteractionScoped(content)) {
        return yield* new InvalidRequest({
          message: "That describes how to behave in one conversation, not a durable fact, so it was not stored."
        })
      }

      const at = yield* now
      const similar = yield* candidatesFor(organizationId, content)

      if (similar.length > 0) {
        const exact = similar.find((item) => normalise(item.content) === normalise(content))
        if (exact) {
          // A byte-identical restatement is never worth a second row. Refresh
          // the survivor's recency so what the caller just said stays warm.
          yield* store.touch(organizationId, exact.id, at)
          return { stored: null, merged: true, mergedInto: exact }
        }
      }

      const id = yield* newId("mem")
      const item = yield* store.insertMemory(organizationId, {
        id,
        content,
        bookmark: content.slice(0, 200),
        tier: statement.tier ?? "L1",
        domains: statement.domains,
        now: at,
        source: statement.source,
        ...(statement.sessionId === undefined ? {} : { sessionId: statement.sessionId })
      })
      return { stored: item, merged: false }
    })

  const candidatesFor: MemoryEngineService["candidatesFor"] = (organizationId, content) =>
    Effect.gen(function*() {
      const pool = yield* store.activeMemories(organizationId, 200)
      const needle = new Set([...relevanceTokens(content)])
      const scored = pool
        .map((item) => ({
          item,
          exact: normalise(item.content) === normalise(content),
          score: overlapScore(
            needle,
            new Set([...relevanceTokens(`${item.content} ${item.metadata.domains.join(" ")}`)])
          )
        }))
        .filter((entry) => entry.exact || entry.score >= CANDIDATE_FLOOR)
        .sort((a, b) => Number(b.exact) - Number(a.exact) || b.score - a.score)
      return scored.slice(0, MAX_CANDIDATES).map((entry) => entry.item)
    })

  /**
   * Fold a restatement into its survivor, refusing a rewrite that drops anything.
   *
   * A merge has to carry everything either side held, so both statements are
   * checked — dropping the *incoming* qualifier loses it just as permanently as
   * dropping the survivor's.
   */
  const mergeInto = (
    organizationId: string,
    survivor: MemoryItem,
    replacement: string,
    duplicate: { readonly text: string; readonly storedId: string | null },
    at: number
  ): Effect.Effect<boolean, StorageFailure> =>
    Effect.gen(function*() {
      if (isLossyRewrite(survivor.content, replacement) || isLossyRewrite(duplicate.text, replacement)) {
        return false
      }
      // Remove the duplicate BEFORE rewriting the survivor: afterwards the two
      // hold the same text, so a by-content delete would match both.
      if (duplicate.storedId !== null) {
        yield* store.deleteMemory(organizationId, duplicate.storedId)
      }
      yield* store.updateContent(organizationId, survivor.id, replacement, replacement.slice(0, 200), at)
      return true
    })

  const remember: MemoryEngineService["remember"] = (input) =>
    Effect.gen(function*() {
      const stored: Array<MemoryItem> = []
      const mergedInto: Array<MemoryItem> = []
      const rejected: Array<RejectedStatement> = []
      let merged = 0

      for (const statement of input.items) {
        const result = yield* storeStatement(input.organizationId, {
          content: statement.content,
          domains: statement.domains ?? [],
          source: input.source ?? "api",
          ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
          ...(statement.tier === undefined ? {} : { tier: statement.tier })
        }).pipe(Effect.result)

        // A refused statement is not a failure for the whole batch: the other
        // nine are still worth storing, and the caller is told which one and why.
        if (Result.isFailure(result)) {
          rejected.push({ content: statement.content, reason: result.failure.message })
          continue
        }

        if (result.success.merged) {
          merged += 1
          mergedInto.push(result.success.mergedInto)
          continue
        }
        stored.push(result.success.stored)
      }

      return { stored, mergedInto, merged, rejected, tensions: 0, promotions: 0 }
    })

const recall: MemoryEngineService["recall"] = (input) =>
    Effect.gen(function* () {
      const budgets = yield* budgetsFor(input.organizationId)
      const limit = Math.min(Math.max(input.limit ?? budgets.defaultRecallLimit, 1), 50)
      const query = relevanceTokens(input.query)
      if (query.size === 0) return []

      const pool = yield* store.activeMemories(input.organizationId, 400)
      const scored = pool
        .map((item) => ({
          item,
          score: overlapScore(
            query,
            relevanceTokens(`${item.content} ${item.metadata.domains.join(" ")}`)
          )
        }))
        .filter((entry) => entry.score > 0)
        .sort((a, b) => b.score - a.score || a.item.content.length - b.item.content.length)

      // Collapse paraphrases of the same fact to the best-scoring instance, so a
      // result list is not three phrasings of one rule.
      const seen: Array<string> = []
      const out: Array<RecallHit> = []
      for (const entry of scored) {
        if (seen.some((existing) => isDuplicateOf(existing, entry.item.content))) continue
        seen.push(entry.item.content)
        out.push({ item: entry.item, score: entry.score })
        if (out.length >= limit) break
      }
      return out
    })

const planContext: MemoryEngineService["planContext"] = (input) =>
    Effect.gen(function* () {
      const budgets = yield* budgetsFor(input.organizationId)
      const budget = input.maxTokens ?? budgets.maxTotalTokens
      const sections: Array<string> = []
      const entries: Array<MemoryInjectionEntry> = []
      let used = 0
      let truncated = false

      // A body is spent where a deterministic signal earned it. The signal here
      // is the caller's message naming something concrete — a build id, a host,
      // a path — that a memory mentions. No model is asked whether that matters,
      // and nothing is left to the caller to remember to do.
      const force = new Set(input.forceFull ?? [])
      if (input.userMessage) {
        for (const identifier of extractIdentifiers(input.userMessage)) {
          const needle = identifier.toLowerCase()
          for (const item of yield* store.activeMemories(input.organizationId, budgets.maxIndexItems)) {
            if (item.content.toLowerCase().includes(needle)) force.add(item.id)
          }
        }
      }

      const include = (
        item: {
          readonly id: string
          readonly content: string
          readonly bookmark: string
          readonly gist?: string | undefined
          readonly metadata: MemoryMetadata
          readonly tier: MemoryTier
        },
        reason: InclusionReason,
        withBody: boolean
      ): void => {
        const gist = gistOf(item)
        const body = withBody ? item.content : undefined
        const tags = item.metadata.domains.slice(0, 3)
        const suffix = tags.length > 0 ? ` (${tags.join(", ")})` : ""
        const tokens = estimateTokens(`${gist}${suffix}${body ?? ""}`)
        if (used + tokens > budget) {
          truncated = true
          return
        }
        used += tokens
        entries.push(
          new MemoryInjectionEntry({ id: item.id, tier: item.tier, reason, gist, ...(body === undefined ? {} : { body }), tokens })
        )
      }

      // 1. Fast gate: a correction in what the caller just said.
      if (input.userMessage) {
        const gate = runFastGate(input.userMessage)
        if (gate.action === "inject_caution" && gate.cautionNote) {
          sections.push(`### ⚠️ Correction Detected In This Message\n${gate.cautionNote}`)
        }
      }

      // 2. Weak-domain warnings: domains this agent keeps getting wrong.
      const selfModel = yield* store.getSelfModel(input.organizationId)
      const weak = selfModel.activeDomains
        .map((domain) => ({ domain, capability: selfModel.domains[domain] }))
        .filter((entry) => entry.capability && entry.capability.reliabilityScore < 0.75)
      if (weak.length > 0) {
        const lines: Array<string> = []
        for (const { domain, capability } of weak) {
          const cap = capability!
          const pitfalls = cap.knownFailurePatterns.join("; ")
          const approach = cap.recommendedStrategies.join("; ")
          include(
            {
              id: `guardrail-${domain}`,
              content: `${domain}: reliability ${Math.round(cap.reliabilityScore * 100)}% over ${cap.sampleCount} tasks.${
                pitfalls ? ` Known pitfalls: ${pitfalls}` : ""
              }${approach ? ` Approach: ${approach}` : ""}`,
              bookmark: `${domain} weak domain`,
              metadata: new MemoryMetadata({ domains: [domain], createdAt: 0, lastAccessedAt: 0, accessCount: 0 }),
              tier: "L0"
            },
            "guardrail",
            true
          )
          lines.push(`- ${domain} (${Math.round(cap.reliabilityScore * 100)}% reliable): ${pitfalls || "be careful"}`)
        }
        sections.push(`### Weak Domains — Under 75% Reliability\n${lines.join("\n")}`)
      }

      // 3. The index: one line per memory, bodies withheld unless a trigger earned them.
      const pool = yield* store.activeMemories(input.organizationId, budgets.maxIndexItems)
      const indexLines: Array<string> = []
      for (const item of pool) {
        const tags = item.metadata.domains.slice(0, 3)
        const suffix = tags.length > 0 ? ` (${tags.join(", ")})` : ""
        if (force.has(item.id)) {
          include(item, "trigger", true)
          indexLines.push(`- ${item.content}${suffix}`)
        } else {
          include(item, "index", false)
          indexLines.push(`- ${gistOf(item)}${suffix}`)
        }
      }
      if (indexLines.length > 0) {
        sections.push(
          [
            "### Memory index — established earlier in this project",
            "One line per remembered item. Ask for the full item when a line is not enough, and treat it as true.",
            ...indexLines
          ].join("\n")
        )
      }

      // 4. Unresolved contradictions earn full bodies: they are prompts to clarify, not trivia.
      const tensions = yield* store.listTensions(input.organizationId, "active")
      if (tensions.length > 0) {
        const lines = tensions.map((tension) => {
          include(
            {
              id: tension.id,
              content: `${tension.claimA.statement} vs ${tension.claimB.statement} — ${tension.actionableQuestion}`,
              bookmark: tension.claimA.statement,
              metadata: new MemoryMetadata({ domains: [], createdAt: tension.claimA.timestamp, lastAccessedAt: 0, accessCount: 0 }),
              tier: "L0"
            },
            "tension",
            true
          )
          return `- [${tension.impact.toUpperCase()}] "${tension.claimA.statement}" conflicts with "${tension.claimB.statement}". Ask: ${tension.actionableQuestion}`
        })
        sections.push(`### Unresolved Contradictions\n${lines.join("\n")}`)
      }

      return new MemoryInjectionReport({
        text: sections.length > 0 ? `\n## Memory\n${sections.join("\n\n")}\n` : "",
        entries,
        totalTokens: used,
        truncated
      })
    })

  const learnFromTurn: MemoryEngineService["learnFromTurn"] = (input) =>
    Effect.gen(function*() {
      const at = yield* now

      // A question is a lookup, not a lesson. Extracting from recall turns stored
      // the assistant's own answers back as memories, which duplicated facts and
      // evicted the real ones.
      if (input.userMessage.includes("?")) {
        return { stored: [], mergedInto: [], merged: 0, rejected: [], tensions: 0, promotions: 0 }
      }

      // Deterministic first, so a plainly-stated fact is captured even if the
      // model refuses, hedges, or returns nothing.
      const rules = extractDeterministic(input.userMessage)
      const overrides = yield* store.getSettings(input.organizationId)
      const extracted = yield* extractor.extract({
        userMessage: input.userMessage,
        assistantResponse: input.assistantResponse,
        allowModel: overrides?.extraction !== "rules"
      })

      const statements = [
        ...rules.map((rule) => ({ content: rule.content, domains: rule.domains, source: "rules" as const })),
        ...extracted.memories.map((memory) => ({
          content: memory.content,
          domains: memory.domains ?? [],
          source: "model" as const
        }))
      ]

      const stored: Array<MemoryItem> = []
      const mergedInto: Array<MemoryItem> = []
      const rejected: Array<RejectedStatement> = []
      let merged = 0
      /** Held for one batched adjudication rather than one model call per item. */
      const pending: Array<{ readonly content: string; readonly survivors: Array<MemoryItem>; readonly storedId: string }> = []

      for (const statement of statements) {
        const result = yield* storeStatement(input.organizationId, {
          content: statement.content,
          domains: statement.domains,
          source: statement.source,
          ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId })
        }).pipe(Effect.result)

        if (Result.isFailure(result)) {
          rejected.push({ content: statement.content, reason: result.failure.message })
          continue
        }
        if (result.success.merged) {
          merged += 1
          mergedInto.push(result.success.mergedInto)
          continue
        }
        const item = result.success.stored
        stored.push(item)

        const survivors = yield* candidatesFor(input.organizationId, statement.content)
        if (survivors.length > 0) {
          pending.push({ content: statement.content, survivors, storedId: item.id })
        }
      }

      // One adjudication call for the whole turn. A failure keeps both sides, so a
      // flaky model costs duplicates and never lost information.
      if (pending.length > 0) {
        const verdicts = yield* extractor.reconcile({
          items: pending.map((entry) => ({
            candidate: entry.content,
            remember: entry.survivors.map((survivor) => survivor.content)
          }))
        })

        for (const [index, verdict] of verdicts.entries()) {
          const entry = pending[index]
          if (!entry || !verdict) continue
          if (verdict.action === "reject") {
            yield* store.deleteMemory(input.organizationId, entry.storedId)
            const at2 = stored.findIndex((item) => item.id === entry.storedId)
            if (at2 >= 0) stored.splice(at2, 1)
            continue
          }
          if (verdict.action === "merge" || verdict.action === "replace") {
            const survivor = entry.survivors[0]
            const replacement = verdict.content?.trim() || entry.content
            if (!survivor) continue
            const mergedOk =
              verdict.action === "merge"
                ? yield* mergeInto(input.organizationId, survivor, replacement, { text: entry.content, storedId: entry.storedId }, at)
                : (yield* supersede(input.organizationId, entry.survivors, entry.storedId, replacement, at))
            if (mergedOk) {
              const at2 = stored.findIndex((item) => item.id === entry.storedId)
              if (at2 >= 0) stored.splice(at2, 1)
            }
          }
        }
      }

      // Tensions: a contradiction is worth more than either claim alone.
      let tensionCount = 0
      for (const tension of extracted.tensions ?? []) {
        const existing = yield* store.listTensions(input.organizationId)
        if (existing.some((row) => normalise(row.claimA.statement) === normalise(tension.claimA) && normalise(row.claimB.statement) === normalise(tension.claimB))) {
          continue
        }
        yield* store.upsertTension(
          new KnowledgeTension({
            id: tensionId(input.organizationId, tension.claimA, tension.claimB),
            organizationId: input.organizationId,
            status: "active",
            claimA: new Claim({ source: "user", statement: tension.claimA, timestamp: at }),
            claimB: new Claim({ source: "conversation", statement: tension.claimB, timestamp: at }),
            impact: tension.impact,
            taskRelevance: 1,
            actionableQuestion: tension.actionableQuestion
          }),
          at
        )
        tensionCount += 1
      }

      // Promotion: keep what the caller just used warm.
      const promotions = yield* promoteByRelevance(input.organizationId, input.userMessage, input.assistantResponse)

      return { stored, mergedInto, merged, rejected, tensions: tensionCount, promotions }
    })

  /** `replace` supersedes the old entries rather than keeping both. */
  const supersede = (
    organizationId: string,
    victims: ReadonlyArray<MemoryItem>,
    storedId: string,
    replacement: string,
    at: number
  ): Effect.Effect<boolean, StorageFailure> =>
    Effect.gen(function*() {
      if (isLossyRewrite(victims[0]?.content ?? replacement, replacement)) return false
      for (const victim of victims) {
        if (victim.id === storedId) continue
        yield* store.deleteMemory(organizationId, victim.id)
      }
      yield* store.updateContent(organizationId, storedId, replacement, replacement.slice(0, 200), at)
      return true
    })

  const promoteByRelevance = (organizationId: string, userMessage: string, assistantResponse: string) =>
    Effect.gen(function*() {
      const turn = relevanceTokens(`${userMessage} ${assistantResponse}`)
      if (turn.size === 0) return 0
      const pool = yield* store.listMemories(organizationId, { tiers: ["L2", "L3"], limit: 40 })
      let promoted = 0
      for (const item of pool) {
        const score = overlapScore(
          turn,
          relevanceTokens(`${item.bookmark} ${item.metadata.domains.join(" ")}`)
        )
        if (score > PROMOTE_THRESHOLD) {
          yield* store.setTier(organizationId, item.id, "L1")
          promoted += 1
        }
      }
      return promoted
    })

  const get: MemoryEngineService["get"] = (organizationId, id) => store.getMemory(organizationId, id)

  const list: MemoryEngineService["list"] = (organizationId, options = {}) =>
    Effect.map(store.listMemories(organizationId, options), (items) => items)

  const forget: MemoryEngineService["forget"] = (organizationId, id) => store.deleteMemory(organizationId, id)

  const promote: MemoryEngineService["promote"] = (organizationId, id, tier) =>
    Effect.gen(function*() {
      yield* store.getMemory(organizationId, id)
      yield* store.setTier(organizationId, id, tier)
    })

  const listTensions: MemoryEngineService["listTensions"] = (organizationId, status) =>
    Effect.map(store.listTensions(organizationId, status), (rows) => rows)

  const edit: MemoryEngineService["edit"] = (organizationId, id, patch) =>
    Effect.gen(function* () {
      const at = yield* now
      const content = patch.content?.trim()
      if (patch.content !== undefined && (content === undefined || content.length < 3)) {
        return yield* new InvalidRequest({ message: "A memory needs at least 3 characters." })
      }
      if (content !== undefined && content.length > 4000) {
        return yield* new InvalidRequest({ message: "A memory is capped at 4000 characters." })
      }
      return yield* store.editMemory(
        organizationId,
        id,
        {
          ...(content === undefined ? {} : { content }),
          ...(patch.gist === undefined ? {} : { gist: patch.gist.trim().slice(0, 200) }),
          ...(patch.domains === undefined ? {} : { domains: patch.domains })
        },
        at
      )
    })

  const page: MemoryEngineService["page"] = (organizationId, query) => store.memoryPage(organizationId, query)

  const applyTo: MemoryEngineService["applyTo"] = (organizationId, ids, action) =>
    store.applyToMemories(organizationId, ids, action)

  const forgetEverything: MemoryEngineService["forgetEverything"] = (organizationId) =>
    store.deleteEveryMemory(organizationId)

  const setTensionStatus: MemoryEngineService["setTensionStatus"] = (organizationId, id, status) =>
    store.setTensionStatus(organizationId, id, status)

  const forgetTension: MemoryEngineService["forgetTension"] = (organizationId, id) =>
    store.deleteTension(organizationId, id)

  const forgetDomain: MemoryEngineService["forgetDomain"] = (organizationId, domain) =>
    Effect.gen(function* () {
      const at = yield* now
      const model = yield* store.getSelfModel(organizationId)
      // Filtered rather than destructured-and-ignored: a bare `_dropped` binding
      // is the kind of leftover that reads like a mistake to the next person.
      const domains = Object.fromEntries(
        Object.entries(model.domains).filter(([entry]) => entry !== domain)
      )
      yield* store.putSelfModel(
        organizationId,
        new ProprioceptiveSelfModel({
          domains,
          calibrationFactor: model.calibrationFactor,
          activeDomains: model.activeDomains.filter((entry) => entry !== domain)
        }),
        at
      )
      return { samples: yield* store.deleteOutcomeHistory(organizationId, domain) }
    })

  const budgets: MemoryEngineService["budgets"] = (organizationId) => budgetsFor(organizationId)

  /**
   * Recall, with the terms that did the matching.
   *
   * `relevanceTokens` is the same function the ranking uses, so `matched` is the
   * actual reason rather than a keyword highlight drawn after the fact.
   */
  const explainRecall: MemoryEngineService["explainRecall"] = (input) =>
    Effect.gen(function* () {
      const query = relevanceTokens(input.query)
      if (query.size === 0) return []
      const hits = yield* recall(input)
      return hits.map((hit) => {
        const own = relevanceTokens(`${hit.item.content} ${hit.item.metadata.domains.join(" ")}`)
        return {
          item: hit.item,
          score: hit.score,
          matched: [...own].filter((token) => query.has(token)).sort()
        }
      })
    })

  const addTension: MemoryEngineService["addTension"] = (input) =>
    Effect.gen(function*() {
      const at = yield* now
      return yield* store.upsertTension(
        new KnowledgeTension({
          id: tensionId(input.organizationId, input.claimA, input.claimB),
          organizationId: input.organizationId,
          status: "active",
          claimA: new Claim({ source: "user", statement: input.claimA, timestamp: at }),
          claimB: new Claim({ source: "api", statement: input.claimB, timestamp: at }),
          impact: input.impact ?? "medium",
          taskRelevance: 1,
          actionableQuestion: input.actionableQuestion
        }),
        at
      )
    })

  const resolveTension: MemoryEngineService["resolveTension"] = (input) =>
    Effect.gen(function*() {
      const at = yield* now
      return yield* store.resolveTension(input.organizationId, input.id, {
        resolvedAt: at,
        resolvedBy: input.resolvedBy,
        pattern: input.pattern ?? ""
      })
    })

  const selfModel: MemoryEngineService["selfModel"] = (organizationId) =>
    Effect.map(store.getSelfModel(organizationId), (model) => model ?? emptySelfModel())

  const recordDomainOutcome: MemoryEngineService["recordDomainOutcome"] = (input) =>
    Effect.gen(function*() {
      const at = yield* now
      const model = yield* store.getSelfModel(input.organizationId)
      const current = model.domains[input.domain] ?? {
        reliabilityScore: 0.8,
        sampleCount: 0,
        knownFailurePatterns: [],
        recommendedStrategies: []
      }
      const sampleCount = current.sampleCount + 1
      // Moving average, with a prior of two samples rather than none.
      //
      // The naive version divides by the sample count, so the first outcome
      // fully replaces the starting estimate: one failed task takes a domain
      // from 0.8 to 0, which then trips the guardrail threshold and injects a
      // "be careful with database work" notice into every prompt for ever. The
      // prior means one failure is a strong signal and ten failures are
      // conclusive, which is what a reliability number should mean.
      const weight = 1 / (Math.min(sampleCount, 10) + 2)
      const reliabilityScore = Number(
        (current.reliabilityScore * (1 - weight) + (input.success ? 1 : 0) * weight).toFixed(3)
      )
      const knownFailurePatterns =
        !input.success && input.failurePattern && !current.knownFailurePatterns.includes(input.failurePattern)
          ? [...current.knownFailurePatterns, input.failurePattern]
          : current.knownFailurePatterns
      const recommendedStrategies =
        input.success && input.strategy && !current.recommendedStrategies.includes(input.strategy)
          ? [...current.recommendedStrategies, input.strategy]
          : current.recommendedStrategies

      const next = new DomainCapability({
        reliabilityScore,
        sampleCount,
        knownFailurePatterns,
        recommendedStrategies
      })
      const updated = new ProprioceptiveSelfModel({
        domains: { ...model.domains, [input.domain]: next },
        calibrationFactor: model.calibrationFactor,
        activeDomains: model.activeDomains.includes(input.domain)
          ? model.activeDomains
          : [...model.activeDomains, input.domain]
      })
      yield* store.putSelfModel(input.organizationId, updated, at)
      // The sample, not just the score. `self_models` holds the moving average,
      // which cannot show you that a domain recovered — only the individual
      // outcomes can.
      yield* store.recordOutcome({
        id: yield* newId("out"),
        organizationId: input.organizationId,
        domain: input.domain,
        success: input.success,
        ...(input.failurePattern === undefined ? {} : { failurePattern: input.failurePattern }),
        ...(input.strategy === undefined ? {} : { strategy: input.strategy }),
        now: at
      })
      return next
    })

  const service: MemoryEngineService = {
    get,
    remember,
    recall,
    planContext,
    learnFromTurn,
    listTensions,
    addTension,
    resolveTension,
    selfModel,
    recordDomainOutcome,
    forget,
    list,
    promote,
    edit,
    page,
    applyTo,
    forgetEverything,
    setTensionStatus,
    forgetTension,
    forgetDomain,
    budgets,
    explainRecall,
    candidatesFor
  }

  return service
})

export class MemoryEngine extends Context.Service<MemoryEngine, MemoryEngineService>()(
  "cognitive-memory/MemoryEngine"
) {
  static readonly layer = Layer.effect(MemoryEngine, makeMemoryEngine)
}

/**
 * The engine and the extractor that serves it.
 *
 * The store and the database are deliberately *not* provided here: they are
 * provided once at the composition root, so a test can swap the database without
 * the engine quietly holding a second connection to the real one.
 */
export const engineLayer = MemoryEngine.layer.pipe(Layer.provide(TurnExtractor.layer))
