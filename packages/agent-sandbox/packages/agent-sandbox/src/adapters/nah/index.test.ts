import { describe, expect, it, vi } from "vitest";

import type { RepoFsEntry, RepoSandboxFs } from "../../sandbox-fs/repo-fs-port.js";
import { RepoPathError } from "../../sandbox-fs/path-utils.js";
import { createNahToolEnvironment } from "./index.js";
import { shellQuote } from "./shell.js";

const ROOT = "/workspace/repo";

type Tree = Record<string, string>;

const makeRepoFs = (tree: Tree) => {
  const files = new Map<string, string>();
  for (const [rel, content] of Object.entries(tree)) {
    files.set(`${ROOT}/${rel}`, content);
  }

  const listDir = vi.fn(async (absPath: string, opts?: { recursive?: boolean }): Promise<RepoFsEntry[]> => {
    const prefix = absPath.endsWith("/") ? absPath : `${absPath}/`;
    const fileEntries: RepoFsEntry[] = [];
    const dirs = new Map<string, string>();
    for (const abs of files.keys()) {
      if (!abs.startsWith(prefix)) continue;
      const rest = abs.slice(prefix.length);
      if (!rest) continue;
      const segments = rest.split("/");
      if (segments.length === 1) {
        fileEntries.push({ name: segments[0]!, path: abs, type: "file" });
        continue;
      }
      // Directories are reported at every depth, but a non-recursive listing stops at
      // the immediate children — matching how the Blaxel `find`/`ls` port behaves. A
      // recursive listing also surfaces the file itself at depth, not just its parents.
      const maxDepth = opts?.recursive ? segments.length - 1 : 1;
      for (let depth = 1; depth <= maxDepth; depth += 1) {
        dirs.set(`${prefix}${segments.slice(0, depth).join("/")}`, segments[depth - 1]!);
      }
      if (opts?.recursive) {
        fileEntries.push({ name: segments[segments.length - 1]!, path: abs, type: "file" });
      }
    }
    return [
      ...[...dirs].map(([path, name]) => ({ name, path, type: "directory" as const })),
      ...fileEntries,
    ];
  });

  const repoFs: RepoSandboxFs = {
    repoRoot: ROOT,
    readText: vi.fn(async (abs: string) => {
      const content = files.get(abs);
      if (content === undefined) throw new Error(`ENOENT: ${abs}`);
      return content;
    }),
    writeText: vi.fn(async (abs: string, content: string) => {
      files.set(abs, content);
    }),
    appendText: vi.fn(async (abs: string, content: string) => {
      files.set(abs, `${files.get(abs) ?? ""}${content}`);
    }),
    deletePath: vi.fn(async (abs: string, opts?: { force?: boolean }) => {
      if (!files.has(abs) && opts?.force !== true) throw new Error(`ENOENT: ${abs}`);
      files.delete(abs);
    }),
    listDir,
    exists: vi.fn(async (abs: string) => files.has(abs)),
    stat: vi.fn(async (abs: string) => ({
      name: abs.split("/").pop() ?? abs,
      path: abs,
      type: "file" as const,
      size: files.get(abs)?.length ?? 0,
      createdAt: new Date(0),
      modifiedAt: new Date(0),
    })),
    copyFile: vi.fn(async () => undefined),
    moveFile: vi.fn(async () => undefined),
    mkdir: vi.fn(async () => undefined),
    rmdir: vi.fn(async () => undefined),
  };

  return { repoFs, files, listDir };
};

const makeSandbox = (
  result: Partial<{ stdout: string; stderr: string; exitCode: number; success: boolean }> = {},
) => {
  const executeCommand = vi.fn(async () => ({
    stdout: "",
    stderr: "",
    // Only default a success shape; callers can pass `success: false` with no exitCode
    // to exercise the provider-convention fallback.
    success: true,
    ...result,
  }));
  return { executeCommand, sandbox: { executeCommand } as never };
};

