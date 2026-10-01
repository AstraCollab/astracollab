import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import * as nodePath from "node:path";
import type { ModelMessage } from "ai";

/**
 * Pi-style JSONL session store: one file per session, one append-only entry per
 * message, each entry pointing at its parent. The active branch is the linear
 * path back from the newest entry — cheap to persist, cheap to resume.
 */

type MessageEntry = {
  id: string;
  parentId: string | null;
  at: string;
  kind: "message";
  message: ModelMessage;
};

type ResetEntry = {
  id: string;
  parentId: null;
  at: string;
  kind: "reset";
};

/**
 * Cumulative counters for the session as it stands, written after every turn.
 *
 * They live in the transcript file because that is the only thing a resumed
 * process can read: without them a session that spent 400k tokens comes back
 * reporting `0 turns · 0 in · 0 out`, which reads as "the run was lost" even
 * though every message is on disk. A `usage` entry is not a message, so it does
 * not take part in the branch walk — it is the last such record that counts.
 */
export type SessionUsage = {
  turns: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  /** Provider-reported input size of the most recent step, i.e. context in use. */
  contextUsedTokens: number;
  contextUsageEstimated: boolean;
  lastOutputTokens: number;
};

/**
 * One model request's accounting, kept per step.
 *
 * The cumulative `usage` record answers "what has this session spent". It cannot
 * answer "why did that turn cost 550k", because that number and a provider's
 * per-request figure differ by the step count and the replayed transcript - and
 * telling those apart used to mean reconstructing it by hand from the
 * transcript.
 *
 * `requestTokens` is this single request's prompt size and the rest is its cache
 * composition, which together explain the gap between a turn's total and what
 * any one call was billed for.
 */
export type SessionStepUsage = {
  /** 1-based turn number within the session. */
  turn: number;
  /** 1-based step number within the turn. */
  step: number;
  /** Run-cumulative totals as of this step. */
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  /** This request's prompt size, cached prefix included. */
  requestTokens: number;
  freshInputTokens: number;
  cachedInputTokens: number;
  cacheCreationInputTokens: number;
  /** Cached share of this request, 0-1. */
  hitRate: number;
  /** True when the provider reported no usage and figures were estimated. */
  estimated: boolean;
  at: string;
};

type StepUsageEntry = SessionStepUsage & {
  id: string;
  kind: "step-usage";
};

type UsageEntry = SessionUsage & {
  id: string;
  at: string;
  kind: "usage";
};

type SessionEntry = MessageEntry | ResetEntry | UsageEntry | StepUsageEntry;

const EMPTY_USAGE: SessionUsage = {
  turns: 0,
  inputTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
  contextUsedTokens: 0,
  contextUsageEstimated: false,
  lastOutputTokens: 0,
};

const counter = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;

const normalizeUsage = (value: unknown): SessionUsage | null => {
  if (!value || typeof value !== "object") return null;
  const raw = value as Partial<UsageEntry>;
  if (typeof raw.turns !== "number" || !Number.isFinite(raw.turns) || raw.turns < 0) return null;
  return {
    turns: Math.floor(raw.turns),
    inputTokens: counter(raw.inputTokens),
    outputTokens: counter(raw.outputTokens),
    totalTokens: counter(raw.totalTokens),
    contextUsedTokens: counter(raw.contextUsedTokens),
    contextUsageEstimated: raw.contextUsageEstimated === true,
    lastOutputTokens: counter(raw.lastOutputTokens),
  };
};

export type SessionTaskLedger = {
  version: 2;
  goal: string;
  status: "in_progress" | "blocked" | "completed";
  steps: Array<{ id: string; title: string; status: "pending" | "in_progress" | "completed" | "blocked"; note?: string }>;
  checks: Array<{
    id: string;
    description: string;
    command: string;
    status: "pending" | "passed" | "failed";
    attempts: Array<{ command: string; exitCode: number; at: string; durationMs: number; output: string }>;
  }>;
  updatedAt: string;
};

