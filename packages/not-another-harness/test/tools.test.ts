import { mkdir, mkdtemp, rm, writeFile as fsWriteFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as nodePath from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createNodeEnvironment } from "../src/node.js";
import { createCodingTools, type CodingToolsOptions } from "../src/tools.js";

type ToolMap = Record<string, { execute: (input: never, ctx: unknown) => Promise<string> }>;

const build = (dir: string, options?: CodingToolsOptions): ToolMap =>
  createCodingTools(createNodeEnvironment(dir), options) as ToolMap;

describe("coding tools (node environment)", () => {
  let dir: string;
  let tools: ToolMap;

  const run = (name: string, input: unknown): Promise<string> => {
    const t = tools[name];
    if (!t) {
      throw new Error(`missing tool ${name}`);
    }
    return t.execute(input as never, {});
  };

  /** Matched paths from a glob result, as an exact set rather than a substring. */
  const globPaths = async (input: Record<string, unknown>): Promise<string[]> => {
    const lines = (await run("glob", input)).split("\n");
    return lines[0]?.startsWith("No files match") ? [] : lines.slice(1);
  };

  beforeEach(async () => {
    dir = await mkdtemp(nodePath.join(tmpdir(), "nah-tools-"));
    await mkdir(nodePath.join(dir, "src", "deep"), { recursive: true });
    await fsWriteFile(nodePath.join(dir, "hello.ts"), "export const greeting = 'hi';\n".repeat(3));
    await fsWriteFile(nodePath.join(dir, "notes.md"), "# notes\nneedle line\n");
    await fsWriteFile(nodePath.join(dir, "src", "a.ts"), "a");
    await fsWriteFile(nodePath.join(dir, "src", "b.tsx"), "b");
    await fsWriteFile(nodePath.join(dir, "src", "deep", "c.ts"), "c");
    tools = build(dir);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  describe("read", () => {
    it("returns numbered lines", async () => {
      const out = await run("read", { path: "notes.md" });
      expect(out).toContain("1|# notes");
      expect(out).toContain("2|needle line");
    });

    it("pages with offset/limit and tells the model how to fetch the rest", async () => {
      await run("write", { path: "long.txt", content: "l1\nl2\nl3\nl4\nl5\n" });
      const out = await run("read", { path: "long.txt", offset: 3, limit: 2 });
      expect(out).toContain("3|l3");
      expect(out).toContain("4|l4");
      expect(out).not.toContain("5|l5");
      expect(out).toContain("[file has 5 lines total");
    });

    it("does not offer paging when the whole file was returned", async () => {
      expect(await run("read", { path: "notes.md" })).not.toContain("page with offset/limit");
    });

    it("reports a missing file as a tool error rather than throwing", async () => {
      expect(await run("read", { path: "nope.ts" })).toMatch(/^Error: ENOENT/);
    });
  });

  describe("write", () => {
    it("writes new files without a prior read, then requires one to overwrite", async () => {
      expect(await run("write", { path: "new.ts", content: "export {};\n" })).toContain("Wrote");
      expect(await run("write", { path: "hello.ts", content: "x" })).toContain("read");
    });

    it("accepts an equivalent path spelling as satisfying read-before-write", async () => {
      await run("read", { path: "./notes.md" });
      expect(await run("write", { path: "notes.md", content: "# rewritten\n" })).toContain("Wrote");
    });
  });

  describe("edit", () => {
    it("requires a prior read", async () => {
      expect(await run("edit", { path: "hello.ts", old_string: "hi", new_string: "yo" })).toContain("read");
    });

    it("refuses an ambiguous match unless replace_all is set", async () => {
      await run("read", { path: "hello.ts" });
      expect(await run("edit", { path: "hello.ts", old_string: "hi", new_string: "yo" })).toContain(
        "appears 3 times",
      );
    });

    it("blocks replace_all for a short string only when it is actually ambiguous", async () => {
      await run("read", { path: "hello.ts" });
      // Three matches of a two-character string: blocked, this is the damage case.
      expect(
        await run("edit", { path: "hello.ts", old_string: "hi", new_string: "yo", replace_all: true }),
      ).toContain("replace_all is blocked");

      // One match of the same short string: unambiguous, so replace_all is allowed.
      await run("write", { path: "once.ts", content: "xy\n" });
      await run("read", { path: "once.ts" });
      expect(
        await run("edit", { path: "once.ts", old_string: "xy", new_string: "zz", replace_all: true }),
      ).toBe("Replaced 1 occurrence in once.ts");
    });

    it("applies replace_all for an unambiguous longer phrase", async () => {
      await run("read", { path: "hello.ts" });
      expect(
        await run("edit", { path: "hello.ts", old_string: "'hi'", new_string: "'yo'", replace_all: true }),
      ).toBe("Replaced 3 occurrences in hello.ts");
      expect(await run("read", { path: "hello.ts" })).toContain("'yo'");
    });

    it("reports an absent old_string instead of failing silently", async () => {
      await run("read", { path: "notes.md" });
      expect(await run("edit", { path: "notes.md", old_string: "absent", new_string: "x" })).toContain(
        "old_string not found",
      );
    });
  });

  describe("glob", () => {
    it("matches patterns and returns the exact set", async () => {
      expect(await globPaths({ pattern: "**/*.ts" })).toEqual(["hello.ts", "src/a.ts", "src/deep/c.ts"]);
      expect(await globPaths({ pattern: "src/*.tsx" })).toEqual(["src/b.tsx"]);
      expect(await globPaths({ pattern: "**/*.{ts,tsx}" })).toEqual([
        "hello.ts",
        "src/a.ts",
        "src/b.tsx",
        "src/deep/c.ts",
      ]);
      expect(await globPaths({ pattern: "**/*.rs" })).toEqual([]);
    });

    it("does not let a single-segment pattern leak into nested directories", async () => {
      expect(await globPaths({ pattern: "src/*.ts" })).toEqual(["src/a.ts"]);
    });

    it("scopes to path and honours limit", async () => {
      expect(await globPaths({ pattern: "*.ts", path: "src" })).toEqual(["src/a.ts"]);
      expect((await globPaths({ pattern: "**/*.ts", limit: 2 })).length).toBe(2);
    });

    it("hides dotfiles unless includeHidden is set", async () => {
      await fsWriteFile(nodePath.join(dir, ".env"), "SECRET=1");
      expect(await globPaths({ pattern: "**/.env" })).toEqual([]);
      expect(await globPaths({ pattern: "**/.env", includeHidden: true })).toEqual([".env"]);
    });

    it("can be turned off with withGlob", () => {
      expect(Object.keys(build(dir))).toContain("glob");
      expect(Object.keys(build(dir, { withGlob: false }))).not.toContain("glob");
    });
  });

  describe("grep", () => {
    it("finds matches as path:line and reports misses", async () => {
      expect(await run("grep", { pattern: "needle" })).toContain("notes.md:2: needle line");
      expect(await run("grep", { pattern: "definitely-not-here" })).toContain("No matches");
    });

    it("accepts a glob in path", async () => {
      const out = await run("grep", { pattern: "needle", path: "*.md" });
      expect(out).toContain("notes.md:2");
      expect(out).not.toContain(".env");
    });

    it("opts into dotfiles with includeHidden", async () => {
      await fsWriteFile(nodePath.join(dir, ".env"), "SECRET=needle\n");
      expect(await run("grep", { pattern: "needle" })).not.toContain(".env");
      expect(await run("grep", { pattern: "needle", includeHidden: true })).toContain(".env:1");
    });
  });

  describe("workspace containment", () => {
    it("refuses to read or search outside the root", async () => {
      expect(await run("read", { path: "../outside.txt" })).toContain("escapes workspace root");
      expect(await run("grep", { pattern: "x", path: "../../" })).toContain("escapes workspace root");
    });

    it("refuses to write outside the root", async () => {
      await expect(run("write", { path: "../evil.ts", content: "pwned" })).rejects.toThrow(
        /escapes workspace root/,
      );
    });
  });

  describe("list", () => {
    it("renders a tree and hides dotfiles", async () => {
      await fsWriteFile(nodePath.join(dir, ".hidden"), "x");
      const out = await run("list", { path: "." });
      expect(out).toContain("hello.ts");
      expect(out).toContain("src/");
      expect(out).not.toContain(".hidden");
    });
  });

  describe("bash", () => {
    it("runs commands and reports exit codes", async () => {
      expect(await run("bash", { command: "echo nah-works" })).toContain("nah-works");
      expect(await run("bash", { command: "echo nah-works" })).toContain("exit 0");
      expect(await run("bash", { command: "exit 3" })).toContain("exit 3");
    });

    it("can be turned off with withBash", () => {
      expect(Object.keys(build(dir, { withBash: false }))).not.toContain("bash");
    });
  });

  describe("approval gate", () => {
    it("denies mutating tools and allows reads", async () => {
      const denied: string[] = [];
      const gated = build(dir, {
        approveToolCall: async (name) => {
          denied.push(name);
          return false;
        },
      });
      const call = (n: string, input: unknown) => gated[n]!.execute(input as never, {});

      expect(await call("write", { path: "x.ts", content: "1" })).toContain("DENIED");
      expect(await call("edit", { path: "note.txt", old_string: "x", new_string: "y" })).toContain("DENIED");
      expect(await call("bash", { command: "echo hi" })).toContain("DENIED");
      // Read-only tools are never gated, and must not even reach the callback.
      expect(await call("read", { path: "notes.md" })).toContain("1|# notes");
      expect(await call("glob", { pattern: "*.md" })).toContain("notes.md");
      expect(denied.sort()).toEqual(["bash", "edit", "write"]);
    });

    it("denial does not create the file", async () => {
      const gated = build(dir, { approveToolCall: async () => false });
      await gated.write!.execute({ path: "nope.ts", content: "1" } as never, {});
      expect(await run("grep", { pattern: "nope" })).toContain("No matches");
    });

    it("allows the change when approved", async () => {
      const open = build(dir, { approveToolCall: async () => true });
      expect(await open.write!.execute({ path: "allowed.ts", content: "export {};\n" } as never, {})).toContain(
        "Wrote",
      );
    });
  });
});