/** Pull the `bash -lc` script out of a recorded executeCommand call. */
const lastCommand = (executeCommand: ReturnType<typeof vi.fn>): string => {
  const call = executeCommand.mock.calls.at(-1);
  return String(call?.[1]?.[1] ?? "");
};

describe("createNahToolEnvironment: file surface", () => {
  it("reads and writes relative to the repo root", async () => {
    const { repoFs, files } = makeRepoFs({ "app/page.tsx": "hello" });
    const { sandbox } = makeSandbox();
    const env = createNahToolEnvironment({ repoFs, sandbox });

    await expect(env.readFile("app/page.tsx")).resolves.toBe("hello");
    await env.writeFile("app/new.ts", "created");
    expect(files.get(`${ROOT}/app/new.ts`)).toBe("created");
  });

  it("rejects paths that escape the repo root", async () => {
    const { repoFs } = makeRepoFs({});
    const { sandbox } = makeSandbox();
    const env = createNahToolEnvironment({ repoFs, sandbox });

    await expect(env.readFile("../../../etc/passwd")).rejects.toBeInstanceOf(RepoPathError);
  });

  it("deletes idempotently so a missing file is not a tool error", async () => {
    const { repoFs, files } = makeRepoFs({ "a.txt": "a" });
    const { sandbox } = makeSandbox();
    const env = createNahToolEnvironment({ repoFs, sandbox });

    await env.deleteFile("a.txt");
    await expect(env.deleteFile("a.txt")).resolves.toBeUndefined();
    expect(files.has(`${ROOT}/a.txt`)).toBe(false);
    expect(repoFs.deletePath).toHaveBeenCalledWith(`${ROOT}/a.txt`, {
      recursive: false,
      force: true,
    });
  });

  it("lists directories before files", async () => {
    const { repoFs } = makeRepoFs({ "z.txt": "", "a.txt": "", "src/index.ts": "" });
    const { sandbox } = makeSandbox();
    const env = createNahToolEnvironment({ repoFs, sandbox });

    await expect(env.readdir(".")).resolves.toEqual([
      { name: "src", type: "directory" },
      { name: "a.txt", type: "file" },
      { name: "z.txt", type: "file" },
    ]);
  });
});