const isTaskLedger = (value: unknown): value is SessionTaskLedger => {
  if (!value || typeof value !== "object") return false;
  const ledger = value as Partial<SessionTaskLedger>;
  return ledger.version === 2 &&
    typeof ledger.goal === "string" &&
    ["in_progress", "blocked", "completed"].includes(String(ledger.status)) &&
    typeof ledger.updatedAt === "string" &&
    Array.isArray(ledger.steps) &&
    ledger.steps.every((step) => step && typeof step.id === "string" && typeof step.title === "string" && ["pending", "in_progress", "completed", "blocked"].includes(step.status)) &&
    Array.isArray(ledger.checks) &&
    ledger.checks.every((check) => check && typeof check.id === "string" && typeof check.description === "string" && typeof check.command === "string" && ["pending", "passed", "failed"].includes(check.status) && Array.isArray(check.attempts) && check.attempts.every((attempt) => attempt && typeof attempt.command === "string" && Number.isInteger(attempt.exitCode) && typeof attempt.at === "string" && Number.isFinite(attempt.durationMs) && typeof attempt.output === "string"));
};

const normalizeTaskLedger = (value: unknown): SessionTaskLedger | null => {
  if (isTaskLedger(value)) return value;
  if (!value || typeof value !== "object") return null;
  const old = value as { version?: number; goal?: string; status?: string; steps?: SessionTaskLedger["steps"]; checks?: Array<{ id: string; description: string; status: "pending" | "passed" | "failed" }>; updatedAt?: string };
  if (old.version !== 1 || typeof old.goal !== "string" || !Array.isArray(old.steps) || !Array.isArray(old.checks)) return null;
  return {
    version: 2,
    goal: old.goal,
    status: old.status === "blocked" ? "blocked" : "in_progress",
    steps: old.steps,
    checks: old.checks.map((check) => ({ id: check.id, description: check.description, command: "", status: "pending", attempts: [] })),
    updatedAt: new Date().toISOString(),
  };
};

const entryId = (message: ModelMessage, at: string): string =>
  createHash("sha1").update(`${at}:${JSON.stringify(message)}`).digest("hex").slice(0, 16);

export type JsonlSessionStore = {
  append(messages: ModelMessage[]): Promise<void>;
  replace(messages: ModelMessage[]): Promise<void>;
  reset(): Promise<void>;
  load(): Promise<ModelMessage[]>;
  loadUsage(): Promise<SessionUsage>;
  saveUsage(usage: SessionUsage): Promise<void>;
  /** Append one step's accounting. Cheap enough to call per step. */
  appendStepUsage(record: Omit<SessionStepUsage, "at">): Promise<void>;
  /** Every step record in file order. Empty for a file written before these. */
  loadStepUsage(): Promise<SessionStepUsage[]>;
  loadTaskLedger(): Promise<SessionTaskLedger | null>;
  saveTaskLedger(ledger: SessionTaskLedger | null): Promise<void>;
  fork(destination: string): Promise<JsonlSessionStore>;
  path: string;
};

