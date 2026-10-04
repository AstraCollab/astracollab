import { describe, expect, it, vi } from "vitest";
import type { ModelMessage } from "ai";
import type { SessionUpdate } from "not-another-harness";

import {
  createMemoryCircuitBreaker,
  loadMemory,
  saveMemory,
  type MemorySource,
} from "../src/memory.js";
import {
  createFallbackMemory,
  createInMemoryMemory,
  createWindowedMemory,
} from "../src/memory-stores.js";

/**
 * Memory, as the product needs it.
 *
 * ## What is protected here
 *
 * Three properties, in priority order, because they are the ones that decide whether
 * memory can be switched on at all:
 *
 *  1. **A memory failure never fails a turn.** The answer has already been given; it
 *     does not become wrong because the transcript was not recorded. Every test here
 *     that makes a store throw also asserts the caller still got an answer.
 *  2. **A failure is *visible*.** A silent skip is indistinguishable from a working
 *     one until the fact you taught it never comes back — so degradation is returned,
 *     not swallowed.
 *  3. **History is never duplicated.** `sessionUpdate` decides append-vs-replace, and
 *     a store that re-derived it would re-append a summarised transcript the first
 *     time a long thread compacted.
 */

const user = (text: string): ModelMessage => ({ role: "user", content: text });
const assistant = (text: string): ModelMessage => ({ role: "assistant", content: text });

const append = (messages: ModelMessage[]): SessionUpdate => ({ mode: "append", messages });

describe("loading", () => {
  it("returns the stored transcript", async () => {
    const store = createInMemoryMemory([user("hi"), assistant("hello")]);
    const loaded = await loadMemory(store);
    expect(loaded).toEqual({ ok: true, messages: [user("hi"), assistant("hello")], degraded: false });
  });

  it("treats no source as an empty thread, not a failure", async () => {
    // The common case for a brand-new chat, and it must not look like an outage.
    expect(await loadMemory(undefined)).toEqual({ ok: true, messages: [], degraded: false });
  });

  it("degrades to the caller's fallback instead of throwing", async () => {
    const broken: MemorySource = {
      load: async () => {
        throw new Error("ECONNREFUSED");
      },
      save: async () => {},
    };
    const loaded = await loadMemory(broken, () => [user("last known good")]);

    expect(loaded.ok).toBe(false);
    expect(loaded.degraded).toBe(true);
    expect(loaded.messages).toEqual([user("last known good")]);
  });

  it("carries the error, so the caller can log it", async () => {
    const boom = new Error("store down");
    const loaded = await loadMemory({
      load: async () => {
        throw boom;
      },
      save: async () => {},
    });
    expect(loaded.ok === false && loaded.error).toBe(boom);
  });

  it("defaults the fallback to empty rather than to a guess", async () => {
    const loaded = await loadMemory({
      load: async () => {
        throw new Error("x");
      },
      save: async () => {},
    });
    expect(loaded.messages).toEqual([]);
  });
});

describe("saving", () => {
  it("appends the new tail", async () => {
    const store = createInMemoryMemory([user("hi")]);
    await saveMemory(store, append([assistant("hello")]));
    expect(store.peek()).toEqual([user("hi"), assistant("hello")]);
  });

  it("replaces the whole transcript when the run compacted", async () => {
    const store = createInMemoryMemory([user("hi"), assistant("hello"), user("more")]);
    const summary: ModelMessage[] = [user("hi"), assistant("summary of the thread")];
    await saveMemory(store, { mode: "replace", messages: summary });
    expect(store.peek()).toEqual(summary);
  });

  it("returns the error rather than throwing", async () => {
    const boom = new Error("disk full");
    const saved = await saveMemory(
      {
        load: async () => [],
        save: async () => {
          throw boom;
        },
      },
      append([user("x")]),
    );
    expect(saved.ok).toBe(false);
    expect(saved.ok === false && saved.error).toBe(boom);
  });

  it("is a no-op with no source", async () => {
    expect(await saveMemory(undefined, append([user("x")]))).toEqual({ ok: true });
  });
});

describe("the in-memory store", () => {
  it("copies on the way in and out", async () => {
    // The harness mutates the array it is handed. A live reference would let a caller
    // watching it change underneath them, and a test that passed would then depend on
    // evaluation order.
    const original = [user("hi")];
    const store = createInMemoryMemory(original);
    original.push(assistant("added later"));

    expect(await store.load()).toEqual([user("hi")]);
    store.peek().push(assistant("also later"));
    expect(await store.load()).toEqual([user("hi")]);
  });
});

