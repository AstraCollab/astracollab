import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import * as nodePath from "node:path";
import type { ModelMessage } from "ai";

/**
 * Pi-style JSONL session store: one file per session, one append-only entry per
 * message, each entry pointing at its parent. The active branch is the linear
 * path back from the newest entry — cheap to persist, cheap to resume.
 */

type SessionEntry = {
  id: string;
  parentId: string | null;
  at: string;
  kind: "message";
  message: ModelMessage;
};

const entryId = (message: ModelMessage, at: string): string =>
  createHash("sha1").update(`${at}:${JSON.stringify(message)}`).digest("hex").slice(0, 16);

export const createJsonlSessionStore = (file: string) => {
  let tailId: string | null = null;

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

  return {
    /** Append messages (in order) to the active branch. */
    append: async (messages: ModelMessage[]): Promise<void> => {
      await fs.mkdir(nodePath.dirname(file), { recursive: true });
      if (tailId === null) {
        const all = await readAll();
        tailId = all.length > 0 ? all[all.length - 1]!.id : null;
      }
      const lines: string[] = [];
      for (const message of messages) {
        const at = new Date().toISOString();
        const id = entryId(message, at);
        const entry: SessionEntry = { id, parentId: tailId, at, kind: "message", message };
        tailId = id;
        lines.push(JSON.stringify(entry));
      }
      await fs.appendFile(file, `${lines.join("\n")}\n`, "utf8");
    },

    /** Load the active branch (linear path to the newest entry). */
    load: async (): Promise<ModelMessage[]> => {
      const all = await readAll();
      if (all.length === 0) {
        return [];
      }
      const byId = new Map(all.map((e) => [e.id, e]));
      const branch: SessionEntry[] = [];
      let cursor: SessionEntry | undefined = all[all.length - 1];
      while (cursor) {
        branch.unshift(cursor);
        cursor = cursor.parentId ? byId.get(cursor.parentId) : undefined;
        if (branch.length > all.length) {
          break; // parent cycle guard
        }
      }
      tailId = branch[branch.length - 1]?.id ?? null;
      return branch.map((e) => e.message);
    },

    path: file,
  };
};

export type JsonlSessionStore = ReturnType<typeof createJsonlSessionStore>;
