import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as nodePath from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { parseCliArgs } from "../src/args.js";
import { resolveModel } from "../src/model.js";
import { parsePermissionMode } from "../src/permissions.js";
import { withFileInclusions } from "../src/context.js";

describe("parseCliArgs", () => {
  it("defaults to interactive with no args (when TTY)", () => {
    const a = parseCliArgs([]);
    expect(["interactive", "print"]).toContain(a.mode); // non-TTY in CI → print
    expect(a.prompt).toBeUndefined();
  });

  it("parses print mode and model spec", () => {
    const a = parseCliArgs(["-p", "fix", "the", "bug", "-m", "openai:gpt-5.2"]);
    expect(a.mode).toBe("print");
    expect(a.prompt).toBe("fix the bug");
    expect(a.model).toBe("openai:gpt-5.2");
  });

  it("collects @file inclusions and honors --", () => {
    const a = parseCliArgs(["@src/a.ts", "@README.md", "--", "-literal"]);
    expect(a.files).toEqual(["src/a.ts", "README.md"]);
    expect(a.prompt).toBe("-literal");
  });

  it("parses session flags", () => {
    const a = parseCliArgs(["-c", "--no-session"]);
    expect(a.continueSession).toBe(true);
    expect(a.noSession).toBe(true);
  });

  it("parses permissions and sandbox flags", () => {
    const a = parseCliArgs(["-y", "--sandbox"]);
    expect(a.yolo).toBe(true);
    expect(a.sandbox).toBe(true);
    const b = parseCliArgs(["--permissions", "readonly", "--sandbox", "my-box"]);
    expect(b.permissions).toBe("readonly");
    expect(b.sandbox).toBe("my-box");
  });
});

describe("resolveModel", () => {
  it("rejects unknown providers", async () => {
    await expect(resolveModel("bogus:model", {})).rejects.toThrow(/Unknown provider/);
  });

  it("reports missing API keys without importing SDKs", async () => {
    await expect(resolveModel("anthropic:claude", {})).rejects.toThrow(/ANTHROPIC_API_KEY/);
    await expect(resolveModel("openai:gpt-x", {})).rejects.toThrow(/OPENAI_API_KEY/);
  });

  it("defaults to anthropic claude-sonnet-4-5", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-test";
    try {
      const m = await resolveModel(undefined, { ANTHROPIC_API_KEY: "sk-test" });
      expect(m.spec).toBe("anthropic:claude-sonnet-4-5");
    } finally {
      delete process.env.ANTHROPIC_API_KEY;
    }
  });
});

describe("parsePermissionMode", () => {
  it("accepts valid modes and rejects junk", () => {
    expect(parsePermissionMode("ask")).toBe("ask");
    expect(parsePermissionMode("YOLO")).toBe("yolo");
    expect(parsePermissionMode("readonly")).toBe("readonly");
    expect(parsePermissionMode("nope")).toBeNull();
    expect(parsePermissionMode(undefined)).toBeNull();
  });
});

describe("withFileInclusions", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(nodePath.join(tmpdir(), "nah-cli-"));
    await writeFile(nodePath.join(dir, "note.txt"), "file body\n");
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("inlines readable @files and marks unreadable ones", async () => {
    const out = await withFileInclusions(dir, ["note.txt", "missing.txt"], "do it");
    expect(out).toContain('<file path="note.txt">');
    expect(out).toContain("file body");
    expect(out).toContain("[could not read file]");
    expect(out.trim().endsWith("do it")).toBe(true);
  });

  it("passes prompt through with no files", async () => {
    expect(await withFileInclusions(dir, [], "plain")).toBe("plain");
  });
});
