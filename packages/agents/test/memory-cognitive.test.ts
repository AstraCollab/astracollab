import { describe, expect, it, vi } from "vitest";

import {
  buildMemoryContext,
  learnFromTurn,
  runWithMemory,
  withMemoryContext,
  type CognitiveMemoryLike,
  type CognitiveMemoryOptions,
} from "../src/memory-cognitive.js";

/**
 * Durable facts, via `cogmemory`'s tiered engine.
 *
 * The engine is stubbed rather than imported, and that is a deliberate choice worth
 * defending: these tests are about the *wiring* — ordering, persistence, and what
 * happens when a store is down — none of which belongs to `cogmemory`, and all of
 * which is what this package actually owns. `cogmemory`'s own suite covers its ranking.
 *
 * The stub's surface was checked against a real `CognitiveMemory` rather than guessed.
 * That is not a hypothetical: an earlier version of the interface declared
 * `learnFromTurn`, which does not exist on the engine — the real method is
 * `postTurnAsync({ userMessage, assistantResponse })`. Same shape, different name, and
 * nothing would have failed until a caller passed the real engine.
 *
 * The property that matters most is the first one: **context is built before the run
 * and learning happens after it.** Get that backwards and the assistant answers from
 * memory it has not learned yet — or learns from a turn it never saw.
 */

/** A stand-in with the same surface, so the wiring can be driven end to end. */
const fakeMemory = (options?: { throwOnContext?: boolean; throwOnLearn?: boolean }) => {
  const state = { contextCalls: 0, learned: [] as Array<{ userMessage: string; assistantResponse: string }>, snapshot: { l0: "fresh" } };
  const memory: CognitiveMemoryLike & { state: typeof state } = {
    state,
    getPromptContext(message) {
      state.contextCalls += 1;
      if (options?.throwOnContext) throw new Error("engine down");
      return `\n## Cognitive Memory State\n- relevant to: ${message ?? "none"}\n`;
    },
    async postTurnAsync(turn) {
      if (options?.throwOnLearn) throw new Error("learn failed");
      state.learned.push(turn);
      state.snapshot = { l0: `after ${state.learned.length} turn(s)` };
      return {};
    },
    getSnapshot: () => state.snapshot,
    loadSnapshot: (snapshot: unknown) => {
      state.snapshot = snapshot as typeof state.snapshot;
    },
  };
  return memory;
};

const storeFor = (initial: unknown = null) => {
  let value = initial;
  const onError = vi.fn();
  return {
    onError,
    load: async () => value,
    save: async (_key: string, snapshot: unknown) => {
      value = snapshot;
    },
    peek: () => value,
  };
};

describe("building context for a turn", () => {
  it("passes the user's message, so recall is keyed on what is being asked", async () => {
    const memory = fakeMemory();
    const built = await buildMemoryContext({ memory }, "what did we decide about pricing?");

    expect(built.degraded).toBe(false);
    expect(built.context).toContain("relevant to: what did we decide about pricing?");
  });

  it("restores durable state before building, or a cold instance forgets everything", async () => {
    const memory = fakeMemory();
    const store = storeFor({ l0: "what the org told us last month" });
    const options: CognitiveMemoryOptions = { memory, stateStore: store, key: "chat-1" };

    await buildMemoryContext(options, "hi");
    expect(memory.state.snapshot).toEqual({ l0: "what the org told us last month" });
  });

  it("treats an absent snapshot as a new thread, not an error", async () => {
    const memory = fakeMemory();
    const built = await buildMemoryContext(
      { memory, stateStore: storeFor(null), key: "chat-1" },
      "hello",
    );
    expect(built.degraded).toBe(false);
    expect(built.context).toContain("relevant to: hello");
  });

  it("returns an empty block when the engine throws, and says so", async () => {
    // The turn still has to be answerable. An empty block is a turn without memory,
    // which is strictly better than no turn.
    const onError = vi.fn();
    const built = await buildMemoryContext(
      { memory: fakeMemory({ throwOnContext: true }), onError },
      "hi",
    );

    expect(built).toEqual({ context: "", degraded: true });
    expect(onError).toHaveBeenCalledWith("load-state", expect.any(Error));
  });

  it("reports a failed state read without losing the turn", async () => {
    const onError = vi.fn();
    const built = await buildMemoryContext(
      {
        memory: fakeMemory(),
        stateStore: {
          load: async () => {
            throw new Error("state store down");
          },
          save: async () => {},
        },
        key: "chat-1",
        onError,
      },
      "hi",
    );

    expect(built.degraded).toBe(false);
    expect(built.context).toContain("relevant to: hi");
    expect(onError).toHaveBeenCalledWith("load-state", expect.any(Error));
  });
});

