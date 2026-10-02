import { OpenAiClient, OpenAiLanguageModel } from "@effect/ai-openai"
import { LanguageModel } from "effect/ai"
import { Context, Effect, Layer, Redacted, Schema } from "effect"
import { FetchHttpClient } from "effect/http"

import { settings } from "../config"

/**
 * Learning from a turn, and deciding what to do about a restatement.
 *
 * Both halves are optional. With no model key configured this degrades to
 * nothing at all, and the caller is left with the deterministic rules in
 * `./rules.ts` — which is the point: memory has to work on a deployment with no
 * model provider, or it is not a storage layer, it is a demo.
 *
 * `effect/ai` is used rather than raw `generateObject` calls because a schema
 * here is the contract with a third party that will occasionally return
 * malformed JSON; letting the library validate and retry is the difference
 * between a bad extraction and a failed request.
 */

const Impact = Schema.Literals(["low", "medium", "critical"])

const ExtractedTurn = Schema.Struct({
  memories: Schema.Array(
    Schema.Struct({
      content: Schema.String,
      domains: Schema.optional(Schema.Array(Schema.String))
    })
  ),
  tensions: Schema.optional(
    Schema.Array(
      Schema.Struct({
        claimA: Schema.String,
        claimB: Schema.String,
        impact: Impact,
        actionableQuestion: Schema.String
      })
    )
  )
})

const ReconciliationAction = Schema.Literals(["add", "merge", "replace", "reject"])

const ReconciledTurn = Schema.Struct({
  verdicts: Schema.Array(
    Schema.Struct({
      /** Which candidate this verdict is about. Models often omit it and rely on order. */
      index: Schema.optional(Schema.Number),
      action: ReconciliationAction,
      content: Schema.optional(Schema.String),
      reason: Schema.optional(Schema.String)
    })
  )
})

export interface TurnExtraction {
  readonly memories: ReadonlyArray<{ readonly content: string; readonly domains: ReadonlyArray<string> }>
  readonly tensions: ReadonlyArray<{
    readonly claimA: string
    readonly claimB: string
    readonly impact: "low" | "medium" | "critical"
    readonly actionableQuestion: string
  }>
}

export interface Reconciliation {
  readonly action: "add" | "merge" | "replace" | "reject"
  readonly content?: string | undefined
  readonly reason?: string | undefined
}

export interface TurnExtractorService {
  /**
   * Pull durable facts out of a finished turn.
   *
   * `allowModel: false` keeps the call entirely on the deterministic rules, which
   * is how an organisation opts out of paying for extraction without the
   * deployment having to remove the model key from under every other tenant.
   */
  readonly extract: (turn: {
    readonly userMessage: string
    readonly assistantResponse: string
    readonly allowModel?: boolean | undefined
  }) => Effect.Effect<TurnExtraction>
  readonly reconcile: (input: {
    readonly items: ReadonlyArray<{ readonly candidate: string; readonly remember: ReadonlyArray<string> }>
  }) => Effect.Effect<Array<Reconciliation>>
  /** "rules+model" when a key is configured, "rules-only" otherwise. */
  readonly mode: Effect.Effect<"rules-only" | "rules+model">
}

const EMPTY_TURN: TurnExtraction = { memories: [], tensions: [] }

const clip = (value: string, max: number): string => (value.length > max ? `${value.slice(0, max)}…` : value)

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
- Skip anything already obvious from the repository, anything one-off to this task, and
  anything the assistant merely guessed.
- Prefer recording the user's concrete assertions. Do not withhold a fact just
  because the assistant was unsure.
- If nothing is worth keeping, return an empty memories array.
- Report a tension only when two statements genuinely contradict.`

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
- Never invent information that is in neither the candidate nor the memories you were given.`

/** Only keep a model statement that is worth a row. */
const usable = (content: string): boolean => {
  const trimmed = content.trim()
  return trimmed.length >= 8 && trimmed.length <= 600
}

/**
 * The provider is OpenAI-compatible rather than OpenAI specifically, so a
 * gateway or a local server is a URL change rather than a code change.
 */
const buildLayer = (options: {
  readonly apiKey: string
  readonly modelName: string
  readonly apiUrl: string | null
}): Layer.Layer<LanguageModel.LanguageModel> => {
  const client = OpenAiClient.layer({
    apiKey: Redacted.make(options.apiKey),
    ...(options.apiUrl === null ? {} : { apiUrl: options.apiUrl })
  })
  return OpenAiLanguageModel.layer({ model: options.modelName }).pipe(
    Layer.provide(Layer.provideMerge(client, FetchHttpClient.layer))
  )
}

