import { mkdtemp, rm, writeFile as fsWriteFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as nodePath from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createNodeEnvironment } from "../src/node.js";
import { createCodingTools } from "../src/tools.js";

type ToolMap = Record<
  string,
  { execute: (input: never, ctx: unknown) => Promise<string> }
>;

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

  beforeEach(async () => {
    dir = await mkdtemp(nodePath.join(tmpdir(), "nah-tools-"));
    await fsWriteFile(nodePath.join(dir, "hello.ts"), "export const greeting = 'hi';\n".repeat(3));
    await fsWriteFile(nodePath.join(dir, "notes.md"), "# notes\nneedle line\n");
    tools = createCodingTools(createNodeEnvironment(dir)) as ToolMap;
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("read returns numbered lines", async () => {
    const out = await run("read", { path: "notes.md" });
    expect(out).toContain("1|# notes");
    expect(out).toContain("2|needle line");
  });

  it("write requires no prior read for new files, then read for overwrite", async () => {
    expect(await run("write", { path: "new.ts", content: "export {};\n" })).toContain("Wrote");
    const again = await run("write", { path: "hello.ts", content: "x" });
    expect(again).toContain("read");
  });

  it("edit enforces read-before-edit and exact unique match", async () => {
    const blocked = await run("edit", {
      path: "hello.ts",
      old_string: "hi",
      new_string: "yo",
    });
    expect(blocked).toContain("read");

    await run("read", { path: "hello.ts" });
    const multi = await run("edit", { path: "hello.ts", old_string: "hi", new_string: "yo" });
    expect(multi).toContain("appears 3 times");

    const ok = await run("edit", {
      path: "hello.ts",
      old_string: "hi",
      new_string: "yo",
      replace_all: true,
    });
    expect(ok).toContain("Replaced 3");
    const after = await run("read", { path: "hello.ts" });
    expect(after).toContain("'yo'");
  });

  it("grep finds matches as path:line and reports misses", async () => {
    const out = await run("grep", { pattern: "needle" });
    expect(out).toContain("notes.md:2: needle line");
    expect(await run("grep", { pattern: "definitely-not-here" })).toContain("No matches");
  });

  it("list renders a capped tree, hiding dotfiles", async () => {
    await fsWriteFile(nodePath.join(dir, ".hidden"), "x");
    const out = await run("list", { path: "." });
    expect(out).toContain("hello.ts");
    expect(out).toContain("notes.md");
    expect(out).not.toContain(".hidden");
  });

  it("bash runs commands and reports exit codes", async () => {
    const out = await run("bash", { command: "echo nah-works" });
    expect(out).toContain("nah-works");
    expect(out).toContain("exit 0");
    const fail = await run("bash", { command: "exit 3" });
    expect(fail).toContain("exit 3");
  });

  it("grep paths cannot escape the workspace root", async () => {
    const out = await run("grep", { pattern: "x", path: "../../" });
    expect(out === "" || out.startsWith("Error")).toBe(true);
  });

  it("approval gate denies mutating tools and allows reads", async () => {
    const denied: string[] = [];
    const gated = createCodingTools(createNodeEnvironment(dir), {
      approveToolCall: async (name) => {
        denied.push(name);
        return false;
      },
    }) as ToolMap;
    const call = (n: string, input: unknown) => gated[n]!.execute(input as never, {});
    expect(await call("write", { path: "x.ts", content: "1" })).toContain("DENIED");
    expect(await call("edit", { path: "note.txt", old_string: "x", new_string: "y" })).toContain("DENIED");
    expect(await call("bash", { command: "echo hi" })).toContain("DENIED");
    // reads are never gated
    expect(await call("read", { path: "notes.md" })).toContain("1|# notes");
    expect(denied.sort()).toEqual(["bash", "edit", "write"]);
  });

  it("approval gate allows when approved", async () => {
    const open = createCodingTools(createNodeEnvironment(dir), {
      approveToolCall: async () => true,
    }) as ToolMap;
    const out = await open.write!.execute(
      { path: "allowed.ts", content: "export {};\n" } as never,
      {},
    );
    expect(out).toContain("Wrote");
  });
});
