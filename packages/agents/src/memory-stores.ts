import type { ModelMessage } from "ai";

import { loadMemory, type MemoryLoad, type MemorySave, type MemorySource } from "./memory.js";

/**
 * Stores and fallbacks for {@link MemorySource}.
 *
 * ## The read-only fallback is the migration, not a dead end
 *
 * `createFallbackMemory` exists because a cutover needs to serve threads that were
 * started under Mastra. It reads from the old store and writes to the new one, which
 * makes the two stores disagree in exactly one direction — and that direction is
 * frozen, so there is no dual-write ambiguity to reason about.
 *
 * Its limitation should be named rather than discovered: **a turn written through it
 * is invisible to the Mastra store**, so if the migration is rolled back, the threads
 * touched since cutover lose those turns. That is a real cost, and it is why this is a
 * phase rather than the end state — the alternative, reading from Mastra forever,
 * leaves every new turn unrecorded, which is a freeze rather than a migration.
 *
 * Rows are read lazily, per thread, on first touch. No backfill, no dual-write window,
 * and a thread nobody has reopened since cutover still reads correctly.
 */

/** The shape a store must satisfy to be read from. Deliberately narrower than `MemorySource`. */
export type ReadOnlyThreadStore = {
  /** Every message for the thread, oldest first. Empty is a valid answer. */
  load(): Promise<ModelMessage[]>;
};

export type FallbackMemoryOptions = {
  /** Where existing history comes from. Omit for a thread with no prior turns. */
  legacy?: ReadOnlyThreadStore;
  /** Where new turns go. Omit to run without persistence. */
  current?: MemorySource;
  /**
   * Called when a read or write fails.
   *
   * Not optional in spirit: a silent skip is indistinguishable from a working one
   * until the thing you taught it never comes back. Whoever wires this up should log
   * here rather than leaving it unset.
   */
  onError?: (operation: "load" | "save", error: unknown) => void;
};

/**
 * Read from the legacy store, write to the current one.
 *
 * `save` writes **only** to `current`. Forwarding to `legacy` would be the dual-write
 * that makes rollback correct and divergence possible, and this migration is choosing
 * the frozen direction deliberately — see the note above.
 */
export const createFallbackMemory = (options: FallbackMemoryOptions): MemorySource => ({
  async load() {
    if (!options.legacy) return [];
    try {
      return await options.legacy.load();
    } catch (error) {
      options.onError?.("load", error);
      // Empty rather than throwing: a cold thread and an unreadable one then look the
      // same, and the caller can still answer. `loadMemory` reports the degradation
      // separately when a source throws, so this swallow is scoped to the legacy read
      // where there is nothing better to fall back to.
      return [];
    }
  },
  async save(update) {
    if (!options.current) return;
    try {
      await options.current.save(update);
    } catch (error) {
      options.onError?.("save", error);
      throw error;
    }
  },
});

/**
 * An in-memory store, for tests and for a single-process deployment.
 *
 * Copies on the way in and out, because the harness mutates the array it is given:
 * handing back the live array would let a caller that keeps a reference see the
 * transcript change under it, and a test that passed would depend on ordering.
 */
export const createInMemoryMemory = (
  initial: ModelMessage[] = [],
): MemorySource & { peek(): ModelMessage[] } => {
  let messages: ModelMessage[] = [...initial];
  return {
    async load() {
      return [...messages];
    },
    async save(update) {
      messages =
        update.mode === "replace"
          ? [...update.messages]
          : [...messages, ...update.messages];
    },
    peek() {
      return [...messages];
    },
  };
};

/**
 * Keep the last `maxMessages`, dropping from the front.
 *
 * The minimum viable window, and deliberately not the default: a sliding count is a
 * poor proxy for context size, and it slides the prompt prefix on every turn, which
 * defeats provider prompt caching. Mastra's own docs steer long threads away from
 * `lastMessages` toward a token budget for this reason.
 *
 * Included because something has to bound the transcript for a caller who has not
 * built a store yet, and because it is the shape a real store will grow out of. Note
 * what it does *not* do: bound the tools. A retained window can still hold a single
 * enormous tool result, which is what the harness's own `pruneToolResults` and
 * compaction exist for.
 *
 * Truncation lands on a tool boundary where one is available, because a `tool`
 * message whose `tool-call` was dropped is rejected by every provider.
 */
export const createWindowedMemory = (
  store: MemorySource,
  maxMessages: number,
): MemorySource => ({
  async load() {
    const messages = await store.load();
    if (messages.length <= maxMessages) return messages;
    return trimToWindow(messages, maxMessages);
  },
  async save(update) {
    await store.save(update);
  },
});

/**
 * The last `maxMessages`, aligned so no tool result is orphaned.
 *
 * Walks the cut point back over orphaned `tool` messages, which re-admits their
 * owning assistant message. The same rule the harness applies when compacting
 * (`alignTailToToolBoundary` in `compaction.ts`) — duplicated rather than imported
 * because that one is not exported, and a second copy of a five-line alignment rule
 * is cheaper than a dependency on a private function.
 */
const trimToWindow = (messages: ModelMessage[], maxMessages: number): ModelMessage[] => {
  const wanted = Math.max(1, maxMessages);
  let start = Math.max(0, messages.length - wanted);
  while (start > 0 && messages[start]?.role === "tool") start -= 1;
  return messages.slice(start);
};

export { loadMemory };
export type { MemoryLoad, MemorySave };