/**
 * The hosted backend: `@astracollab/cogmem` behind `SessionMemory`.
 *
 * The service is the same cognitive layer the CLI runs in-process, moved behind
 * an API — same four tiers, same index/body split, same deterministic recall —
 * so switching backends does not change what the model sees, only who stores it.
 *
 * Everything here is written around one constraint: **part of this runs on a turn
 * the user is waiting on.** A network call that is slow, refused, rate-limited or
 * simply absent must never be the reason a turn fails, and must never be
 * invisible either. So every call is bounded, every failure is recorded on the
 * backend for `/memory` to show, and the turn continues with no memory block.
 */
import {
  CognitiveMemoryError,
  createClient,
  type Cogmem,
  type CognitiveMemoryConfig,
  type ContextEntry,
  type Memory as ServiceMemory,
} from "@astracollab/cogmem";
import type { MemoryInjectionReport, MemoryItem } from "not-another-harness";

import type { MemoryDescription, MemoryTensionView, SessionMemory } from "./memory-backend.js";

/**
 * How long the pre-turn context build may take.
 *
 * The SDK default is 30s, which is right for a batch job and wrong here: this
 * call is in front of the user's prompt, so every second of it is a second
 * before the model starts typing. Five seconds is long enough for a healthy
 * service on a cold connection and short enough that a blackholed one reads as a
 * miss rather than a hang.
 */
const CONTEXT_TIMEOUT_MS = 5_000;

/**
 * Retries on the hot path.
 *
 * One, not the SDK default of two: this is a single call in front of a turn, and
 * a third attempt would land after the user gave up and pressed Ctrl-C. Retries
 * stay on at all because a dropped connection is exactly the case worth one more
 * try.
 */
const CONTEXT_RETRIES = 1;

const EMPTY_INJECTION: MemoryInjectionReport = { text: "", entries: [], totalTokens: 0, truncated: false };

/**
 * The service's memory, in the engine's shape.
 *
 * Both describe the same row, but one nests metadata and the other flattens
 * `domains`, and the recall tool and the trigger detector read the engine shape.
 * Converting here means those two callers keep working unchanged against either
 * backend.
 */
const toItem = (memory: ServiceMemory): MemoryItem => ({
  id: memory.id,
  content: memory.content,
  ...(memory.gist === undefined ? {} : { gist: memory.gist }),
  bookmark: (memory.gist ?? memory.content).slice(0, 80),
  tier: memory.tier,
  metadata: {
    domains: memory.domains,
    createdAt: memory.createdAt,
    lastAccessedAt: memory.lastAccessedAt,
    accessCount: memory.accessCount,
    ...(memory.sessionId === undefined ? {} : { sourceSessionId: memory.sessionId }),
  },
});

/**
 * The service reports *why* an entry was included in the same vocabulary the
 * engine uses, so this is a field-by-field copy rather than a cast: a cast would
 * let a reason the service invents pass as a valid local one.
 */
const toEntry = (entry: ContextEntry): MemoryInjectionReport["entries"][number] => ({
  id: entry.id,
  tier: entry.tier,
  reason: entry.reason,
  gist: entry.gist,
  ...(entry.body === undefined ? {} : { body: entry.body }),
  tokens: entry.tokens,
});

const toTension = (tension: {
  id: string;
  impact: "low" | "medium" | "critical";
  claimA: { source: string; statement: string };
  claimB: { source: string; statement: string };
  actionableQuestion: string;
}): MemoryTensionView => ({
  id: tension.id,
  impact: tension.impact,
  claimA: { source: tension.claimA.source, statement: tension.claimA.statement },
  claimB: { source: tension.claimB.source, statement: tension.claimB.statement },
  actionableQuestion: tension.actionableQuestion,
});

/** A short, specific line: what failed, and what to do about it. */
const describeFailure = (error: unknown): string => {
  if (error instanceof CognitiveMemoryError) {
    if (error.isAuthError()) return "the service rejected the API key (401) — run /cogmem key to replace it";
    if (error.isScopeError()) return `the key lacks the ${error.requiredScope ?? "required"} scope (403)`;
    if (error.isNotFoundError()) return "the service has no record of that id (404)";
    if (error.isRateLimitError()) return "the service is rate limiting this key (429)";
    return `${error.message} (${error.status})`;
  }
  const message = error instanceof Error ? error.message : String(error);
  // A bare transport failure carries no status, and "fetch failed" on its own is
  // not something a user can act on.
  return /fetch failed|ENOTFOUND|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN/i.test(message)
    ? `could not reach the service: ${message}`
    : message;
};

export type HostedMemoryOptions = {
  apiKey: string;
  baseUrl: string;
  /** Overridable for tests. Applies to the pre-turn call. */
  contextTimeoutMs?: number;
  debug?: boolean;
};

export type HostedMemory = SessionMemory & {
  /** For `/cogmem`: the health check and the local-to-hosted import. */
  client: Cogmem;
  checkHealth(): ReturnType<Cogmem["health"]>;
};