describe("createNahToolEnvironment: grep", () => {
  it("delegates to git grep in the sandbox instead of reading files over RPC", async () => {
    const { repoFs, listDir } = makeRepoFs({ "src/index.ts": "const secret = 1;" });
    const { executeCommand, sandbox } = makeSandbox({
      stdout: "src/index.ts:1:const secret = 1;",
    });
    const env = createNahToolEnvironment({ repoFs, sandbox });

    const out = await env.grep({ pattern: "secret" });

    expect(out).toBe("src/index.ts:1:const secret = 1;");
    // The whole point: no file contents fetched host-side.
    expect(repoFs.readText).not.toHaveBeenCalled();
    expect(listDir).not.toHaveBeenCalled();
    const command = lastCommand(executeCommand);
    expect(command).toContain("git grep");
    // A file the agent just wrote must be findable by its own next search.
    expect(command).toContain("--untracked");
    expect(executeCommand.mock.calls[0]?.[2]).toMatchObject({ cwd: ROOT });
  });

  it("shell-quotes a pattern containing shell metacharacters", () => {
    // A model-authored pattern reaches a shell, so quoting is the only thing standing
    // between `grep` and an injection. Assert the exact standard-POSIX escape form.
    expect(shellQuote("plain")).toBe("'plain'");
    expect(shellQuote("it's")).toBe("'it'\\''s'");
    expect(shellQuote("a'; rm -rf /; echo '")).toBe("'a'\\''; rm -rf /; echo '\\'''");
  });

  it("never leaves a model-authored pattern unquoted in the grep command", async () => {
    const { repoFs } = makeRepoFs({});
    const { executeCommand, sandbox } = makeSandbox();
    const env = createNahToolEnvironment({ repoFs, sandbox });

    await env.grep({ pattern: "$(whoami)`id`" });
    const command = lastCommand(executeCommand);
    // Every occurrence of the pattern sits inside single quotes.
    expect(command).toContain(shellQuote("$(whoami)`id`"));
    expect(command).not.toMatch(/(^|[\s;|])(\$\(|`)/);
  });

  it("honours maxPerFile, ignoreCase and the target path", async () => {
    const { repoFs } = makeRepoFs({});
    const { executeCommand, sandbox } = makeSandbox();
    const env = createNahToolEnvironment({ repoFs, sandbox });

    await env.grep({ pattern: "Foo", path: "src", ignoreCase: true, maxPerFile: 7 });
    const command = lastCommand(executeCommand);
    expect(command).toContain("-m 7");
    expect(command).toContain("-i");
    expect(command).toContain("'src'");
  });

  it("excludes dotfile hits unless includeHidden is set", async () => {
    const { repoFs } = makeRepoFs({});
    const stdout = [
      "src/index.ts:1:const a = 1;",
      ".eslintrc.json:1:{",
      "src/.cache/x.ts:1:const a = 1;",
    ].join("\n");
    const { sandbox } = makeSandbox({ stdout });
    const env = createNahToolEnvironment({ repoFs, sandbox });

    await expect(env.grep({ pattern: "a" })).resolves.toBe("src/index.ts:1:const a = 1;");
    await expect(env.grep({ pattern: "a", includeHidden: true })).resolves.toBe(stdout);
  });

  it("drops lines that are not in path:line: form", async () => {
    const { repoFs } = makeRepoFs({});
    const { sandbox } = makeSandbox({ stdout: "12: bare line\n" });
    const env = createNahToolEnvironment({ repoFs, sandbox });

    await expect(env.grep({ pattern: "a" })).resolves.toBe("");
  });
});

describe("createNahToolEnvironment: glob", () => {
  it("is present, which is what makes NAH register the glob tool", () => {
    const { repoFs } = makeRepoFs({});
    const { sandbox } = makeSandbox();
    const env = createNahToolEnvironment({ repoFs, sandbox });
    expect(typeof env.glob).toBe("function");
  });

  it("returns repo-relative matches, shallowest first", async () => {
    const { repoFs } = makeRepoFs({
      "src/a.ts": "",
      "src/nested/b.ts": "",
      "src/nested/c.ts": "",
      "docs/readme.md": "",
    });
    const { sandbox } = makeSandbox();
    const env = createNahToolEnvironment({ repoFs, sandbox });

    await expect(env.glob({ pattern: "src/**/*.ts" })).resolves.toEqual([
      "src/a.ts",
      "src/nested/b.ts",
      "src/nested/c.ts",
    ]);
  });

  it("honours limit and includeHidden", async () => {
    const { repoFs } = makeRepoFs({ "src/a.ts": "", "src/b.ts": "", "src/.hidden.ts": "" });
    const { sandbox } = makeSandbox();
    const env = createNahToolEnvironment({ repoFs, sandbox });

    await expect(env.glob({ pattern: "src/*.ts" })).resolves.toEqual(["src/a.ts", "src/b.ts"]);
    await expect(env.glob({ pattern: "src/*.ts", limit: 1 })).resolves.toEqual(["src/a.ts"]);
    await expect(env.glob({ pattern: "src/*.ts", includeHidden: true })).resolves.toEqual([
      "src/.hidden.ts",
      "src/a.ts",
      "src/b.ts",
    ]);
  });

  it("narrows the walk to the pattern's static prefix", async () => {
    const { repoFs, listDir } = makeRepoFs({ "src/a.ts": "", "other/b.ts": "" });
    const { sandbox } = makeSandbox();
    const env = createNahToolEnvironment({ repoFs, sandbox });

    await env.glob({ pattern: "src/**/*.ts" });
    expect(listDir).toHaveBeenCalledWith(`${ROOT}/src`, { recursive: true });
  });

  it("walks a single level when the pattern cannot nest", async () => {
    const { repoFs, listDir } = makeRepoFs({ "src/a.ts": "", "src/deep/b.ts": "" });
    const { sandbox } = makeSandbox();
    const env = createNahToolEnvironment({ repoFs, sandbox });

    await expect(env.glob({ pattern: "src/*.ts" })).resolves.toEqual(["src/a.ts"]);
    expect(listDir).toHaveBeenCalledWith(`${ROOT}/src`, { recursive: false });
  });
});

describe("createNahToolEnvironment: exec", () => {
  it("applies a default timeout and runs from the repo root", async () => {
    const { repoFs } = makeRepoFs({});
    const { executeCommand, sandbox } = makeSandbox({ stdout: "ok" });
    const env = createNahToolEnvironment({ repoFs, sandbox });

    await expect(env.exec("ls")).resolves.toEqual({ stdout: "ok", stderr: "", exitCode: 0 });
    expect(executeCommand.mock.calls[0]?.[2]).toMatchObject({
      cwd: ROOT,
      timeout: 120_000,
    });
  });

  it("honours an explicit timeout and a configured default", async () => {
    const { repoFs } = makeRepoFs({});
    const { executeCommand, sandbox } = makeSandbox();
    const env = createNahToolEnvironment({
      repoFs,
      sandbox,
      defaultExecTimeoutSeconds: 30,
    });

    await env.exec("ls");
    expect(executeCommand.mock.calls[0]?.[2]).toMatchObject({ timeout: 30_000 });
    await env.exec("ls", { timeoutSeconds: 5 });
    expect(executeCommand.mock.calls[1]?.[2]).toMatchObject({ timeout: 5_000 });
  });

  it("passes the abort signal down to the provider", async () => {
    const { repoFs } = makeRepoFs({});
    const { executeCommand, sandbox } = makeSandbox();
    const env = createNahToolEnvironment({ repoFs, sandbox });
    const controller = new AbortController();

    await env.exec("sleep 60", { signal: controller.signal });

    expect(executeCommand.mock.calls[0]?.[2]).toMatchObject({
      signal: controller.signal,
    });
  });

  it("returns promptly on abort instead of waiting for the sandbox", async () => {
    const { repoFs } = makeRepoFs({});
    const controller = new AbortController();
    // Provider that ignores cancellation, like a plain Blaxel exec.
    const executeCommand = vi.fn(
      () => new Promise<{ stdout: string; stderr: string; exitCode: number; success: boolean }>(() => {}),
    );
    const env = createNahToolEnvironment({
      repoFs,
      sandbox: { executeCommand } as never,
    });

    const pending = env.exec("sleep 600", { signal: controller.signal });
    controller.abort();

    await expect(pending).resolves.toEqual({
      stdout: "",
      stderr: "command aborted",
      exitCode: 130,
    });
  });

  it("short-circuits when the signal is already aborted", async () => {
    const { repoFs } = makeRepoFs({});
    const { executeCommand, sandbox } = makeSandbox();
    const env = createNahToolEnvironment({ repoFs, sandbox });

    const result = await env.exec("ls", { signal: AbortSignal.abort() });

    expect(result).toEqual({ stdout: "", stderr: "aborted before start", exitCode: 130 });
    expect(executeCommand).not.toHaveBeenCalled();
  });

  it("maps a failed result to a non-zero exit code", async () => {
    const { repoFs } = makeRepoFs({});
    const { sandbox } = makeSandbox({ stdout: "", stderr: "boom", success: false });
    const env = createNahToolEnvironment({ repoFs, sandbox });

    await expect(env.exec("false")).resolves.toEqual({
      stdout: "",
      stderr: "boom",
      exitCode: 1,
    });
  });
});

describe("createNahToolEnvironment: construction", () => {
  it("fails loudly without a command runner", () => {
    const { repoFs } = makeRepoFs({});
    expect(() => createNahToolEnvironment({ repoFs, sandbox: {} as never })).toThrow(
      /executeCommand/,
    );
  });
});
