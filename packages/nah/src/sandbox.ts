import { DEFAULT_CAPS, type ToolEnvironment } from "not-another-harness";
import { posix as posixPath } from "node:path";

/**
 * Remote ToolEnvironment backed by a Blaxel code sandbox.
 *
 * Loaded lazily via dynamic import of `@blaxel/core` — nah only needs these
 * deps when `--sandbox` is used, and `createBlaxelEnvironment` throws a clear
 * setup error otherwise. Structurally typed on purpose: no compile-time
 * Blaxel dependency in this package.
 *
 * Paths outside the sandbox repo root are rejected (resolveAgainstWorkspace).
 */

const BLAXEL_WORKSPACE = (
  process.env.BL_WORKSPACE ??
  process.env.BLAXEL_WORKSPACE ??
  ""
).trim();

type BlaxelSandboxInstance = {
  fs: {
    read(path: string): Promise<string>;
    write(path: string, content: string): Promise<void>;
    ls(path: string): Promise<{ files?: Array<{ path: string }>; subdirectories?: Array<{ path: string }> }>;
  };
  process: {
    exec(opts: {
      command: string;
      workingDir?: string;
      timeout?: number;
      waitForCompletion?: boolean;
    }): Promise<
      | { stdout?: string; stderr?: string; exitCode?: number; status?: string }
      | string
    >;
  };
};

export type BlaxelEnvironmentOptions = {
  /** Existing sandbox name (reuse), or omitted to create one. */
  sandboxName?: string;
  /** Override the sandbox base image (default: blaxel/ts-app:latest). */
  image?: string;
  /** Repo dir inside the sandbox. Default /workspace/repo. */
  repoDir?: string;
};

export type BlaxelEnvironment = {
  env: ToolEnvironment;
  sandboxName: string;
  /** Call when done — deletes the sandbox unless BLAZEL env asked to keep it. */
  destroy: () => Promise<void>;
};

export const createBlaxelEnvironment = async (
  opts: BlaxelEnvironmentOptions = {},
): Promise<BlaxelEnvironment> => {
  const apiKey = (process.env.BL_API_KEY ?? process.env.BLAXEL_API_KEY ?? "").trim();
  if (!apiKey) {
    throw new Error(
      "--sandbox needs a Blaxel API key: set BL_API_KEY (workspace is inferred from the key, or set BL_WORKSPACE).",
    );
  }
  if (BLAXEL_WORKSPACE) {
    process.env.BL_WORKSPACE = BLAXEL_WORKSPACE;
  }
  let bl: { SandboxInstance: { create: (cfg: unknown) => Promise<BlaxelSandboxInstance>; get: (name: string) => Promise<BlaxelSandboxInstance>; delete?: (name: string) => Promise<void> } };
  try {
    bl = (await import("@blaxel/core")) as unknown as typeof bl;
  } catch {
    throw new Error("--sandbox needs the optional dependency @blaxel/core installed.");
  }

  const name =
    opts.sandboxName ?? `nah-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
  const repoDir = posixPath.resolve(opts.repoDir ?? "/workspace/repo");
  const ownsSandbox = opts.sandboxName == null;
  const sandbox: BlaxelSandboxInstance = opts.sandboxName
    ? await bl.SandboxInstance.get(name)
    : await bl.SandboxInstance.create({
        name,
        image: opts.image ?? "blaxel/ts-app:latest",
        memory: 4096,
        region: (process.env.BL_REGION ?? "us-pdx-1").trim(),
      });

  const rawExec = async (command: string, workingDir?: string, timeoutSeconds?: number) => {
    const res = await sandbox.process.exec({
      command,
      ...(workingDir ? { workingDir } : {}),
      timeout: timeoutSeconds ?? 120,
      waitForCompletion: true,
    });
    if (typeof res === "string") {
      return { stdout: res, stderr: "", exitCode: 0 };
    }
    return {
      stdout: typeof res.stdout === "string" ? res.stdout : "",
      stderr: typeof res.stderr === "string" ? res.stderr : "",
      exitCode: typeof res.exitCode === "number" ? res.exitCode : 0,
    };
  };

  // Fresh sandboxes have no repo dir — create it so tools can cwd into it.
  await rawExec(`mkdir -p ${shellQuote(repoDir)}`, "/").catch(() => undefined);

  const exec = (command: string, timeoutSeconds?: number) =>
    rawExec(command, repoDir, timeoutSeconds);

  const resolveInRepo = (path: string): string => {
    const normalizedInput = path.replace(/\\/g, "/");
    if (normalizedInput.startsWith("/") || /^[A-Za-z]:/.test(normalizedInput)) {
      throw new Error(`absolute paths are not allowed in the sandbox repo: ${path}`);
    }
    const relative = posixPath.normalize(normalizedInput || ".");
    if (relative === ".." || relative.startsWith("../")) {
      throw new Error(`path escapes sandbox repo: ${path}`);
    }
    const resolved = posixPath.resolve(repoDir, relative);
    if (resolved !== repoDir && !resolved.startsWith(`${repoDir}/`)) {
      throw new Error(`path escapes sandbox repo: ${path}`);
    }
    return resolved;
  };

  const env: ToolEnvironment = {
    readFile: (path) => sandbox.fs.read(resolveInRepo(path)),
    writeFile: async (path, content) => {
      await sandbox.fs.write(resolveInRepo(path), content);
    },
    deleteFile: async (path: string) => {
      const sandboxFs = sandbox.fs as typeof sandbox.fs & { rm?: (path: string) => Promise<void> };
      if (!sandboxFs.rm) throw new Error("the configured sandbox SDK does not support file removal");
      await sandboxFs.rm(resolveInRepo(path));
    },
    exists: async (path) => {
      try {
        await sandbox.fs.read(resolveInRepo(path));
        return true;
      } catch {
        // fall through to a directory listing check
      }
      try {
        await sandbox.fs.ls(resolveInRepo(path));
        return true;
      } catch {
        return false;
      }
    },
    readdir: async (dir) => {
      const listing = await sandbox.fs.ls(resolveInRepo(dir));
      const files = (listing.files ?? []).map((f) => ({
        name: f.path.split("/").pop() ?? f.path,
        type: "file" as const,
      }));
      const dirs = (listing.subdirectories ?? []).map((d) => ({
        name: d.path.split("/").pop() ?? d.path,
        type: "directory" as const,
      }));
      return [...dirs, ...files];
    },
    grep: async ({ pattern, path, ignoreCase }) => {
      const args = ["-rnI", "-m", String(DEFAULT_CAPS.grep.maxPerFile)];
      if (ignoreCase) {
        args.push("-i");
      }
      args.push("-E", "--", pattern);
      const target = path?.trim() ? resolveInRepo(path.trim()) : ".";
      // Prefer git grep in repos (respects .gitignore), fall back to grep -r.
      const cmd = `git grep -nI ${ignoreCase ? "-i " : ""}-m ${DEFAULT_CAPS.grep.maxPerFile} -E -- ${shellQuote(pattern)} ${shellQuote(target)} 2>/dev/null || grep ${args.join(" ")} ${shellQuote(target)}`;
      const res = await exec(cmd, 60);
      return res.stdout ?? "";
    },
    exec: (command, o) => exec(command, o?.timeoutSeconds),
  };

  return {
    env,
    sandboxName: name,
    destroy: async () => {
      if (!ownsSandbox || process.env.NAH_KEEP_SANDBOX === "1") {
        return;
      }
      await bl.SandboxInstance.delete?.(name).catch(() => undefined);
    },
  };
};

const shellQuote = (s: string): string => `'${s.replace(/'/g, "'\\''")}'`;
