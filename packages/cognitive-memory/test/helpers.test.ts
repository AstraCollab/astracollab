import { describe, expect, it, vi } from "vitest"

import { recallOrExplain, runTurn, seedMemories } from "../src/helpers/turn"
import type { Cogmem } from "../src/cogmem"
import type { LearnResult, Memory, SelfModel } from "../src/types"

/**
 * The helpers, tested against a mocked client.
 *
 * The opposite of the HTTP tests on purpose: here the behaviour under test is
 * the composition, so mocking the whole client tests the logic and nothing else.
 */

const storedMemory = (content: string, domains: string[] = []): Memory => ({
  id: `mem-${content.length}`,
  content,
  tier: "L1",
  domains,
  accessCount: 0,
  createdAt: 0,
  lastAccessedAt: 0
})

const emptyLearning: LearnResult = {
  stored: [],
  mergedInto: [],
  counts: { stored: 0, merged: 0, rejected: 0, tensions: 0, promoted: 0 },
  rejected: []
}

const makeClient = (overrides: Partial<Record<"context" | "turns" | "selfModel" | "recall" | "memories", unknown>> = {}) =>
  ({
    context: {
      build: vi.fn().mockResolvedValue({ text: "## Memory\n- a fact", entries: [], totalTokens: 12, truncated: false })
    },
    turns: { learn: vi.fn().mockResolvedValue(emptyLearning) },
    selfModel: { record: vi.fn().mockResolvedValue({} as SelfModel) },
    recall: {
      search: vi.fn().mockResolvedValue({ results: [], empty: true })
    },
    memories: {
      create: vi.fn().mockResolvedValue(emptyLearning)
    },
    ...overrides
  }) as unknown as Cogmem

describe("runTurn", () => {
  it("builds context before the model runs, and learns after it finishes", async () => {
    const order: string[] = []
    const memory = makeClient()
    ;(memory.context.build as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      order.push("context")
      return { text: "ctx", entries: [], totalTokens: 1, truncated: false }
    })
    ;(memory.turns.learn as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      order.push("learn")
      return emptyLearning
    })

    await runTurn(
      memory,
      {
        userMessage: "the staging build id is ZQ7X4M2K",
        run: async () => {
          order.push("model")
          return "noted"
        }
      },
      { sessionId: "s1" }
    )

    expect(order).toEqual(["context", "model", "learn"])
  })

  it("passes the context block to the model, keyed on the user message", async () => {
    const memory = makeClient()
    const run = vi.fn().mockResolvedValue("answer")

    await runTurn(memory, { userMessage: "what is the build id?", run })

    expect(memory.context.build).toHaveBeenCalledWith(
      expect.objectContaining({ userMessage: "what is the build id?" })
    )
    expect(run).toHaveBeenCalledWith("## Memory\n- a fact")
  })

  it("does not fail the turn when learning fails", async () => {
    const memory = makeClient()
    ;(memory.turns.learn as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("service down"))
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})

    const result = await runTurn(memory, { userMessage: "a fact", run: async () => "ok" })

    // The turn already produced an answer; a memory outage must not discard it.
    expect(result.learning).toBeNull()
    expect(result.learningSkipped).toContain("service down")
    expect(warn).toHaveBeenCalled()
  })

  it("says why learning was skipped rather than skipping silently", async () => {
    const result = await runTurn(
      makeClient(),
      { userMessage: "a fact", run: async () => "ok" },
      { learn: false }
    )
    expect(result.learning).toBeNull()
    expect(result.learningSkipped).toBeDefined()
  })

  it("records the domain outcome, inferring failure from a failure pattern", async () => {
    const memory = makeClient()
    await runTurn(
      memory,
      { userMessage: "add a migration", run: async () => "done" },
      { domain: "database", failurePattern: "migrated without a backup" }
    )

    expect(memory.selfModel.record).toHaveBeenCalledWith(
      expect.objectContaining({ domain: "database", success: false })
    )
  })

  it("records success when no failure pattern is given", async () => {
    const memory = makeClient()
    await runTurn(
      memory,
      { userMessage: "add an index", run: async () => "done" },
      { domain: "database", strategy: "concurrently in the same migration" }
    )

    expect(memory.selfModel.record).toHaveBeenCalledWith(
      expect.objectContaining({ domain: "database", success: true })
    )
  })
})

describe("recallOrExplain", () => {
  it("tells the model to admit ignorance instead of guessing", async () => {
    const memory = makeClient()
    const text = await recallOrExplain(memory, "quarterly revenue")

    expect(text).toContain("Nothing in memory matches")
    expect(text).toContain("say so rather than guessing")
  })

  it("formats hits with their tier and relevance", async () => {
    const memory = makeClient()
    ;(memory.recall.search as ReturnType<typeof vi.fn>).mockResolvedValue({
      empty: false,
      results: [{ memory: storedMemory("The staging build id is ZQ7X4M2K", ["deployment"]), score: 0.75 }]
    })

    const text = await recallOrExplain(memory, "staging build id")
    expect(text).toContain("The staging build id is ZQ7X4M2K (deployment) [L1, relevance 0.75]")
  })

  it("accepts a custom empty message", async () => {
    const text = await recallOrExplain(makeClient(), "anything", { emptyMessage: "No idea." })
    expect(text).toBe("No idea.")
  })
})

describe("seedMemories", () => {
  it("separates what was stored from what was already known", async () => {
    const memory = makeClient()
    ;(memory.memories.create as ReturnType<typeof vi.fn>).mockResolvedValue({
      stored: [storedMemory("new fact")],
      mergedInto: [storedMemory("old fact")],
      counts: { stored: 1, merged: 1, rejected: 0, tensions: 0, promoted: 0 },
      rejected: []
    })

    const result = await seedMemories(memory, { facts: ["new fact", "old fact"] })

    expect(result.stored).toHaveLength(1)
    expect(result.merged).toHaveLength(1)
    expect(memory.memories.create).toHaveBeenCalledWith({
      items: [{ content: "new fact" }, { content: "old fact" }]
    })
  })
})