describe("the window", () => {
  const long: ModelMessage[] = [
    user("q1"),
    assistant("a1"),
    user("q2"),
    assistant("a2"),
    user("q3"),
    assistant("a3"),
  ];

  it("keeps the tail when over budget", async () => {
    // Six messages, budget three: the cut lands on index 3, which is not a tool
    // message, so exactly three come back.
    const windowed = createWindowedMemory(createInMemoryMemory(long), 3);
    expect(await windowed.load()).toEqual([assistant("a2"), user("q3"), assistant("a3")]);
  });

  it("leaves a short transcript alone", async () => {
    const windowed = createWindowedMemory(createInMemoryMemory(long), 100);
    expect(await windowed.load()).toEqual(long);
  });

  it("never orphans a tool result", async () => {
    // A `tool` message whose `tool-call` was dropped is rejected by every provider,
    // and by the SDK before it reaches one.
    const withTool: ModelMessage[] = [
      user("q1"),
      { role: "assistant", content: [{ type: "tool-call", toolCallId: "t1", toolName: "read", input: {} }] },
      { role: "tool", content: [{ type: "tool-result", toolCallId: "t1", toolName: "read", output: { type: "text", value: "contents" } }] },
      user("q2"),
    ];
    const windowed = createWindowedMemory(createInMemoryMemory(withTool), 2);
    const kept = await windowed.load();

    expect(kept[0]?.role).not.toBe("tool");
    expect(kept.map((m) => m.role)).toEqual(["assistant", "tool", "user"]);
  });

  it("forwards writes to the store it wraps", async () => {
    const inner = createInMemoryMemory();
    await saveMemory(createWindowedMemory(inner, 100), append([user("x")]));
    expect(inner.peek()).toEqual([user("x")]);
  });
});

describe("the migration fallback", () => {
  it("reads legacy history and writes only to the current store", async () => {
    // The direction of the one-way is the point: reading forever would leave every
    // new turn unrecorded, which is a freeze rather than a migration.
    const legacy = { load: async () => [user("from mastra"), assistant("old answer")] };
    const current = createInMemoryMemory();
    const onError = vi.fn();

    const memory = createFallbackMemory({ legacy, current, onError });
    expect(await memory.load()).toEqual([user("from mastra"), assistant("old answer")]);

    await memory.save(append([user("new question")]));
    expect(current.peek()).toEqual([user("new question")]);
  });

  it("reports a legacy read failure instead of throwing", async () => {
    const onError = vi.fn();
    const memory = createFallbackMemory({
      legacy: {
        load: async () => {
          throw new Error("legacy down");
        },
      },
      onError,
    });

    // Empty, not a throw: a cold thread and an unreadable one then look the same and
    // the turn can still be answered.
    expect(await memory.load()).toEqual([]);
    expect(onError).toHaveBeenCalledWith("load", expect.any(Error));
  });

  it("reports a write failure, and the caller decides what to do", async () => {
    const onError = vi.fn();
    const current: MemorySource = {
      load: async () => [],
      save: async () => {
        throw new Error("write failed");
      },
    };
    const memory = createFallbackMemory({ current, onError });

    await expect(memory.save(append([user("x")]))).rejects.toThrow("write failed");
    expect(onError).toHaveBeenCalledWith("save", expect.any(Error));
  });

  it("never writes to the legacy store, so there is no dual-write to diverge", async () => {
    // The whole safety property of the migration: the old store is frozen and
    // read-only, the new one is the only writer. A forward would make rollback correct
    // and divergence possible — and the divergence is invisible until a thread
    // disagrees with itself.
    const legacyWrites: string[] = [];
    const legacy = {
      load: async () => [user("old")],
      append: async () => void legacyWrites.push("append"),
      replace: async () => void legacyWrites.push("replace"),
    };
    const current = createInMemoryMemory();
    const memory = createFallbackMemory({ legacy, current });

    await memory.save(append([user("new")]));
    await memory.save({ mode: "replace", messages: [user("summary")] });

    expect(legacyWrites).toEqual([]);
    expect(current.peek()).toEqual([user("summary")]);
  });

  it("works with neither store, for a caller that has not built persistence yet", async () => {
    const memory = createFallbackMemory({});
    expect(await memory.load()).toEqual([]);
    await expect(memory.save(append([user("x")]))).resolves.toBeUndefined();
  });
});

describe("the circuit breaker", () => {
  it("opens after the threshold and closes after the cooldown", async () => {
    let clock = 1000;
    const breaker = createMemoryCircuitBreaker({ threshold: 2, cooldownMs: 500, now: () => clock });

    expect(breaker.isOpen()).toBe(false);
    breaker.recordFailure();
    expect(breaker.isOpen()).toBe(false);
    breaker.recordFailure();
    expect(breaker.isOpen()).toBe(true);

    clock += 499;
    expect(breaker.isOpen()).toBe(true);
    clock += 2;
    expect(breaker.isOpen()).toBe(false);
  });

  it("resets on success, so a recovered store is used immediately", async () => {
    let clock = 1000;
    const breaker = createMemoryCircuitBreaker({ threshold: 2, cooldownMs: 500, now: () => clock });
    breaker.recordFailure();
    breaker.recordFailure();
    expect(breaker.isOpen()).toBe(true);

    clock += 600;
    expect(breaker.isOpen()).toBe(false);
    breaker.recordSuccess();
    breaker.recordFailure();
    expect(breaker.isOpen()).toBe(false);
  });
});