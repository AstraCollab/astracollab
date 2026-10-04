import { createMemoryCircuitBreaker, saveMemory, type MemorySource } from "./memory.js";

/**
 * Durable facts, via `cogmemory`.
 *
 * ## Why this is the answer to "the assistant forgot"
 *
 * Not a retrieval problem. The harness's compaction keeps a **coding-agent** ledger —
 * file paths, command exit codes, acceptance checks — because that is what the harness
 * was built for. It has nothing for a B2B workspace assistant. When a forty-turn
 * ticket thread compacts, what survives is a summary of "decisions made, files edited,
 * commands run", which says nothing about *this org's billing contact prefers monthly
 * invoicing*. No amount of vector search recovers that; only carrying the fact forward
 * does.
 *
 * `cogmemory` already does the carrying, and is already a dependency of the harness.
 * Its tiers are a budgeted, deterministic, explainable version of what Mastra calls
 * working memory — no embedding call, no model in the retrieval path, and a sub-1ms
 * synchronous `getPromptContext`.
 *
 * ## What is deliberately not here
 *
 * **Embeddings.** `cogmemory`'s `MemoryItem` carries an optional `embedding?: number[]`
 * field, documented as "empty array if embedding disabled", and nothing in its source
 * populates it by default. Its ranking is token overlap (`overlapScore` over
 * `relevanceTokens`). So this integration is lexical and deterministic: recall does not
 * depend on model quality, and there is no per-turn embedding latency on the critical
 * path of the first token. Adding vectors later means changing the ranking, not this
 * file.
 *
 * ## State has to be persisted, and `cogmemory` is in-memory
 *
 * A `CognitiveMemory` instance holds its tiers in `Map`s. A fresh instance per turn
 * would forget everything, which is the bug this is meant to fix. So the instance is
 * owned by the caller and its `getSnapshot()`/`loadSnapshot()` are wired to a store —
 * the same instance across turns, restored from durable state on a cold start.
 *
 * `loadSnapshot` is checked for a present snapshot rather than assumed: an absent one
 * is a new thread, not an error.
 */
export type CognitiveMemoryLike = {
  /**
   * The prompt block, budgeted by token count.
   *
   * May be sync or async, and both are first-class: the **engine** is synchronous
   * (`getPromptContext` is a sub-1ms string build) while the **service** is HTTP and
   * cannot be. Requiring sync would quietly exclude the service — which is the better
   * default, being multi-tenant and self-persisting — and an adapter that pretended
   * otherwise by firing an unawaited request and returning `""` would produce a turn
   * with no memory and no error, which is the worst of both.
   */
  getPromptContext(currentUserMessage?: string): string | Promise<string>;
  /**
   * A finished exchange, for extraction. Optional: recall-only deployments omit it.
   *
   * Named for `cogmemory`'s `postTurnAsync({ userMessage, assistantResponse })`,
   * which is what a `CognitiveMemory` actually exposes — checked against the engine
   * rather than assumed, after an earlier version of this interface guessed at a
   * `learnFromTurn` that does not exist. The shape is identical, so the adapter is a
   * rename rather than a translation.
   */
  postTurnAsync?: (turn: {
    userMessage: string;
    assistantResponse: string;
  }) => Promise<unknown>;
  getSnapshot?: () => unknown;
  loadSnapshot?: (snapshot: unknown) => void;
};

export type CognitiveMemoryOptions = {
  /**
   * The engine, or the service client behind an adapter. Owned by the caller, so the
   * same instance serves every turn.
   */
  memory: CognitiveMemoryLike;
  /**
   * Where the engine's state lives between turns.
   *
   * Optional, and omitting it is a real choice rather than a convenience: the engine
   * then works for the life of the process and forgets across a deploy. For a
   * multi-instance deployment it has to be backed by shared storage, or each instance
   * learns from only the turns it served.
   */
  stateStore?: {
    load(key: string): Promise<unknown>;
    save(key: string, snapshot: unknown): Promise<void>;
  };
  /** Identifies the state. Per chat, or per user depending on what should be shared. */
  key?: string;
  /**
   * Called when a read or write of the engine's state fails.
   *
   * The same reasoning as everywhere else in this package: an outage in memory must
   * not fail a turn, but it must be *visible*, because a silently-degraded memory
   * looks exactly like a working one until the fact it was taught never comes back.
   */
  onError?: (operation: "load-state" | "save-state" | "learn", error: unknown) => void;
  /** Fail a state operation after this many consecutive failures. Default 3. */
  circuitThreshold?: number;
  /** Stay open for this long. Default 30s. */
  circuitCooldownMs?: number;
  /** Injected in tests. */
  now?: () => number;
};

/**
 * The prompt block for a turn, restored from durable state first.
 *
 * Returns `""` rather than throwing when memory is unavailable: an empty block is a
 * turn with no memory, which is strictly better than no turn. The caller decides
 * whether to log, having been told.
 */
export const buildMemoryContext = async (
  options: CognitiveMemoryOptions,
  currentUserMessage?: string,
): Promise<{ context: string; degraded: boolean }> => {
  const { memory } = options;
  await restoreState(options);

  try {
    const context = await memory.getPromptContext(currentUserMessage);
    return { context, degraded: false };
  } catch (error) {
    options.onError?.("load-state", error);
    // A failure *inside* the engine is not recoverable this turn, but the turn can
    // still be answered.
    return { context: "", degraded: true };
  }
};

