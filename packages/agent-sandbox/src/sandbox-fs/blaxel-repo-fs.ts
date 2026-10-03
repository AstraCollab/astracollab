import type { SandboxFileSystem, SandboxInstance } from "@blaxel/core";
import type { RepoFsEntry, RepoSandboxFs } from "./repo-fs-port.js";
import { normalizeUnderRepoRoot, RepoPathError } from "./path-utils.js";
import * as posix from "node:path/posix";

export type BlaxelRepoFsOptions = {
  repoRoot: string;
  getInstance: () => SandboxInstance;
};

const parseIso = (s: string | undefined): Date => {
  if (!s) {
    return new Date(0);
  }
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? new Date(0) : d;
};

const isMkdirAlreadyExistsError = (error: unknown): boolean => {
  if (!(error instanceof Error)) {
    return false;
  }
  const msg = error.message.toLowerCase();
  return (
    msg.includes("already exist") ||
    msg.includes("eexist") ||
    msg.includes("file exists")
  );
};

const formatBlaxelFsError = (operation: string, path: string, error: unknown): Error => {
  const detail = error instanceof Error ? error.message : String(error);
  return new Error(`Blaxel repo FS ${operation} failed for ${path}: ${detail}`);
};

const requireBlaxelSandboxFs = (getInstance: () => SandboxInstance): SandboxFileSystem => {
  if (typeof getInstance !== "function") {
    throw new Error("Blaxel repo FS: getInstance is not a function (sandbox not wired)");
  }
  let inst: SandboxInstance;
  try {
    inst = getInstance();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`Blaxel repo FS: getInstance() failed (${msg}). Ensure the sandbox has started before workspace tools run.`);
  }
  const fsLayer = inst?.fs;
  const need = ["read", "write", "ls", "rm", "find", "cp", "mkdir"] as const;
  const layer = fsLayer as unknown as Record<string, unknown>;
  const missing = need.filter((k) => typeof layer?.[k] !== "function");
  if (!fsLayer || missing.length > 0) {
    const keys = fsLayer && typeof fsLayer === "object" ? Object.keys(fsLayer as object).slice(0, 40).join(", ") : "(none)";
    throw new Error(
      `Blaxel repo FS: sandbox fs API is incomplete (missing: ${missing.join(", ") || "fs"}). ` +
        `Present keys: ${keys}. ` +
        `Ensure @blaxel/core matches @mastra/blaxel and the sandbox uses the Node SDK (not browser).`,
    );
  }
  return fsLayer;
};

export const createBlaxelRepoSandboxFs = (options: BlaxelRepoFsOptions): RepoSandboxFs => {
  const { repoRoot, getInstance } = options;
  const root = repoRoot.endsWith("/") ? repoRoot.slice(0, -1) : repoRoot;

  const bfs = () => requireBlaxelSandboxFs(getInstance);

  const resolve = (path: string) => normalizeUnderRepoRoot(root, path);

  const impl: RepoSandboxFs = {
    repoRoot: root,

    async readText(path: string): Promise<string> {
      const abs = resolve(path);
      return bfs().read(abs);
    },

    async writeText(
      path: string,
      content: string,
      options?: { recursive?: boolean },
    ): Promise<void> {
      const abs = resolve(path);
      if (options?.recursive !== false) {
        const parent = posix.dirname(abs);
        if (parent && parent !== abs && parent.startsWith(`${root}/`)) {
          try {
            await impl.mkdir(parent, { recursive: true });
          } catch (e) {
            throw formatBlaxelFsError("mkdir (parent before write)", parent, e);
          }
        }
      }
      try {
        await bfs().write(abs, content);
      } catch (e) {
        throw formatBlaxelFsError("write", abs, e);
      }
    },

    async appendText(path: string, content: string): Promise<void> {
      const abs = resolve(path);
      let prev = "";
      try {
        prev = await bfs().read(abs);
      } catch {
        prev = "";
      }
      await bfs().write(abs, prev + content);
    },

    async deletePath(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void> {
      const abs = resolve(path);
      try {
        await bfs().rm(abs, options?.recursive ?? true);
      } catch (e) {
        if (options?.force) {
          return;
        }
        throw e;
      }
    },

    async listDir(path: string, options?: { recursive?: boolean }): Promise<RepoFsEntry[]> {
      const abs = resolve(path);
      if (options?.recursive) {
        const res = await bfs().find(abs, {
          maxResults: 5000,
          excludeHidden: false,
        });
        const matches = res.matches ?? [];
        return matches.map((m) => ({
          name: posix.basename(m.path),
          path: m.path,
          type: m.type === "directory" ? "directory" : "file",
        }));
      }
      const dir = await bfs().ls(abs);
      const out: RepoFsEntry[] = [];
      for (const f of dir.files ?? []) {
        out.push({
          name: f.name,
          path: f.path,
          type: "file",
          size: f.size,
        });
      }
      for (const s of dir.subdirectories ?? []) {
        out.push({
          name: s.name,
          path: s.path,
          type: "directory",
        });
      }
      return out;
    },

    async exists(path: string): Promise<boolean> {
      const abs = resolve(path);
      try {
        await bfs().read(abs);
        return true;
      } catch {
        try {
          await bfs().ls(abs);
          return true;
        } catch {
          return false;
        }
      }
    },

    async stat(path: string) {
      const abs = resolve(path);
      try {
        const content = await bfs().read(abs);
        const name = posix.basename(abs);
        const now = new Date();
        return {
          name,
          path: abs,
          type: "file" as const,
          size: Buffer.byteLength(content, "utf8"),
          createdAt: now,
          modifiedAt: now,
        };
      } catch {
        const dir = await bfs().ls(abs);
        const name = posix.basename(abs) || root.split("/").pop() || "repo";
        const mtime = dir.files?.[0]?.lastModified
          ? parseIso(dir.files[0].lastModified)
          : new Date();
        return {
          name,
          path: abs,
          type: "directory" as const,
          size: 0,
          createdAt: mtime,
          modifiedAt: mtime,
        };
      }
    },

    async copyFile(src: string, dest: string, opts?: { overwrite?: boolean }): Promise<void> {
      const s = resolve(src);
      const d = resolve(dest);
      if (opts?.overwrite === false) {
        const existsDest = await impl.exists(d);
        if (existsDest) {
          throw new RepoPathError(`Destination exists: ${dest}`);
        }
      }
      await bfs().cp(s, d);
    },

    async moveFile(src: string, dest: string, opts?: { overwrite?: boolean }): Promise<void> {
      await impl.copyFile(src, dest, opts);
      await impl.deletePath(resolve(src), { recursive: false, force: false });
    },

    async mkdir(path: string, options?: { recursive?: boolean }): Promise<void> {
      const abs = resolve(path);
      if (!options?.recursive) {
        await bfs().mkdir(abs, "0755");
        return;
      }
      const rel = abs.startsWith(`${root}/`) ? abs.slice(root.length + 1) : posix.basename(abs);
      const parts = rel.split("/").filter(Boolean);
      let acc = root;
      for (const part of parts) {
        acc = posix.join(acc, part);
        try {
          await bfs().mkdir(acc, "0755");
        } catch (e) {
          if (!isMkdirAlreadyExistsError(e)) {
            throw formatBlaxelFsError("mkdir", acc, e);
          }
        }
      }
    },

    async rmdir(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void> {
      await impl.deletePath(path, { recursive: options?.recursive ?? true, force: options?.force });
    },
  };

  return impl;
};
