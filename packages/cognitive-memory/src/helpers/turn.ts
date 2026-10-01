import type { CognitiveMemory } from "../cognitive-memory"
import type { ContextReport, LearnResult, Memory } from "../types"

/**
 * Workflows.
 *
 * Resource methods are one call each. These compose them into the sequences
 * people actually get wrong when they write the loop themselves — and the
 * mistakes are mundane: forgetting to learn from a turn, learning from a question,
 * letting a memory failure take down the turn it was meant to help, or never
 * telling the service how a task went so the guardrails never fire.
 *
 * Each helper takes the client explicitly rather than closing over one, so it
 * works with a second client without a module-level singleton.
 */

export interface TurnOptions {
  /** Groups everything learned in one conversation. */
  sessionId?: string
  /**
   * What the turn turned out to be about, e.g. `"database"`.
   *
   * Recorded against the self-model, which is what eventually produces a
   * guardrail for a domain the agent keeps failing in. Cheap to send and the
   * difference between a self-model that learns and one that sits at its priors.
   */
  domain?: string
  /** What went wrong, when the turn was a failure. */
  failurePattern?: string
  /** What worked, when the turn was a success. */
  strategy?: string
  /** Set false to skip learning — a retrieval-only turn, say. */
  learn?: boolean
  onLearn?: (result: LearnResult) => void
}

export interface RunTurnResult {
  context: ContextReport
  learning: LearnResult | null
  /**
   * Why learning did not happen, if it did not.
   *
   * Present because a silent skip looks identical to a working one until the
   * thing you taught it never comes back.
   */
  learningSkipped?: string
}

/**
 * One turn of an agent loop, with memory handled correctly.
 *
 * The order is the point:
 *
 * 1. build context *before* the model runs, keyed on the message being answered;
 * 2. run the model;
 * 3. learn from the finished exchange;
 * 4. record how the domain went, so the self-model moves.
 *
 * Steps 3 and 4 never fail the turn. Memory is an enhancement; an outage in it
 * must not take down the agent that was working fine without it, and the errors
 * are surfaced through `onLearn` and the returned skip reason rather than
 * swallowed.
 */
export async function runTurn(
  memory: CognitiveMemory,
  input: {
    userMessage: string
    run: (context: string) => Promise<string>
  },
  options: TurnOptions = {}
): Promise<RunTurnResult> {
  const context = await memory.context.build({
    userMessage: input.userMessage,
    ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId })
  })

  const assistantResponse = await input.run(context.text)

  if (options.learn === false) {
    return { context, learning: null, learningSkipped: "learning disabled for this turn" }
  }

  let learning: LearnResult | null = null
  try {
    learning = await memory.turns.learn({
      userMessage: input.userMessage,
      assistantResponse,
      ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId })
    })
    options.onLearn?.(learning)
  } catch (error) {
    // Deliberately not rethrown: the turn already succeeded, and the assistant's
    // answer does not become wrong because memory could not be written.
    console.warn("[cognitive-memory] could not learn from this turn", error)
    return { context, learning: null, learningSkipped: String(error) }
  }

  if (options.domain !== undefined) {
    try {
      await memory.selfModel.record({
        domain: options.domain,
        success: options.failurePattern === undefined,
        ...(options.failurePattern === undefined ? {} : { failurePattern: options.failurePattern }),
        ...(options.strategy === undefined ? {} : { strategy: options.strategy })
      })
    } catch (error) {
      console.warn("[cognitive-memory] could not record the domain outcome", error)
    }
  }

  return { context, learning }
}

export interface RecallOrExplainOptions {
  limit?: number
  /** Overrides the default "you were not told this" wording. */
  emptyMessage?: string
}

/**
 * Recall, phrased for injection into a prompt.
 *
 * Returns text rather than results because the caller's next step is almost
 * always "put this in the prompt", and doing the formatting here means every
 * integration handles the empty case the same way: by saying so, rather than
 * letting a model fill the gap with a guess.
 */
export async function recallOrExplain(
  memory: CognitiveMemory,
  query: string,
  options: RecallOrExplainOptions = {}
): Promise<string> {
  const response = await memory.recall.search({
    query,
    ...(options.limit === undefined ? {} : { limit: options.limit })
  })

  if (response.empty) {
    return options.emptyMessage ?? `Nothing in memory matches "${query}". If you were not told, say so rather than guessing.`
  }

  const lines = response.results.map((hit) => {
    const domains = hit.memory.domains.length > 0 ? ` (${hit.memory.domains.join(", ")})` : ""
    return `- ${hit.memory.content}${domains} [${hit.memory.tier}, relevance ${hit.score.toFixed(2)}]`
  })
  return `Remembered (${response.results.length} match${response.results.length === 1 ? "" : "es"}):\n${lines.join("\n")}`
}

export interface SeedOptions {
  /** Statements worth keeping regardless of how they are phrased. */
  facts: string[]
  sessionId?: string
}

/**
 * Store a set of statements once, tolerating the ones already held.
 *
 * For a migration or a first run, where you have a list of facts and no way to
 * know which the service already knows. Restatements come back under
 * `mergedInto` rather than as errors, so re-running it is safe.
 */
export async function seedMemories(memory: CognitiveMemory, options: SeedOptions): Promise<{
  stored: Memory[]
  merged: Memory[]
  rejected: LearnResult["rejected"]
}> {
  const result = await memory.memories.create({
    items: options.facts.map((content) => ({ content })),
    ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId })
  })
  return { stored: result.stored, merged: result.mergedInto, rejected: result.rejected }
}