/**
 * Learn from a finished exchange, and persist what was learned.
 *
 * Called after the turn has answered. Two rules, both from `cogmemory`'s own
 * `runTurn` and both load-bearing:
 *
 *  - learning never fails the turn, because the answer has already been given and it
 *    does not become wrong because a fact was not recorded;
 *  - a skip is **reported**, not swallowed. `runTurn` returns `learningSkipped`
 *    precisely because "a silent skip is indistinguishable from a working one until the
 *    thing you taught it never comes back".
 */
export const learnFromTurn = async (
  options: CognitiveMemoryOptions,
  turn: { userMessage: string; assistantResponse: string },
): Promise<{ learned: boolean; skipped?: string }> => {
  const { memory } = options;
  if (!memory.postTurnAsync) {
    return { learned: false, skipped: "no post-turn learner configured" };
  }

  try {
    // Called as a *method*, never detached. `cogmemory`'s engine is a class, so
    // `const learn = memory.postTurnAsync; learn(turn)` runs it with `this` undefined
    // and dies inside on `this.stats` — reported as a learn failure, which is true and
    // completely unhelpful, because the learn had in fact been wired correctly.
    await memory.postTurnAsync(turn);
  } catch (error) {
    // Distinct from a persist failure, and reported as such: conflating them made a
    // failed learn report as "learned but not persisted", which is both untrue and
    // hides the fact that nothing was learned at all.
    options.onError?.("learn", error);
    return { learned: false, skipped: String(error) };
  }

  const persisted = await persistState(options);
  // Persisting separately from learning is deliberate: a successful learn with a
  // failed persist has still taught the engine something, and the loss is on the next
  // cold start. Reporting only `learned` would hide that.
  return persisted.ok
    ? { learned: true }
    : { learned: true, skipped: `learned but not persisted: ${String(persisted.error)}` };
};

const restoreState = async (options: CognitiveMemoryOptions): Promise<void> => {
  const { memory, stateStore, key } = options;
  if (!stateStore || !key || !memory.loadSnapshot || !memory.getSnapshot) return;
  const breaker = breakerFor(options);
  if (breaker.isOpen()) return;
  try {
    const snapshot = await stateStore.load(key);
    // Only a real snapshot is applied. `loadSnapshot` on `cogmemory` reads
    // `snapshot.l0` immediately and throws on `null`, so a brand-new thread — where
    // the store legitimately has nothing — would break memory on its very first turn,
    // which is the one turn where a broken memory is least forgivable. An absent
    // snapshot is a new thread, not an error.
    if (snapshot != null) memory.loadSnapshot(snapshot);
    breaker.recordSuccess();
  } catch (error) {
    breaker.recordFailure();
    options.onError?.("load-state", error);
  }
};

const persistState = async (
  options: CognitiveMemoryOptions,
): Promise<{ ok: true } | { ok: false; error: unknown }> => {
  const { memory, stateStore, key } = options;
  if (!stateStore || !key || !memory.getSnapshot) return { ok: true };
  const breaker = breakerFor(options);
  if (breaker.isOpen()) return { ok: true };
  try {
    await stateStore.save(key, memory.getSnapshot());
    breaker.recordSuccess();
    return { ok: true };
  } catch (error) {
    breaker.recordFailure();
    options.onError?.("save-state", error);
    return { ok: false, error };
  }
};

/**
 * One breaker per options object.
 *
 * Attached rather than passed so callers cannot accidentally use a fresh breaker per
 * operation, which would make it a no-op — the whole point is that the *same* streak
 * of failures is counted across turns.
 */
const breakers = new WeakMap<CognitiveMemoryOptions, ReturnType<typeof createMemoryCircuitBreaker>>();

const breakerFor = (
  options: CognitiveMemoryOptions,
): ReturnType<typeof createMemoryCircuitBreaker> => {
  const existing = breakers.get(options);
  if (existing) return existing;
  const created = createMemoryCircuitBreaker({
    ...(options.circuitThreshold === undefined ? {} : { threshold: options.circuitThreshold }),
    ...(options.circuitCooldownMs === undefined ? {} : { cooldownMs: options.circuitCooldownMs }),
    ...(options.now ? { now: options.now } : {}),
  });
  breakers.set(options, created);
  return created;
};

/**
 * Append the memory block to a system prompt, or leave it alone.
 *
 * Returns the prompt unchanged when there is nothing to add, so a caller does not need
 * to know whether memory was empty this turn — the common case early in a thread, and
 * a trailing blank line per turn otherwise.
 */
export const withMemoryContext = (system: string, context: string | undefined): string => {
  const trimmed = context?.trim();
  if (!trimmed) return system;
  const separator = system.endsWith("\n") ? "" : "\n";
  return `${system}${separator}${trimmed}`;
};

/**
 * Run a turn with memory on both sides: context before, learning after.
 *
 * The shape of a whole turn, so the ordering cannot be got wrong at a call site. The
 * run is handed a function rather than a run handle, because learning needs the
 * assistant's *text*, which only exists once the run has finished.
 */
export const runWithMemory = async <T extends { text: string; reason: string }>(
  options: CognitiveMemoryOptions,
  turn: { userMessage: string; run: (context: string) => Promise<T> },
): Promise<{
  result: T;
  context: string;
  degraded: boolean;
  learning: { learned: boolean; skipped?: string };
}> => {
  const built = await buildMemoryContext(options, turn.userMessage);
  // A failure to build context must not stop the turn; the run gets an empty block.
  const result = await turn.run(built.context);
  const learning = await learnFromTurn(options, {
    userMessage: turn.userMessage,
    assistantResponse: result.text,
  });
  return { result, context: built.context, degraded: built.degraded, learning };
};

/** Re-exported so a caller building a memory-backed store needs one import. */
export { saveMemory };
export type { MemorySource };