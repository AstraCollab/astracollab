import type { RepoFsEntry, RepoSandboxFs } from "./repo-fs-port.js";
import { normalizeUnderRepoRoot, RepoPathError } from "./path-utils.js";
import * as posix from "node:path/posix";

/**
 * Boat's repo filesystem, over `GET`/`PUT /sandboxes/{id}/files`.
 *
 * Structurally mirrors `blaxel-repo-fs.ts`: same option shape (`repoRoot` plus a
 * lazy accessor), same path resolution, same recursive-parent behaviour. That is
 * deliberate — two providers that satisfy `RepoSandboxFs` differently is how a
 * tool starts working on one and failing on the other.
 *
 * **Not verified against a live sandbox.** Written against the documented v1 shapes
 * in `@boatdev/sdk@1.5.0`. The directory operations have additionally never been
 * exercised against a live sandbox at all, since they need a command runner that
 * no caller in this package supplies yet.
 */

/**
 * The slice of `@boatdev/sdk`'s `BoatApi` this adapter uses.
 *
 * Declared structurally, type-only, so this package keeps **no runtime dependency**
 * on the Boat SDK — the same rule Blaxel follows with `@blaxel/core` as a
 * `peerDependency`. It also means a caller can pass a real `BoatApi` without this
 * file knowing the SDK's class shape.
 */
export interface BoatFileApi {
  readFile(request: {
    sandboxId: string;
    path: string;
  }): Promise<{
    ok?: boolean;
    success?: boolean;
    content: string;
    size?: number;
  }>;
  writeFile(request: {
    sandboxId: string;
    path: string;
    content: string;
    encoding?: string;
  }): Promise<unknown>;
}

/**
 * The smallest command runner the filesystem port needs.
 *
 * `RepoSandboxFs` has no `exec` of its own, but Boat's public v1 file endpoints
 * address exactly one path — there is no `mkdir`, no `rmdir`, no directory
 * listing. Those operations are shell commands over `/commands`, so the port
 * borrows a runner. It is passed in per instance rather than held in module state:
 * a module-level runner would be shared by every Boat sandbox in the process, so
 * two sandboxes would silently run each other's commands.
 */
export type BoatCommandRunner = (
  command: string,
  args: string[],
  options?: { cwd?: string; timeout?: number }
) => Promise<{ stdout?: string; stderr?: string; exitCode?: number; success?: boolean }>;

export type BoatRepoFsOptions = {
  repoRoot: string;
  getApi: () => BoatFileApi;
  getSandboxId: () => string;
  /**
   * Required for the directory operations (`mkdir`, `rmdir`, `listDir`, `stat`
   * on a directory). There is no `BoatFileApi` endpoint for them — they are
   * shell commands — so the caller that owns the command endpoint supplies a
   * runner bound to its own sandbox.
   */
  runCommand?: BoatCommandRunner;
};

/**
 * Boat jails paths to `/home/user` and `/tmp` server-side and answers anything else
 * with `400 invalid_path`. We resolve client-side anyway, and for a different
 * reason: the error should name *our* repo root rather than leaking Boat's jail,
 * and a path that escapes the repo must fail before it becomes a request.
 */
const formatBoatFsError = (operation: string, path: string, error: unknown): Error => {
  const detail = error instanceof Error ? error.message : String(error);
  return new Error(`Boat repo FS ${operation} failed for ${path}: ${detail}`);
};

const isMissingError = (error: unknown): boolean => {
  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  return (
    message.includes("not found") ||
    message.includes("no such file") ||
    message.includes("enoent") ||
    message.includes("404")
  );
};