describe("learning from a finished turn", () => {
  it("persists the engine state, so the fact survives a cold start", async () => {
    const memory = fakeMemory();
    const store = storeFor();
    const options: CognitiveMemoryOptions = { memory, stateStore: store, key: "chat-1" };

    await learnFromTurn(options, { userMessage: "we bill monthly", assistantResponse: "noted" });
    expect(store.peek()).toEqual({ l0: "after 1 turn(s)" });
  });

  it("reports a learn failure instead of throwing", async () => {
    // The answer has already been given; it does not become wrong because a fact was
    // not recorded.
    const onError = vi.fn();
    const learning = await learnFromTurn(
      { memory: fakeMemory({ throwOnLearn: true }), onError },
      { userMessage: "q", assistantResponse: "a" },
    );

    expect(learning.learned).toBe(false);
    expect(learning.skipped).toContain("learn failed");
    expect(onError).toHaveBeenCalled();
  });

  it("distinguishes 'learned but not persisted' from 'learned'", async () => {
    // Silently conflating them hides a loss that only shows up on the next cold start.
    const memory = fakeMemory();
    const learning = await learnFromTurn(
      {
        memory,
        stateStore: {
          load: async () => null,
          save: async () => {
            throw new Error("write failed");
          },
        },
        key: "chat-1",
      },
      { userMessage: "q", assistantResponse: "a" },
    );

    expect(learning.learned).toBe(true);
    expect(learning.skipped).toContain("learned but not persisted");
  });

  it("skips cleanly when no learner is configured", async () => {
    // A recall-only deployment is legitimate, not a misconfiguration.
    const learning = await learnFromTurn({ memory: { getPromptContext: () => "" } }, {
      userMessage: "q",
      assistantResponse: "a",
    });
    expect(learning).toEqual({ learned: false, skipped: "no post-turn learner configured" });
  });
});

describe("a whole turn", () => {
  it("builds context before the run and learns after it", async () => {
    const memory = fakeMemory();
    const order: string[] = [];
    const wrapped = {
      ...memory,
      getPromptContext(message?: string) {
        order.push("context");
        return memory.getPromptContext(message);
      },
      async postTurnAsync(turn: { userMessage: string; assistantResponse: string }) {
        order.push("learn");
        return memory.postTurnAsync!(turn);
      },
    };

    const result = await runWithMemory({ memory: wrapped }, {
      userMessage: "we bill monthly",
      run: async (context) => {
        order.push("run");
        // The model must see the memory, not just the request that asked for it.
        expect(context).toContain("Cognitive Memory State");
        return { text: "Got it — monthly invoicing.", reason: "completed" };
      },
    });

    expect(order).toEqual(["context", "run", "learn"]);
    expect(result.result.text).toContain("monthly");
    expect(result.learning.learned).toBe(true);
    // The learned turn is the exchange that actually happened.
    expect(memory.state.learned).toEqual([
      { userMessage: "we bill monthly", assistantResponse: "Got it — monthly invoicing." },
    ]);
  });

  it("still answers when memory is broken end to end", async () => {
    // The single most important assertion in this file: memory is an enhancement, and
    // an outage in it must not take down the agent that was working fine without it.
    const result = await runWithMemory({ memory: fakeMemory({ throwOnContext: true }) }, {
      userMessage: "hello",
      run: async () => ({ text: "answered anyway", reason: "completed" }),
    });

    expect(result.result.text).toBe("answered anyway");
    expect(result.context).toBe("");
    expect(result.degraded).toBe(true);
  });

  it("passes the run's own text to the learner, not the prompt", async () => {
    const memory = fakeMemory();
    await runWithMemory({ memory }, {
      userMessage: "q",
      run: async () => ({ text: "the real answer", reason: "completed" }),
    });
    expect(memory.state.learned[0]?.assistantResponse).toBe("the real answer");
  });
});

describe("an async context builder, which the service requires", () => {
  it("awaits the block rather than dropping it", async () => {
    // The engine is sync; the service is HTTP. Accepting only sync would exclude the
    // service, and an adapter that fired an unawaited request and returned "" would
    // give a turn with no memory and no error — which is the failure this test is
    // here to prevent.
    const service = {
      getPromptContext: async (message?: string) => `## Memory\n- billing contact, asked about: ${message}`,
      postTurnAsync: async () => ({}),
    };
    const built = await buildMemoryContext({ memory: service }, "when do we invoice?");

    expect(built.degraded).toBe(false);
    expect(built.context).toContain("asked about: when do we invoice?");
  });

  it("degrades when an async builder rejects, rather than throwing", async () => {
    const onError = vi.fn();
    const built = await buildMemoryContext(
      {
        memory: {
          getPromptContext: async () => {
            throw new Error("service 503");
          },
        },
        onError,
      },
      "hi",
    );

    expect(built).toEqual({ context: "", degraded: true });
    expect(onError).toHaveBeenCalledWith("load-state", expect.any(Error));
  });

  it("forwards the turn to an async learner", async () => {
    const learned: unknown[] = [];
    await learnFromTurn(
      {
        memory: {
          getPromptContext: async () => "",
          postTurnAsync: async (turn) => void learned.push(turn),
        },
      },
      { userMessage: "q", assistantResponse: "a" },
    );
    expect(learned).toEqual([{ userMessage: "q", assistantResponse: "a" }]);
  });
});