/**
 * Build the hosted backend.
 *
 * Construction performs no I/O. A service that is down must not stop the CLI
 * from starting, and `/cogmem setup` needs a client it can point at a URL that
 * is still being typed. `checkHealth` is the explicit way to find out whether it
 * works.
 *
 * Two clients, not one, because the resource methods take no per-request
 * timeout: the only call in front of the user gets a short budget, and the work
 * that happens after the answer gets the SDK's. Same key, same URL — only the
 * patience differs.
 */
export const hostedMemory = (options: HostedMemoryOptions): HostedMemory => {
  const shared: Omit<CognitiveMemoryConfig, "timeout" | "retry"> = {
    apiKey: options.apiKey,
    baseUrl: options.baseUrl,
    debug: options.debug ?? process.env.NAH_MEMORY_DEBUG === "1",
  };
  const hot = createClient({ ...shared, timeout: options.contextTimeoutMs ?? CONTEXT_TIMEOUT_MS, retry: CONTEXT_RETRIES });
  const warm = createClient(shared);
  let failure: string | null = null;

  const note = (label: string, error: unknown): void => {
    failure = describeFailure(error);
    if (process.env.NAH_MEMORY_DEBUG === "1") console.log(`  [cogmem] ${label} failed: ${failure}`);
  };

  return {
    client: warm,
    backend: "hosted",
    location: options.baseUrl,
    get degraded() {
      return failure;
    },

    checkHealth: () => warm.health(),

    async planInjection(injection = {}) {
      try {
        const report = await hot.context.build({
          ...(injection.userMessage === undefined ? {} : { userMessage: injection.userMessage }),
          ...(injection.forceFull === undefined ? {} : { forceFull: [...injection.forceFull] }),
        });
        failure = null;
        return {
          text: report.text,
          entries: report.entries.map(toEntry),
          totalTokens: report.totalTokens,
          truncated: report.truncated,
        };
      } catch (error) {
        // The turn continues without a memory block. That is the whole point of
        // the fallback: an empty prompt is a worse turn, not a failed one.
        note("context.build", error);
        return EMPTY_INJECTION;
      }
    },

    async search(query, limit) {
      try {
        const response = await warm.recall.search({ query, ...(limit === undefined ? {} : { limit }) });
        failure = null;
        return response.results.map((hit) => ({ item: toItem(hit.memory), score: hit.score }));
      } catch (error) {
        note("recall.search", error);
        return [];
      }
    },

    async postTurnAsync(turn) {
      try {
        await warm.turns.learn({
          userMessage: turn.userMessage,
          assistantResponse: turn.assistantResponse,
          ...(turn.sessionId === undefined ? {} : { sessionId: turn.sessionId }),
        });
        failure = null;
      } catch (error) {
        // Background work, so a miss is not worth a retry: the next turn tries
        // again, and the fact is still in the transcript.
        note("turns.learn", error);
      }
    },

    async describe() {
      try {
        const [stats, selfModel] = await Promise.all([warm.stats.get(), warm.selfModel.get()]);
        failure = null;
        return {
          backend: "hosted",
          location: options.baseUrl,
          // The service counts the project, not this process, so a per-run number
          // would be a lie. See MemoryDescription.
          turnsProcessed: null,
            counts: {
              L1: stats.memories.byTier.L1 ?? 0,
              L2: stats.memories.byTier.L2 ?? 0,
              L3: stats.memories.byTier.L3 ?? 0,
            },
            // `stats` already carries the recent list, so reading what is held
            // costs no extra round trip. It is recent rather than complete, and
            // the label says so rather than implying the cache is this short.
            held: stats.recent.map((memory) => ({ content: memory.content, domains: memory.domains })),
            heldNote: "most recent, as the service reports them",
          activeTensions: stats.activeTensions.map(toTension),
          domains: Object.entries(selfModel.domains).map(([domain, capability]) => ({
            domain,
            reliability: capability.reliabilityScore,
            samples: capability.sampleCount,
          })),
          degraded: null,
        };
      } catch (error) {
        note("stats.get", error);
        const empty: MemoryDescription = {
          backend: "hosted",
          location: options.baseUrl,
          turnsProcessed: null,
          counts: { L1: 0, L2: 0, L3: 0 },
          held: [],
          heldNote: "unavailable while the service cannot be reached",
          activeTensions: [],
          domains: [],
          degraded: failure,
        };
        return empty;
      }
    },

    async resolveTension(id, resolution) {
      try {
        await warm.tensions.resolve(id, { resolvedBy: resolution.resolvedBy, pattern: resolution.pattern });
        failure = null;
        return true;
      } catch (error) {
        // A missing tension is the caller's answer, not a backend failure: the id
        // was wrong and the service is fine.
        if (error instanceof CognitiveMemoryError && error.isNotFoundError()) return false;
        note("tensions.resolve", error);
        return false;
      }
    },
  };
};
