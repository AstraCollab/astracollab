/**
 * A Mastra-shaped store behind the four-method session interface.
 *
 * ## Why the row count is not the count
 *
 * The mapper changes how many messages a set of rows becomes. One assistant row
 * carrying a tool call is two messages — the call and the result on a `tool`
 * message — so three rows can be four messages.
 *
 * That makes `before.length` arithmetic wrong in a way nothing catches:
 *
 * ```
 * rows on disk: 3   mapped: 4   a turn adds 2   →  6 messages
 *
 * before = 3 (rows)  → append(messages.slice(3))  → re-appends 2 stored messages
 * before = 4 (mapped) → append(messages.slice(4)) → appends only the 2 new ones
 * ```
 *
 * `sessionUpdate` from `@astracollab/not-another-harness` takes the transcript
 * length for exactly this reason. This store keeps the **mapped** array from
 * `load()` and exposes it as `loadedCount`, so the correct number is what a caller
 * has rather than something they have to remember to derive.
 */
import type { ModelMessage } from "ai";

import { fromMastra, toMastra, type MastraMessage } from "./index.js";

/** Where rows come from and go. The only thing a caller has to supply. */
export type MastraRowSource<T> = {
  /** Every row for the thread, oldest first. */
  load: (threadId: string) => Promise<T[]>;
  /** Add rows to the end of the thread. */
  append: (threadId: string, rows: T[]) => Promise<void>;
  /** Rewrite the whole thread. Required, because compaction means replacement. */
  replace: (threadId: string, rows: T[]) => Promise<void>;
  /** Empty the thread. */
  reset?: (threadId: string) => Promise<void>;
};

/** The four methods a session needs, and nothing else it does not. */
export type MastraSessionStore<T> = {
  load(): Promise<ModelMessage[]>;
  append(messages: ModelMessage[]): Promise<void>;
  replace(messages: ModelMessage[]): Promise<void>;
  reset(): Promise<void>;
  /**
   * Messages in memory as of the last `load()`.
   *
   * **This is the value to hand `sessionUpdate`.** Not the row count: the mapper
   * changes it, and the difference is re-appended history rather than an error.
   */
  readonly loadedCount: number;
  /**
   * Messages an `append` dropped because they were already stored.
   *
   * Non-zero means the caller passed a whole transcript rather than the new tail.
   * That is the natural mistake, and it duplicates history silently — so the
   * store absorbs it and reports it rather than writing the same turn twice.
   */
  readonly skippedDuplicates: number;
};

export type CreateMastraSessionStoreOptions<T> = {
  threadId: string;
  rows: MastraRowSource<T>;
  /** Narrows a row to the message shape the mapper reads. */
  toMessage: (row: T) => MastraMessage;
  /**
   * Ids for rows this store writes.
   *
   * Must be stable across runs, or a thread re-written on every turn accumulates
   * duplicate rows instead of replacing them.
   */
  idFor: (index: number, message: MastraMessage) => string;
  /** Tolerate a part type the mapper cannot represent. Off by default. */
  onUnknownPart?: "throw" | "preserve";
};

export const createMastraSessionStore = <T>(options: CreateMastraSessionStoreOptions<T>): MastraSessionStore<T> => {
  let loaded: ModelMessage[] = [];
  let loadedCount = 0;
  let skippedDuplicates = 0;

  const key = (message: ModelMessage): string => JSON.stringify(message);

  /**
   * Drop the prefix the store already holds.
   *
   * Compared by content rather than identity, because the caller's array is a
   * different object from ours even when it is the same turn.
   */
  const withoutStored = (messages: ModelMessage[]): ModelMessage[] => {
    const stored = new Set(loaded.map(key));
    let skipped = 0;
    const fresh: ModelMessage[] = [];
    for (const message of messages) {
      if (stored.has(key(message))) {
        skipped += 1;
        continue;
      }
      fresh.push(message);
      stored.add(key(message));
    }
    skippedDuplicates = skipped;
    return fresh;
  };

  const write = async (messages: ModelMessage[], mode: "append" | "replace"): Promise<void> => {
    // A stable, thread-scoped id per message. `messageIndex` survives appends
    // because the store appends only the new tail, and those are the same indices
    // the run produced.
    const rows = toMastra(messages, { id: (index) => options.idFor(index, messages[index]! as MastraMessage) });
    if (mode === "append") await options.rows.append(options.threadId, rows as unknown as T[]);
    else await options.rows.replace(options.threadId, rows as unknown as T[]);
  };

  return {
    get loadedCount() {
      return loadedCount;
    },

    get skippedDuplicates() {
      return skippedDuplicates;
    },

    async load() {
      const rows = await options.rows.load(options.threadId);
      loaded = fromMastra(rows.map(options.toMessage), { onUnknownPart: options.onUnknownPart ?? "throw" });
      loadedCount = loaded.length;
      return loaded;
    },

    async append(messages) {
      const fresh = withoutStored(messages);
      if (fresh.length === 0) return;
      await write(fresh, "append");
      loaded = [...loaded, ...fresh];
    },

    async replace(messages) {
      await write(messages, "replace");
      loaded = [...messages];
      loadedCount = messages.length;
    },

    async reset() {
      skippedDuplicates = 0;
      if (options.rows.reset) await options.rows.reset(options.threadId);
      else await options.rows.replace(options.threadId, []);
      loaded = [];
      loadedCount = 0;
    },
  };
};

/**
 * The write decision, for callers that want it without taking a dependency on
 * the harness.
 *
 * Identical to `sessionUpdate` in `@astracollab/not-another-harness`, and it has
 * to be: a second implementation is the only way this one drifts. The harness
 * copy is the one to import if you have it.
 */
export const sessionUpdateFor = (
  before: number,
  result: { messages: ModelMessage[]; compactions: number },
): { mode: "append" | "replace"; messages: ModelMessage[] } => {
  if (result.compactions > 0 || result.messages.length < before) {
    return { mode: "replace", messages: result.messages };
  }
  return { mode: "append", messages: result.messages.slice(before) };
};

export { fromMastra, toMastra };