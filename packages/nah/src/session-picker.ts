import * as nodePath from "node:path";

import { defaultSessionFile, listSessionIds } from "./context.js";
import { c } from "./render.js";
import { pickFromList } from "./list-picker.js";
import { loadSessionName } from "./session.js";

/** One row in the `/session` picker. */
export type SessionRow = {
  /** What Enter returns: the id `/session <id>` takes. */
  value: string;
  id: string;
  /** The display name the user gave the session, or null when it is still just an id. */
  name: string | null;
  /** Pre-formatted for display; the raw value is not kept for the filter. */
  modified: string;
  active: boolean;
};

const when = (value: number | string): string => {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleString();
};

/**
 * This directory's saved sessions, newest first, with the current one marked.
 *
 * A directory with no sessions yet is not an error — it resolves to an empty
 * list so a bare `/session` can say so rather than fail.
 *
 * Each row carries the session's display name (loaded from its `.name.json`
 * sidecar) so the picker can show what a session is for rather than only its
 * opaque file id.
 */
export const listSessions = async (cwd: string, activePath?: string): Promise<SessionRow[]> => {
  let sessions: Awaited<ReturnType<typeof listSessionIds>> = [];
  try {
    sessions = await listSessionIds(cwd);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const directory = nodePath.dirname(defaultSessionFile(cwd));
  const rows = await Promise.all(
    sessions.map(async (session) => {
      const path = nodePath.join(directory, `${session.id}.jsonl`);
      const { createJsonlSessionStore } = await import("not-another-harness");
      const name = await loadSessionName(createJsonlSessionStore(path));
      return {
        value: session.id,
        id: session.id,
        name,
        modified: when(session.modified),
        active: activePath === path,
      };
    }),
  );
  return rows;
};

/**
 * The `/session` picker: the same ↑/↓ and type-to-filter interaction as
 * `/model`, over a preloaded list of sessions. Resolves to the chosen session's
 * id, or undefined when the user cancels.
 */
export const pickSession = (
  sessions: readonly SessionRow[],
  activePath: string | undefined,
): Promise<string | undefined> =>
  pickFromList<SessionRow>({
    title: "Select a session",
    hint: "Type to search · ↑/↓ move · Enter switch · Esc cancel",
    items: sessions,
    filter: (items, query) => {
      if (!query) return items;
      const needle = query.toLowerCase();
      return items.filter((row) => `${row.id} ${row.name ?? ""} ${row.modified}`.toLowerCase().includes(needle));
    },
    format: (row) => `${row.name ?? row.id}${row.active ? c.green(" · active") : ""}  ${c.dim(row.modified)}`,
    searchText: (row) => `${row.id} ${row.name ?? ""} ${row.modified}`,
    searchPlaceholder: "session id or name…",
    emptyText: "No matching sessions",
    footer: (count) => `${count} session${count === 1 ? "" : "s"} · enter to switch · esc to cancel`,
  });