import * as nodePath from "node:path";

import { defaultSessionFile, listSessionIds } from "./context.js";
import { c } from "./render.js";
import { pickFromList } from "./list-picker.js";

/** One row in the `/session` picker. */
export type SessionRow = {
  /** What Enter returns: the id `/session <id>` takes. */
  value: string;
  id: string;
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
 */
export const listSessions = async (cwd: string, activePath?: string): Promise<SessionRow[]> => {
  let sessions: Awaited<ReturnType<typeof listSessionIds>> = [];
  try {
    sessions = await listSessionIds(cwd);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const directory = nodePath.dirname(defaultSessionFile(cwd));
  return sessions.map((session) => ({
    value: session.id,
    id: session.id,
    modified: when(session.modified),
    active: activePath === nodePath.join(directory, `${session.id}.jsonl`),
  }));
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
      return items.filter((row) => `${row.id} ${row.modified}`.toLowerCase().includes(needle));
    },
    format: (row) => `${row.id}${row.active ? c.green(" · active") : ""}  ${c.dim(row.modified)}`,
    searchText: (row) => `${row.id} ${row.modified}`,
    searchPlaceholder: "session id…",
    emptyText: "No matching sessions",
    footer: (count) => `${count} session${count === 1 ? "" : "s"} · enter to switch · esc to cancel`,
  });