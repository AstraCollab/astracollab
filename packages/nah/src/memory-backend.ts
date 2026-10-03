/**
 * The memory backend the session talks to.
 *
 * `CognitiveMemory` used to be both the engine and the interface, so the turn
 * pipeline, the recall tool and `/memory` all knew the concrete class. The
 * hosted service cannot be that class — it is HTTP, so every interesting method
 * is async and none of them can fail loudly on a turn that already has an
 * answer — and a hosted deployment is a real configuration rather than a
 * hypothetical one. So the pipeline now depends on this interface, and there are
 * two implementations: the in-process engine over SQLite, and `cogmemory`.
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
} from "not-another-harness";

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

/** A fact being written, before any backend has decided where it lands. */
export type MemoryWrite = {
  /** The statement itself. Backends store it as given, trimmed. */
  content: string;
  /** Short tags for grouping. Optional: a fact with none is still a fact. */
  domains?: string[];
  /**
   * Which cache it goes in.
   *
   * L1 is pre-staged into every context build and is what the user sees as
   * "remembered"; L2 is recalled on demand; L3 is the archive. Default L1,
   * because a fact a person bothered to state out loud is one they expect to be
   * there next turn without anyone asking for it.
   */
  tier?: "L1" | "L2" | "L3";
};

/** What a write actually did, as opposed to what was asked for. */
export type MemoryWriteResult = {
  /** Ids now held. Empty when the write was rejected or the backend is down. */
  stored: string[];
  /**
   * True when this restated something already held rather than adding to it.
   *
   * Reported rather than hidden because "saved" and "already knew this" are
   * different answers, and a caller that prints one for the other is lying.
   */
  merged: boolean;
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

  /**
   * Record a fact the user stated outright.
   *
   * The write half of the pair with `search`. It obeys the same contract as the
   * rest of this interface — it never throws into a turn — but a failed write
   * returns an empty `stored` rather than an error, so the caller has to check.
   * That is deliberate: a tool that claims a memory was saved when the backend
   * refused is the failure this whole layer exists to prevent.
   */
  remember(entry: MemoryWrite): Promise<MemoryWriteResult>;

  /**
   * Drop a memory by id. False when no such id was held.
   *
   * Corrections need this as much as additions need `remember`: storing the
   * right answer beside the wrong one leaves both to be recalled, and the wrong
   * one is the one that sounds authoritative.
   */
  forget(id: string): Promise<boolean>;

  /** Close a contradiction. False when there was no such id. */
  resolveTension(id: string, resolution: { resolvedBy: string; pattern: string }): Promise<boolean>;
}

const EMPTY_INJECTION: MemoryInjectionReport = { text: "", entries: [], totalTokens: 0, truncated: false };

/**
 * Two spellings of one statement, for deciding whether a write is a restatement.
 *
 * Case and trailing punctuation only. Anything looser starts folding facts
 * together that are not the same, and a fold that discards something the user
 * just said is worse than storing a near-duplicate.
 */
const sameStatement = (a: string, b: string): boolean =>
  a.trim().toLowerCase().replace(/[.!?,;:]+$/, "").trim() === b.trim().toLowerCase().replace(/[.!?,;:]+$/, "").trim();

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
  memory: import("not-another-harness").CognitiveMemory;
  location: string;
  /** True when a previous session's memory was restored. */
  restored?: boolean;
  /** Set when a pre-SQLite JSON memory was imported. */
  importedFrom?: string;
  /**
   * Persist after a write.
   *
   * Optional so a caller that only ever reads does not have to construct one,
   * and a no-op when omitted — which is the honest outcome, since the engine
   * would otherwise hold a write that the next `postTurnAsync` never saw.
   */
  flush?: () => Promise<void>;
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

    async remember(entry) {
      try {
        const content = entry.content.trim();
        if (!content) return { stored: [], merged: false };
        // Fold an exact restatement rather than storing it twice. The engine's
        // turn-time reconciler does this with a model in the loop; a tool call is
        // not worth one, and the engine has no non-model path for it. Anything
        // short of an exact match is treated as a new fact rather than guessed
        // at — a wrong fold silently discards something the user just said.
        const same = options.memory.search(content, 5).find(({ item }) => sameStatement(item.content, content));
        if (same) return { stored: [same.item.id], merged: true };

        const tier = entry.tier ?? "L1";
        const id = `mem-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
        const now = Date.now();
        options.memory.addMemory(
          {
            id,
            content,
            bookmark: content.slice(0, 80),
            tier,
            metadata: {
              domains: entry.domains ?? [],
              createdAt: now,
              lastAccessedAt: now,
              accessCount: 0,
            },
          },
          tier,
        );
        await options.flush?.();
        return { stored: [id], merged: false };
      } catch (error) {
        note(error);
        return { stored: [], merged: false };
      }
    },

    async forget(id) {
      try {
        // Nothing to persist when nothing was held, so the flush is not paid for
        // on the common "that id was already gone" path.
        if (!options.memory.removeMemory(id)) return false;
        await options.flush?.();
        return true;
      } catch (error) {
        note(error);
        return false;
      }
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