describe("regressions found against the real engine", () => {
  /**
   * Both of these were found by driving an actual `cogmemory.CognitiveMemory`, not by
   * reading it. Neither is visible from this file's stub, which is the argument for
   * having run the real thing once.
   */

  it("calls postTurnAsync as a method, not detached", async () => {
    // `const learn = memory.postTurnAsync; learn(turn)` runs a class method with
    // `this` undefined, and it dies inside on `this.stats` — reported as a learn
    // failure, which is true and useless, because the wiring was correct. Only a real
    // engine notices, because only a real engine uses `this`.
    class Engine {
      stats = { turns: 0 };
      contextCalls = 0;
      getPromptContext(): string {
        return "";
      }
      async postTurnAsync(_turn: { userMessage: string; assistantResponse: string }): Promise<void> {
        this.stats.turns += 1;
      }
    }
    const engine = new Engine();
    const learning = await learnFromTurn({ memory: engine }, { userMessage: "q", assistantResponse: "a" });

    expect(learning).toEqual({ learned: true });
    expect(engine.stats.turns).toBe(1);
  });

  it("does not hand an absent snapshot to loadSnapshot", async () => {
    // `cogmemory`'s `loadSnapshot` reads `snapshot.l0` immediately and throws on
    // `null`, so a brand-new thread — where the store legitimately has nothing — would
    // break memory on the first turn, the one turn where that is least forgivable.
    //
    // The stub throws on null **exactly as the real one does**. A stub that merely
    // recorded the argument was what let this regression through the first time: the
    // behaviour under test is the *not calling*, and a permissive stub cannot tell a
    // correct implementation from one that hands the engine something it will choke on.
    let received: unknown = "not called";
    const memory = {
      getPromptContext: () => "",
      // Present because a restore needs *both* halves, and a fixture missing
      // `getSnapshot` makes `restoreState` return early — which would pass this test
      // for the wrong reason.
      getSnapshot: () => ({}),
      loadSnapshot: (snapshot: unknown) => {
        received = snapshot;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        if ((snapshot as any)?.l0 === undefined) {
          throw new TypeError("Cannot read properties of undefined (reading 'l0')");
        }
      },
    };
    await buildMemoryContext({
      memory,
      stateStore: { load: async () => null, save: async () => {} },
      key: "chat-1",
    });

    expect(received).toBe("not called");
  });

  it("still restores a real snapshot", async () => {
    const restored: unknown[] = [];
    await buildMemoryContext({
      memory: {
        getPromptContext: () => "",
        loadSnapshot: (s: unknown) => void restored.push(s),
        // Both are required for a restore: a caller that can restore but not snapshot
        // is a half-wired deployment, and treating it as no-store would silently drop
        // the state it can in fact read.
        getSnapshot: () => ({}),
      },
      stateStore: { load: async () => ({ l0: "state" }), save: async () => {} },
      key: "chat-1",
    });
    expect(restored).toEqual([{ l0: "state" }]);
  });

  it("reports a learn failure as a learn, not as a save", async () => {
    // The two used to share one operation name, so a failed learn reported as
    // "learned but not persisted" — untrue, and it hides that nothing was learned.
    const onError = vi.fn();
    const learning = await learnFromTurn(
      {
        memory: {
          getPromptContext: () => "",
          postTurnAsync: async () => {
            throw new Error("boom");
          },
        },
        onError,
      },
      { userMessage: "q", assistantResponse: "a" },
    );

    expect(learning.learned).toBe(false);
    expect(onError).toHaveBeenCalledWith("learn", expect.any(Error));
    expect(learning.skipped).not.toContain("not persisted");
  });
});

describe("injecting into a system prompt", () => {
  it("appends the block", () => {
    expect(withMemoryContext("You are the assistant.", "\n## Memory\n- x\n")).toBe(
      "You are the assistant.\n## Memory\n- x",
    );
  });

  it("leaves the prompt untouched when there is no memory", () => {
    // Otherwise every turn without a memory appends a blank line.
    expect(withMemoryContext("sys", "")).toBe("sys");
    expect(withMemoryContext("sys", undefined)).toBe("sys");
    expect(withMemoryContext("sys", "   \n ")).toBe("sys");
  });

  it("does not double the newline when the prompt already ends in one", () => {
    expect(withMemoryContext("sys\n", "## Memory")).toBe("sys\n## Memory");
  });
});