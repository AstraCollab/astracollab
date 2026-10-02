/**
 * The memory backend the session talks to.
 *
 * `CognitiveMemory` used to be both the engine and the interface, so the turn
 * pipeline, the recall tool and `/memory` all knew the concrete class. The
 * hosted service cannot be that class — it is HTTP, so every interesting method
 * is async and none of them can fail loudly on a turn that already has an
 * answer — and a hosted deployment is a real configuration rather than a
 * hypothetical one. So the pipeline now depends on this interface, and there are
 * two implementations: the in-process engine over SQLite, and `@astracollab/cogmem`.
 *
 * Two properties are load-bearing:
 *
 * 1. **Nothing here throws into a turn.** A prompt block is an optimisation. If
 *    the service is down, the turn runs without memory and says so once, rather
 *    than failing a request the user is waiting on. Local mode cannot fail this
 *    way, but the contract is uniform so a caller never has to know which
 *    backend it has.
 * 2. **`describe()` is backend-neutral.** `/memory` renders one shape, so the two
 *    backends cannot drift into showing different things under the same command.
 */
import type {
  MemoryInjectionReport,
  MemoryItem,
  ProprioceptiveSelfModel,
} from "@astracollab/not-another-harness";

export type MemoryBackendKind = "local" | "hosted";

/** A contradiction, reduced to what any backend can answer. */
export type MemoryTensionView = {
  id: string;
  impact: "low" | "medium" | "critical";
  claimA: { source: string; statement: string };
  claimB: { source: string; statement: string };
  actionableQuestion: string;
};

/** What `/memory` and `/tensions` render, whichever backend is in use. */
export type MemoryDescription = {
  backend: MemoryBackendKind;
  /** Human-readable location: a file path, or a service URL. */
  location: string;
  /**
   * Turns this backend has learned from.
   *
   * Null when the backend has no such counter — the service reports totals for
   * the project rather than for this process, and a number that means something
   * subtly different is worse than an absent one.
   */
  turnsProcessed: number | null;
  counts: { L1: number; L2: number; L3: number };
  /**
   * What is actually held, in the user's words.
   *
   * The part of `/memory` a person reads to check it learned the right thing, so
   * it is the full statement rather than a gist. How much of it there is depends
   * on the backend, which is what `heldNote` is for.
   */
  held: Array<{ content: string; domains: string[] }>;
  heldNote: string;
  activeTensions: MemoryTensionView[];
  domains: Array<{ domain: string; reliability: number; samples: number }>;
  /**
   * The last failure, or null.
   *
   * Surfaced rather than swallowed: a silent memory failure is indistinguishable
   * from memory that is not working, which is the failure mode this whole layer
   * exists to avoid.
   */
  degraded: string | null;
};

export interface SessionMemory {
  readonly backend: MemoryBackendKind;
  /** Where this backend keeps things, for display. */
  readonly location: string;
  /** The most recent failure message, or null. */
  readonly degraded: string | null;

  /**
   * Decide what goes into this turn's prompt.
   *
   * Async because the hosted backend has to ask a server. Callers must be on a
   * path that can wait before the request is composed — see `resolveInjection`
   * in `./session.ts`.
   */
  planInjection(options?: { userMessage?: string; forceFull?: Iterable<string> }): Promise<MemoryInjectionReport>;

  /** Deterministic ranked lookup across every memory tier. */
  search(query: string, limit?: number): Promise<Array<{ item: MemoryItem; score: number }>>;

  /** Extraction, arbitration, budgeting and persistence for a finished turn. */
  postTurnAsync(turn: { userMessage: string; assistantResponse: string; sessionId?: string }): Promise<void>;

  describe(): Promise<MemoryDescription>;

  /** Close a contradiction. False when there was no such id. */
  resolveTension(id: string, resolution: { resolvedBy: string; pattern: string }): Promise<boolean>;
}

const EMPTY_INJECTION: MemoryInjectionReport = { text: "", entries: [], totalTokens: 0, truncated: false };

/** Reduce a self-model to the three numbers a person actually reads. */
export const selfModelRows = (selfModel: ProprioceptiveSelfModel | undefined) =>
  Object.entries(selfModel?.domains ?? {}).map(([domain, capability]) => ({
    domain,
    reliability: capability.reliabilityScore,
    samples: capability.sampleCount,
  }));

/**
 * The in-process engine, behind the interface.
 *
 * A thin wrapper rather than a subclass: the engine's methods are already the
 * right shape, so the only work here is turning a snapshot into the neutral
 * description and absorbing the one thing the engine can still do — throw out of
 * persistence, which `postTurnAsync` already swallows but `describe` would not.
 */
export const localMemory = (options: {
  memory: import("@astracollab/not-another-harness").CognitiveMemory;
  location: string;
  /** True when a previous session's memory was restored. */
  restored?: boolean;
  /** Set when a pre-SQLite JSON memory was imported. */
  importedFrom?: string;
}): SessionMemory => {
  let failure: string | null = null;
  const note = (error: unknown): void => {
    failure = error instanceof Error ? error.message : String(error);
  };

  return {
    backend: "local",
    location: options.location,
    get degraded() {
      return failure;
    },

    async planInjection(injection = {}) {
      try {
        return options.memory.planInjection({
          ...(injection.userMessage === undefined ? {} : { userMessage: injection.userMessage }),
          ...(injection.forceFull === undefined ? {} : { forceFull: injection.forceFull }),
        });
      } catch (error) {
        note(error);
        return EMPTY_INJECTION;
      }
    },

    async search(query, limit) {
      try {
        return limit === undefined ? options.memory.search(query) : options.memory.search(query, limit);
      } catch (error) {
        note(error);
        return [];
      }
    },

    async postTurnAsync(turn) {
      try {
        await options.memory.postTurnAsync({
          userMessage: turn.userMessage,
          assistantResponse: turn.assistantResponse,
        });
      } catch (error) {
        note(error);
      }
    },

    async describe() {
      const snapshot = options.memory.getSnapshot();
      return {
        backend: "local",
        location: options.location,
        turnsProcessed: snapshot.stats.totalTurnsProcessed,
        counts: { L1: snapshot.l1.length, L2: snapshot.l2.length, L3: snapshot.l3.length },
        // The whole hot cache. Truncating this at 80 characters made a complete
        // memory look like a broken one, and the point of the command is to check
        // exactly that.
        held: snapshot.l1.map((item) => ({ content: item.content, domains: item.metadata.domains })),
        heldNote: "shown in full",
        activeTensions: snapshot.l0.tensions
          .filter((tension) => tension.status === "active")
          .map((tension) => ({
            id: tension.id,
            impact: tension.impact,
            claimA: { source: tension.claimA.source, statement: tension.claimA.statement },
            claimB: { source: tension.claimB.source, statement: tension.claimB.statement },
            actionableQuestion: tension.actionableQuestion,
          })),
        domains: selfModelRows(snapshot.l0.selfModel),
        degraded: failure,
      };
    },

    async resolveTension(id, resolution) {
      try {
        return options.memory.resolveTension(id, resolution);
      } catch (error) {
        note(error);
        return false;
      }
    },
  };
};
