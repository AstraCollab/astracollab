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

type SessionEntry = MessageEntry | ResetEntry;

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

  const ensureTail = async (): Promise<void> => {
    if (tailId === null) {
      const all = await readAll();
      tailId = all[all.length - 1]?.id ?? null;
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
      await fs.rm(taskFile, { force: true });
    }),

    /** Load the active branch (linear path to the newest entry). */
    load: (): Promise<ModelMessage[]> => serialize(async () => {
      const all = await readAll();
      tailId = all[all.length - 1]?.id ?? null;
      if (all.length === 0) return [];
      const byId = new Map(all.map((entry) => [entry.id, entry]));
      const branch: MessageEntry[] = [];
      let cursor: SessionEntry | undefined = all[all.length - 1];
      let visited = 0;
      while (cursor?.kind === "message") {
        branch.unshift(cursor);
        cursor = cursor.parentId ? byId.get(cursor.parentId) : undefined;
        visited += 1;
        if (visited > all.length) break;
      }
      return branch.map((entry) => entry.message);
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
        if (all.length === 0) return [];
        const byId = new Map(all.map((entry) => [entry.id, entry]));
        const messages: ModelMessage[] = [];
        let cursor: SessionEntry | undefined = all[all.length - 1];
        let visited = 0;
        while (cursor?.kind === "message") {
          messages.unshift(cursor.message);
          cursor = cursor.parentId ? byId.get(cursor.parentId) : undefined;
          if (++visited > all.length) break;
        }
        return messages;
      });
      await branch.replace(messages);
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