const makeTurnExtractor = Effect.gen(function* () {
  const config = yield* settings
  const enabled = config.modelApiKey !== null

  // The layer is built either way so its type is stable; `enabled` is what
  // decides whether any call reaches it. A placeholder key is never sent
  // anywhere — it is only here so the context type does not depend on a runtime
  // branch, which is the kind of dependency that turns into a missing-service
  // error at 3am instead of a compile error.
  const modelLayer = buildLayer({
    apiKey: config.modelApiKey ?? "cognitive-memory-no-model-configured",
    modelName: config.modelName,
    apiUrl: config.modelBaseUrl
  })

  const extract: TurnExtractorService["extract"] = (turn) => {
    if (!enabled || turn.allowModel === false) return Effect.succeed(EMPTY_TURN)

    const ask = Effect.flatMap(LanguageModel.LanguageModel, (model) =>
      model.generateObject({
        objectName: "extracted_memories",
        schema: ExtractedTurn,
        prompt: [
          EXTRACT_INSTRUCTION,
          "<user>",
          clip(turn.userMessage, 2000),
          "</user>",
          "<assistant>",
          clip(turn.assistantResponse, 2000),
          "</assistant>"
        ].join("\n\n")
      })
    ).pipe(
      Effect.map((response) => response.value),
      // Extraction is a background concern. A failed extraction must not fail
      // the turn; the deterministic rules already got their chance.
      Effect.catchCause((cause) =>
        Effect.logWarning("model extraction failed; falling back to rules only", cause).pipe(
          Effect.as(EMPTY_TURN)
        )
      ),
      Effect.provide(modelLayer)
    )

    return Effect.map(ask, (value) => ({
      memories: value.memories
        .filter((memory) => usable(memory.content))
        .map((memory) => ({ content: memory.content.trim(), domains: memory.domains ?? [] })),
      tensions: value.tensions ?? []
    }))
  }

  const reconcile: TurnExtractorService["reconcile"] = (input) =>
    Effect.gen(function* () {
      // "add" everywhere is the safe default, and it is a real default rather
      // than an error path: an unmerged duplicate costs a row, a wrong merge
      // loses a fact.
      const addAll: Array<Reconciliation> = input.items.map(() => ({ action: "add" }))
      if (!enabled || input.items.length === 0) return addAll

      const verdicts = yield* Effect.flatMap(LanguageModel.LanguageModel, (model) =>
        model.generateObject({
          objectName: "reconciliation_verdicts",
          schema: ReconciledTurn,
          prompt: [
            RECONCILE_INSTRUCTION,
            input.items
              .map(
                ({ candidate, remember }, index) =>
                  `${index}. NEW: ${candidate}\n${remember.map((m) => `   remembered: ${m}`).join("\n")}`
              )
              .join("\n\n")
          ].join("\n\n")
        })
      ).pipe(
        Effect.map((response) => response.value.verdicts),
        Effect.catchCause((cause) =>
          Effect.logWarning("model reconciliation failed; keeping both", cause).pipe(Effect.as(null))
        ),
        Effect.provide(modelLayer)
      )

      if (verdicts === null) return addAll

      const out = addAll.map((verdict) => ({ ...verdict }))
      verdicts.forEach((verdict, position) => {
        // `index` is what the prompt asks for, but models often omit it and rely
        // on order instead, so fall back to the verdict's own position.
        const hint = verdict.index
        const index = typeof hint === "number" && Number.isInteger(hint) ? hint : position
        if (index < 0 || index >= input.items.length) return
        out[index] = {
          action: verdict.action,
          ...(verdict.content?.trim() ? { content: verdict.content.trim() } : {}),
          ...(verdict.reason?.trim() ? { reason: verdict.reason.trim() } : {})
        }
      })
      return out
    })

  const mode: TurnExtractorService["mode"] = Effect.succeed(enabled ? "rules+model" : "rules-only")

  return TurnExtractor.of({ extract, reconcile, mode })
})

export class TurnExtractor extends Context.Service<TurnExtractor, TurnExtractorService>()(
  "cognitive-memory/TurnExtractor"
) {
  static readonly layer = Layer.effect(TurnExtractor, makeTurnExtractor)
}