export const createJsonlSessionStore = (file: string): JsonlSessionStore => {
  const taskFile = `${file}.task.json`;
  let tailId: string | null = null;
  let pending: Promise<void> = Promise.resolve();

  const serialize = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = pending.then(operation, operation);
    pending = result.then(() => undefined, () => undefined);
    return result;
  };

  const readAll = async (): Promise<SessionEntry[]> => {
    let raw: string;
    try {
      raw = await fs.readFile(file, "utf8");
    } catch {
      return [];
    }
    const out: SessionEntry[] = [];
    for (const line of raw.split("\n")) {
      const t = line.trim();
      if (!t.length) {
        continue;
      }
      try {
        out.push(JSON.parse(t) as SessionEntry);
      } catch {
        // skip corrupt line
      }
    }
    return out;
  };

  /**
   * The newest `message` entry, skipping `reset` and `usage` records.
   *
   * Both of those sit in the same file but are not part of the branch chain, so
   * treating the physically-last line as the tail would either truncate the
   * transcript at a usage record or chain the next message onto one.
   */
  const lastMessage = (all: SessionEntry[]): MessageEntry | undefined => {
    for (let i = all.length - 1; i >= 0; i -= 1) {
      const entry = all[i]!;
      if (entry.kind === "message") return entry;
    }
    return undefined;
  };

  const ensureTail = async (): Promise<void> => {
    if (tailId === null) {
      tailId = lastMessage(await readAll())?.id ?? null;
    }
  };

  const appendMessages = async (messages: ModelMessage[]): Promise<void> => {
    const lines: string[] = [];
    for (const message of messages) {
      const at = new Date().toISOString();
      const id = entryId(message, at);
      const entry: MessageEntry = { id, parentId: tailId, at, kind: "message", message };
      tailId = id;
      lines.push(JSON.stringify(entry));
    }
    if (lines.length > 0) {
      await fs.appendFile(file, `${lines.join("\n")}\n`, "utf8");
    }
  };

  const writeReset = async (): Promise<void> => {
    const at = new Date().toISOString();
    const id = createHash("sha1").update(`${at}:reset:${randomUUID()}`).digest("hex").slice(0, 16);
    const marker: ResetEntry = { id, parentId: null, at, kind: "reset" };
    await fs.appendFile(file, `${JSON.stringify(marker)}\n`, "utf8");
    tailId = id;
  };

  const writeUsage = async (usage: SessionUsage): Promise<void> => {
    const at = new Date().toISOString();
    const id = createHash("sha1").update(`${at}:usage:${randomUUID()}`).digest("hex").slice(0, 16);
    // `parentId` is null on purpose: usage is a side-channel, not a link in the
    // message chain, and must never become the tail an appended message points
    // back to.
    const entry: UsageEntry = { id, at, kind: "usage", ...EMPTY_USAGE, ...usage };
    await fs.appendFile(file, `${JSON.stringify(entry)}\n`, "utf8");
  };

  const writeStepUsage = async (record: Omit<SessionStepUsage, "at">): Promise<void> => {
    const at = new Date().toISOString();
    const id = createHash("sha1").update(`${at}:step-usage:${randomUUID()}`).digest("hex").slice(0, 16);
    // No `parentId`: like `usage`, this is a side-channel and must never become
    // the tail that a later message chains back to.
    const entry: StepUsageEntry = { id, at, kind: "step-usage", ...record };
    await fs.appendFile(file, `${JSON.stringify(entry)}\n`, "utf8");
  };

  const readStepUsage = async (): Promise<SessionStepUsage[]> => {
    const all = await readAll();
    const out: SessionStepUsage[] = [];
    for (const entry of all) {
      if (entry.kind !== "step-usage") continue;
      const { id: _id, kind: _kind, ...record } = entry;
      out.push(record);
    }
    return out;
  };

  /** The most recent `usage` record, or zeroes when the file has none. */
  const readUsage = async (): Promise<SessionUsage> => {
    const all = await readAll();
    for (let i = all.length - 1; i >= 0; i -= 1) {
      const entry = all[i]!;
      if (entry.kind !== "usage") continue;
      return normalizeUsage(entry) ?? EMPTY_USAGE;
    }
    return EMPTY_USAGE;
  };

  return {
    /** Append messages (in order) to the active branch. */
    append: (messages: ModelMessage[]): Promise<void> => serialize(async () => {
      if (messages.length === 0) return;
      await fs.mkdir(nodePath.dirname(file), { recursive: true });
      await ensureTail();
      await appendMessages(messages);
    }),

    /** Start a fresh active branch while retaining prior entries in the JSONL file. */
    replace: (messages: ModelMessage[]): Promise<void> => serialize(async () => {
      await fs.mkdir(nodePath.dirname(file), { recursive: true });
      await ensureTail();
      await writeReset();
      await appendMessages(messages);
    }),

    /** Clear the active branch without deleting its previous entries. */
    reset: (): Promise<void> => serialize(async () => {
      await fs.mkdir(nodePath.dirname(file), { recursive: true });
      await ensureTail();
      await writeReset();
      // A cleared transcript has spent nothing, so its counters go with it.
      await writeUsage(EMPTY_USAGE);
      await fs.rm(taskFile, { force: true });
    }),

    /** Load the active branch (linear path to the newest message entry). */
    load: (): Promise<ModelMessage[]> => serialize(async () => {
      const all = await readAll();
      const newest = lastMessage(all);
      tailId = newest?.id ?? null;
      if (!newest) return [];
      const byId = new Map(all.map((entry) => [entry.id, entry]));
      const branch: MessageEntry[] = [];
      let cursor: SessionEntry | undefined = newest;
      let visited = 0;
      while (cursor?.kind === "message") {
        branch.unshift(cursor);
        cursor = cursor.parentId ? byId.get(cursor.parentId) : undefined;
        visited += 1;
        if (visited > all.length) break;
      }
      return branch.map((entry) => entry.message);
    }),

    /** Cumulative counters for the session, or zeroes when none were recorded. */
    loadUsage: (): Promise<SessionUsage> => serialize(readUsage),

    appendStepUsage: (record): Promise<void> => serialize(async () => {
      await fs.mkdir(nodePath.dirname(file), { recursive: true });
      await writeStepUsage(record);
    }),

    loadStepUsage: (): Promise<SessionStepUsage[]> => serialize(readStepUsage),

    /** Record the running totals, so a resumed process can report them. */
    saveUsage: (usage): Promise<void> => serialize(async () => {
      await fs.mkdir(nodePath.dirname(file), { recursive: true });
      await writeUsage(usage);
    }),

    loadTaskLedger: (): Promise<SessionTaskLedger | null> => serialize(async () => {
      try {
        const parsed: unknown = JSON.parse(await fs.readFile(taskFile, "utf8"));
        const normalized = normalizeTaskLedger(parsed);
        return normalized;
      } catch {
        return null;
      }
    }),

    saveTaskLedger: (ledger): Promise<void> => serialize(async () => {
      if (ledger === null) {
        await fs.rm(taskFile, { force: true });
        return;
      }
      await fs.mkdir(nodePath.dirname(taskFile), { recursive: true });
      const temporary = `${taskFile}.${randomUUID()}.tmp`;
      await fs.writeFile(temporary, `${JSON.stringify(ledger, null, 2)}\n`, "utf8");
      await fs.rename(temporary, taskFile);
    }),

    fork: async (destination) => {
      const branch = createJsonlSessionStore(destination);
      const messages = await serialize(async () => {
        const all = await readAll();
        const newest = lastMessage(all);
        if (!newest) return [];
        const byId = new Map(all.map((entry) => [entry.id, entry]));
        const messages: ModelMessage[] = [];
        let cursor: SessionEntry | undefined = newest;
        let visited = 0;
        while (cursor?.kind === "message") {
          messages.unshift(cursor.message);
          cursor = cursor.parentId ? byId.get(cursor.parentId) : undefined;
          if (++visited > all.length) break;
        }
        return messages;
      });
      // The fork starts from the parent's transcript, so it inherits the
      // parent's spend rather than reporting a fresh zeroed session.
      const usage = await serialize(readUsage);
      await branch.replace(messages);
      await branch.saveUsage(usage);
      await branch.saveTaskLedger(await serialize(async () => {
        try {
          return normalizeTaskLedger(JSON.parse(await fs.readFile(taskFile, "utf8")));
        } catch {
          return null;
        }
      }));
      return branch;
    },

    path: file,
  };
};
