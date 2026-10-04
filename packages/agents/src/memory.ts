import type { ModelMessage } from "ai";
import type { SessionUpdate } from "not-another-harness";

/**
 * Memory, as the harness sees it: messages in, a `SessionUpdate` out.
 *
 * ## Why this lives here and not in `not-another-harness`
 *
 * The harness already has the seam memory needs — `HarnessRunOptions.messages` in,
 * `sessionUpdate(...)` on the way back — and it is deliberately ignorant of *where*
 * those messages live. That is the right shape for a harness and the wrong place for
 * an interface: `session-manager.ts` states the doctrine in the harness's own words,
 *
 * > Conversation state. This never stores messages — a caller passes them per turn
 * > from whatever store it uses, so the manager cannot become a second, competing
 * > source of truth for a transcript.
 *
 * and NAH is a published npm package used by other projects, so a `MemorySource`
 * there is a semver commitment forever. Tenant scoping, retention and isolation are
 * product facts no harness can know — Mastra's own docs warn that "the memory system
 * doesn't enforce access control."
 *
 * ## Not `prepareStep`
 *
 * The obvious place to hang a hook is `prepareStep`, and it is the wrong one: it runs
 * per **step**, so retrieval would fire once per step and spend a query each time
 * while a turn is still running. Memory is per **turn**. If you need mid-run
 * injection, use `prepareStep` guarded on `stepNumber === 1` — and note the
 * harness numbers steps from 1 where Mastra numbered from 0.
 *
 * ## The shape is deliberately small
 *
 * Two methods, both `ModelMessage[]`-native, because that is what the harness already
 * speaks. Anything richer — retrieval scores, provenance, tier information — belongs
 * in the prompt text, where the model can read it, rather than in a parallel channel
 * that has to be kept in sync.
 */
export type MemorySource = {
  /**
   * The transcript to continue from.
   *
   * Empty is a valid answer and must not be treated as a failure: it is a new thread.
   * A source that throws, by contrast, has to be survivable — see
   * {@link loadMemory}.
   */
  load(): Promise<ModelMessage[]>;

  /**
   * Persist a finished run.
   *
   * `SessionUpdate` rather than a message array because compaction makes a finished
   * transcript a *replacement*, not an append: `sessionUpdate` already decides which,
   * and a store that re-derived it would get it wrong the first time a long thread
   * compacted. `mode: "append"` carries only the new tail; `"replace"` carries a
   * summarised whole.
   */
  save(update: SessionUpdate): Promise<void>;
};

/**
 * What a `load` produced, including whether it worked.
 *
 * The failure case is the reason this type exists. A store outage must not take down
 * a turn that would otherwise have been answered, so the caller needs to know it got
 * a degraded transcript *and* why, rather than discovering it later as an assistant
 * that has forgotten a conversation it was told about.
 */
export type MemoryLoad =
  | { ok: true; messages: ModelMessage[]; degraded: false }
  | { ok: false; messages: ModelMessage[]; degraded: true; error: unknown };

export type MemorySave = { ok: true } | { ok: false; error: unknown };

/**
 * Load, degrading instead of throwing.
 *
 * `fallback` is what to answer from when the store is unreachable — normally the last
 * transcript the caller knows is good, or `[]` for a cold thread. The point is that
 * the *caller* decides, because only it knows whether a stale transcript or an empty
 * one produces a better answer.
 */
export const loadMemory = async (
  source: MemorySource | undefined,
  fallback: () => ModelMessage[] = () => [],
): Promise<MemoryLoad> => {
  if (!source) return { ok: true, messages: [], degraded: false };
  try {
    const messages = await source.load();
    return { ok: true, messages, degraded: false };
  } catch (error) {
    return { ok: false, messages: fallback(), degraded: true, error };
  }
};

/**
 * Save, never throwing.
 *
 * A failed write is a degraded *next* turn, not a failed turn: the answer has already
 * been given and it does not become wrong because the transcript was not recorded.
 * So the error is returned for telemetry rather than raised.
 */
export const saveMemory = async (
  source: MemorySource | undefined,
  update: SessionUpdate,
): Promise<MemorySave> => {
  if (!source) return { ok: true };
  try {
    await source.save(update);
    return { ok: true };
  } catch (error) {
    return { ok: false, error };
  }
};

/**
 * Fail a memory operation after N consecutive failures, for M milliseconds.
 *
 * The third guard, and the one that matters in production. Without it, an outage
 * costs a timeout on **every turn** — the latency of a feature that cannot work, paid
 * by users who are trying to use the product. With it, the first few turns pay and
 * the rest are served from cache while the store recovers.
 *
 * A successful call resets the counter, so this is a circuit breaker rather than a
 * permanent mute.
 */
export const createMemoryCircuitBreaker = (options?: {
  /** Consecutive failures before opening. Default 3. */
  threshold?: number;
  /** How long to stay open. Default 30s. */
  cooldownMs?: number;
  /** Injected in tests. */
  now?: () => number;
}) => {
  const threshold = options?.threshold ?? 3;
  const cooldownMs = options?.cooldownMs ?? 30_000;
  const now = options?.now ?? (() => Date.now());
  let failures = 0;
  let openedAt = 0;

  return {
    /** True while the breaker is open and the cooldown has not elapsed. */
    isOpen(): boolean {
      if (failures < threshold) return false;
      return now() - openedAt < cooldownMs;
    },
    /** Note a failure; opens the breaker once the threshold is reached. */
    recordFailure(): void {
      failures += 1;
      if (failures === threshold) openedAt = now();
    },
    /** Note a success, closing the breaker. */
    recordSuccess(): void {
      failures = 0;
    },
    /** Consecutive failures so far. */
    get failures(): number {
      return failures;
    },
  };
};