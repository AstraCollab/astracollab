import type { RepoSandboxFs } from "../../sandbox-fs/repo-fs-port.js";
import { normalizeUnderRepoRoot } from "../../sandbox-fs/path-utils.js";
import type { SandboxRuntime } from "../../types.js";
import picomatchImport from "picomatch";

export type NahToolEnvironmentOptions = {
  repoFs: RepoSandboxFs;
  sandbox: SandboxRuntime;
};

/** Structural subset accepted by `createCodingTools` from @astracollab/not-another-harness. */
export interface NahToolEnvironment {
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
  deleteFile(path: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  readdir(path: string): Promise<Array<{ name: string; type: "file" | "directory" }>>;
  grep(options: { pattern: string; path?: string; ignoreCase?: boolean; maxPerFile?: number }): Promise<string>;
  exec(command: string, options?: { timeoutSeconds?: number }): Promise<{ stdout: string; stderr: string; exitCode: number }>;
}

/** Adapt the shared repo filesystem and sandbox command runner to NAH's ToolEnvironment. */
export const createNahToolEnvironment = ({ repoFs, sandbox }: NahToolEnvironmentOptions): NahToolEnvironment => {
  if (typeof sandbox.executeCommand !== "function") {
    throw new Error("createNahToolEnvironment requires a sandbox with executeCommand().");
  }
  const resolve = (path: string) => normalizeUnderRepoRoot(repoFs.repoRoot, path);
  const relative = (absolutePath: string) => absolutePath === repoFs.repoRoot
    ? "."
    : absolutePath.slice(repoFs.repoRoot.length + 1);
  const picomatch = typeof picomatchImport === "function"
    ? picomatchImport
    : (picomatchImport as unknown as { default?: typeof picomatchImport }).default;

  return {
    readFile: (path) => repoFs.readText(resolve(path)),
    writeFile: (path, content) => repoFs.writeText(resolve(path), content, { recursive: true }),
    deleteFile: (path) => repoFs.deletePath(resolve(path), { recursive: false }),
    exists: (path) => repoFs.exists(resolve(path)),
    readdir: async (path) => (await repoFs.listDir(resolve(path))).map((entry) => ({ name: entry.name, type: entry.type })),
    grep: async ({ pattern, path, ignoreCase, maxPerFile }) => {
      const target = path?.trim() || ".";
      const glob = /[*?\[\]{}]/.test(target);
      const root = glob ? repoFs.repoRoot : resolve(target);
      const entries = glob
        ? await repoFs.listDir(root, { recursive: true })
        : await repoFs.listDir(root, { recursive: true }).catch(async () => {
          const absoluteFile = resolve(target);
          return (await repoFs.exists(absoluteFile))
            ? [{ name: absoluteFile.split("/").pop() ?? absoluteFile, path: absoluteFile, type: "file" as const }]
            : [];
        });
      const globMatcher = glob && picomatch ? picomatch(target.replace(/^\.\//, ""), { dot: true }) : undefined;
      const files = entries.filter((entry) => entry.type === "file" && (!globMatcher || globMatcher(relative(entry.path))));
      const matcher = new RegExp(pattern, ignoreCase ? "i" : "");
      const matches: string[] = [];
      for (const entry of files) {
        let content: string;
        try {
          content = await repoFs.readText(entry.path);
        } catch {
          continue;
        }
        let perFile = 0;
        content.split("\n").forEach((line, index) => {
          if (perFile >= (maxPerFile ?? Number.POSITIVE_INFINITY)) return;
          matcher.lastIndex = 0;
          if (matcher.test(line)) {
            matches.push(`${relative(entry.path)}:${index + 1}: ${line}`);
            perFile += 1;
          }
        });
      }
      return matches.join("\n");
    },
    exec: async (command, options) => {
      const result = await sandbox.executeCommand!("bash", ["-lc", command], {
        cwd: repoFs.repoRoot,
        timeout: options?.timeoutSeconds === undefined ? undefined : options.timeoutSeconds * 1000,
      });
      return {
        stdout: result.stdout ?? result.result ?? "",
        stderr: result.stderr ?? "",
        exitCode: result.exitCode ?? (result.success === false ? 1 : 0),
      };
    },
  };
};

export type { RepoSandboxFs } from "../../sandbox-fs/repo-fs-port.js";
