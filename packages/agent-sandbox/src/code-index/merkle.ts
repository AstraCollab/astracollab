import { createHash } from "node:crypto";

import type { FileMerkleEntry, FileMerkleTree } from "./types.js";

export const hashContent = (content: string | Buffer): string =>
  createHash("sha256").update(content).digest("hex");

export const hashFileMerkleRoot = (entries: FileMerkleEntry[]): string => {
  const sorted = [...entries].sort((a, b) => a.path.localeCompare(b.path));
  const h = createHash("sha256");
  for (const e of sorted) {
    h.update(`${e.path}\0${e.sha256}\0${e.size}\n`);
  }
  return h.digest("hex");
};

export const buildFileMerkleFromEntries = (entries: FileMerkleEntry[]): FileMerkleTree => ({
  entries,
  root: hashFileMerkleRoot(entries),
});

export const planIndexWork = (
  current: FileMerkleEntry[],
  prior: FileMerkleEntry[] | readonly FileMerkleEntry[] | null | undefined,
): import("./types.js").IndexWorkPlan => {
  const priorByPath = new Map((prior ?? []).map((e) => [e.path, e]));
  const currentByPath = new Map(current.map((e) => [e.path, e]));

  const added: string[] = [];
  const changed: string[] = [];
  const deleted: string[] = [];
  const unchanged: string[] = [];

  for (const e of current) {
    const prev = priorByPath.get(e.path);
    if (!prev) {
      added.push(e.path);
    } else if (prev.sha256 !== e.sha256) {
      changed.push(e.path);
    } else {
      unchanged.push(e.path);
    }
  }

  for (const p of priorByPath.keys()) {
    if (!currentByPath.has(p)) {
      deleted.push(p);
    }
  }

  return { added, changed, deleted, unchanged };
};