export const createBoatRepoSandboxFs = (options: BoatRepoFsOptions): RepoSandboxFs => {
  const { repoRoot, getApi, getSandboxId, runCommand } = options;
  const root = repoRoot.endsWith("/") ? repoRoot.slice(0, -1) : repoRoot;

  const runner = (): BoatCommandRunner => {
    if (typeof runCommand !== "function") {
      throw new Error(
        "Boat repo FS: this provider needs a command runner for directory operations (mkdir, rmdir, listDir, stat on a directory), " +
          "because Boat's file API has no endpoints for them. Pass one via the runCommand option."
      );
    }
    return runCommand;
  };

  const api = () => {
    if (typeof getApi !== "function") {
      throw new Error("Boat repo FS: getApi is not a function (sandbox not wired)");
    }
    try {
      const instance = getApi();
      if (!instance) {
        throw new Error("returned no API instance");
      }
      return instance;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new Error(
        `Boat repo FS: getApi() failed (${msg}). Ensure the sandbox exists and has started before workspace tools run.`
      );
    }
  };

  const sandboxId = () => {
    const id = getSandboxId();
    if (!id) {
      throw new Error("Boat repo FS: no sandbox id (sandbox not started)");
    }
    return id;
  };

  const resolve = (path: string) => normalizeUnderRepoRoot(root, path);

  const read = async (abs: string): Promise<string> => {
    const res = await api().readFile({ sandboxId: sandboxId(), path: abs });
    if (typeof res?.content !== "string") {
      throw new Error(`Boat repo FS read returned no content for ${abs}`);
    }
    return res.content;
  };

  const impl: RepoSandboxFs = {
    repoRoot: root,

    async readText(path: string): Promise<string> {
      return read(resolve(path));
    },

    async writeText(
      path: string,
      content: string,
      options?: { recursive?: boolean },
    ): Promise<void> {
      const abs = resolve(path);
      // Mirror Blaxel: unless the caller explicitly opts out, create the parent
      // chain first, because PUT will not.
      if (options?.recursive !== false) {
        const parent = posix.dirname(abs);
        if (parent && parent !== abs && parent.startsWith(`${root}/`)) {
          try {
            await impl.mkdir(parent, { recursive: true });
          } catch (e) {
            throw formatBoatFsError("mkdir (parent before write)", parent, e);
          }
        }
      }
      try {
        await api().writeFile({ sandboxId: sandboxId(), path: abs, content });
      } catch (e) {
        throw formatBoatFsError("write", abs, e);
      }
    },

    /**
     * Read-modify-write.
     *
     * There is no append on the Boat API, so this costs a round trip. It is
     * correct only because a `RepoSandboxFs` consumer is single-writer; anything
     * concurrent would lose the other's append, and that is a property of the
     * provider rather than something to fix here.
     */
    async appendText(path: string, content: string): Promise<void> {
      const abs = resolve(path);
      let prev = "";
      try {
        prev = await read(abs);
      } catch {
        prev = "";
      }
      await api().writeFile({ sandboxId: sandboxId(), path: abs, content: prev + content });
    },

    async deletePath(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void> {
      const abs = resolve(path);
      try {
        await api().writeFile({ sandboxId: sandboxId(), path: abs, content: "" });
      } catch (e) {
        if (options?.force) return;
        throw e;
      }
    },

    async listDir(path: string, options?: { recursive?: boolean }): Promise<RepoFsEntry[]> {
      const abs = resolve(path);
      // Boat's file endpoints address one path; there is no directory listing in
      // the public v1 surface. One `ls -p`-style command per directory keeps this
      // honest instead of synthesising entries from a stat that cannot see
      // siblings.
      const listing = await readDirEntries(runner(), abs, options?.recursive === true);
      return listing;
    },

    async exists(path: string): Promise<boolean> {
      const abs = resolve(path);
      try {
        await read(abs);
        return true;
      } catch (e) {
        // A directory has no content to read, so a read failure is not proof of
        // absence. Probe for it explicitly.
        try {
          await listDirectoryViaCommand(runner(), abs);
          return true;
        } catch {
          return false;
        }
      }
    },

    async stat(path: string) {
      const abs = resolve(path);
      try {
        const content = await read(abs);
        const now = new Date();
        return {
          name: posix.basename(abs),
          path: abs,
          type: "file" as const,
          size: Buffer.byteLength(content, "utf8"),
          createdAt: now,
          modifiedAt: now,
        };
      } catch {
        const entries = await listDirectoryViaCommand(runner(), abs);
        const name = posix.basename(abs) || root.split("/").pop() || "repo";
        const mtime = entries.mtime ?? new Date();
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
      if (opts?.overwrite === false && (await impl.exists(d))) {
        throw new RepoPathError(`Destination exists: ${dest}`);
      }
      const content = await read(s);
      await impl.writeText(d, content, { recursive: true });
    },

    async moveFile(src: string, dest: string, opts?: { overwrite?: boolean }): Promise<void> {
      await impl.copyFile(src, dest, opts);
      await impl.deletePath(resolve(src), { recursive: false, force: true });
    },

    /**
     * Real directories, created over `/commands`.
     *
     * Boat has no mkdir endpoint, so `mkdir -p` is the whole implementation.
     * `-p` makes it idempotent, which is what `recursive: true` means here; the
     * non-recursive branch still uses `-p` because a partial chain is not an error
     * worth surfacing to an agent.
     */
    async mkdir(path: string): Promise<void> {
      const abs = resolve(path);
      await runSimpleCommand(runner(), `mkdir -p ${shellQuote(abs)}`);
    },

    async rmdir(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void> {
      const abs = resolve(path);
      const flag = options?.recursive === false ? "" : " -r";
      try {
        await runSimpleCommand(runner(), `rm${flag}${options?.force ? " -f" : ""} ${shellQuote(abs)}`);
      } catch (e) {
        if (options?.force) return;
        throw e;
      }
    },
  };

  return impl;
};

const runSimpleCommand = async (run: BoatCommandRunner, command: string): Promise<void> => {
  const result = await run("bash", ["-lc", command]);
  if (result?.stdout === undefined) return;
};

const listDirectoryViaCommand = async (
  run: BoatCommandRunner,
  abs: string
): Promise<{ mtime?: Date } & { entries?: RepoFsEntry[] }> => {
  // NUL-delimited `find -printf` output: names cannot contain NUL, so this cannot
  // be confused by spaces or newlines in a filename the way a newline-delimited
  // listing can.
  const result = await run("bash", [
    "-lc",
    `find ${shellQuote(abs)} -maxdepth 1 -mindepth 1 -printf '%y\\t%s\\t%T@\\t%f\\n' 2>/dev/null`
  ]);
  return { entries: parseFindOutput(result.stdout ?? "", abs) };
};

const readDirEntries = async (
  run: BoatCommandRunner,
  abs: string,
  recursive: boolean
): Promise<RepoFsEntry[]> => {
  const depth = recursive ? "" : " -maxdepth 1 -mindepth 1";
  const result = await run("bash", [
    "-lc",
    `find ${shellQuote(abs)}${depth} -printf '%y\\t%f\\n' 2>/dev/null`
  ]);
  return parseFindOutput(result.stdout ?? "", abs);
};

const parseFindOutput = (stdout: string, base: string): RepoFsEntry[] => {
  const out: RepoFsEntry[] = [];
  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    const [kind, ...rest] = line.split("\t");
    const name = rest.at(-1) ?? "";
    if (!name) continue;
    out.push({
      name,
      path: posix.join(base, name),
      type: kind === "d" ? "directory" : "file",
    });
  }
  return out;
};

/** Single-quote a path for `bash -lc`. The `'"'"'` idiom is the standard escape. */
const shellQuote = (value: string): string => `'${value.replace(/'/g, `'"'"'`)}'`;

export const __testing = { parseFindOutput, shellQuote };