import picomatch from "picomatch";

import type { RepoSandboxFs } from "../sandbox-fs/repo-fs-port.js";
import type { FileMerkleEntry } from "./types.js";
import { hashContent } from "./merkle.js";
import { isIndexablePath } from "./chunk.js";

const toRepoRelative = (absolutePath: string, repoRoot: string): string => {
  const root = repoRoot.endsWith("/") ? repoRoot : `${repoRoot}/`;
  const norm = absolutePath.startsWith(root) ? absolutePath.slice(root.length) : absolutePath;
  return norm.replace(/^\/+/, "");
};

export const walkIndexableFiles = async (opts: {
  repoFs: RepoSandboxFs;
  repoRelativeRoot?: string;
  ignoreGlobs?: string[];
  maxFiles?: number;
}): Promise<FileMerkleEntry[]> => {
  const repoRoot = opts.repoFs.repoRoot;
  const relRoot = (opts.repoRelativeRoot ?? "").replace(/^\/+/, "");
  const startAbs = relRoot ? `${repoRoot}/${relRoot}` : repoRoot;
  const isIgnored = picomatch(opts.ignoreGlobs ?? ["**/node_modules/**", "**/.git/**"], {
    dot: true,
  });

  const entries: FileMerkleEntry[] = [];
  const queue: string[] = [startAbs];

  while (queue.length > 0) {
    const dir = queue.shift()!;
    let listed;
    try {
      listed = await opts.repoFs.listDir(dir, { recursive: false });
    } catch {
      continue;
    }

    for (const item of listed) {
      if (item.type === "directory") {
        queue.push(item.path);
        continue;
      }
      const rel = toRepoRelative(item.path, repoRoot);
      if (!isIndexablePath(rel) || isIgnored(rel)) {
        continue;
      }
      let text: string;
      try {
        text = await opts.repoFs.readText(item.path);
      } catch {
        continue;
      }
      const sha256 = hashContent(text);
      entries.push({
        path: rel,
        sha256,
        size: text.length,
      });
      if (opts.maxFiles != null && entries.length >= opts.maxFiles) {
        return entries;
      }
    }
  }

  return entries;
};
