import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as nodePath from "node:path";
import { Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { parseCliArgs } from "../src/args.js";
import { resolveModel } from "../src/model.js";
import { parsePermissionMode } from "../src/permissions.js";
import { withFileInclusions } from "../src/context.js";
import { handleSlashCommand } from "../src/repl.js";
import type { SessionState } from "../src/session.js";

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
    dir = await mkdtemp(nodePath.join(tmpdir(), "nah-"));
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

describe("undo command", () => {
  const createState = (current: string) => {
    let file = current;
    let persisted: unknown[] = [];
    const state = {
      messages: [{ role: "user", content: "new prompt" }],
      system: "",
      cwd: ".",
      tools: {},
      workspace: {
        readFile: async () => file,
        writeFile: async (_path: string, content: string) => { file = content; },
        deleteFile: async () => { file = ""; },
        exists: async () => true,
        readdir: async () => [],
        grep: async () => "",
        exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
      },
      activeFileChanges: null,
      undoHistory: [{
        changes: [
          { path: "file.ts", existed: true, content: "before", after: "middle" },
          { path: "file.ts", existed: true, content: "middle", after: "after" },
        ],
        messages: [{ role: "user", content: "old prompt" }],
      }],
      sessionBasePath: null,
      store: { append: async () => {}, replace: async (messages: unknown[]) => { persisted = messages; }, reset: async () => {}, load: async () => [], fork: async () => ({} as never), path: "" },
      model: {} as SessionState["model"],
      totalUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      turns: 1,
      permissions: "yolo" as const,
    } as unknown as SessionState;
    const output: string[] = [];
    const stream = new Writable({ write(chunk, _encoding, done) { output.push(String(chunk)); done(); } });
    return { state, output, stream, file: () => file, persisted: () => persisted };
  };

  it("restores file preimages and the prior transcript", async () => {
    const fixture = createState("after");
    await handleSlashCommand("/undo", fixture.state, ".", fixture.stream);
    expect(fixture.file()).toBe("before");
    expect(fixture.state.messages).toEqual([{ role: "user", content: "old prompt" }]);
    expect(fixture.persisted()).toEqual(fixture.state.messages);
    expect(fixture.state.undoHistory).toHaveLength(0);
  });

  it("refuses to overwrite a file changed since the agent turn", async () => {
    const fixture = createState("external edit");
    await handleSlashCommand("/undo", fixture.state, ".", fixture.stream);
    expect(fixture.file()).toBe("external edit");
    expect(fixture.state.undoHistory).toHaveLength(1);
    expect(fixture.output.join("")).toContain("changed since NAH edited it");
  });
});

describe("openrouter attribution", () => {
  const lower = (headers: Record<string, unknown>) =>
    Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));

  it("identifies the app so usage is attributed to nah", async () => {
    let seen: Record<string, unknown> = {};
    const real = globalThis.fetch;
    globalThis.fetch = (async (_url: unknown, init: { headers?: Record<string, unknown> }) => {
      seen = { ...(init?.headers ?? {}) };
      return new Response("{}", { status: 400 });
    }) as unknown as typeof fetch;
    try {
      const resolved = await resolveModel("openrouter:some-model", { OPENROUTER_API_KEY: "sk-test" } as never);
      await (resolved.model as unknown as {
        doGenerate: (args: unknown) => Promise<unknown>;
      }).doGenerate({ prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }], tools: {} });
    } catch {
      // The stubbed response is rejected; only the outgoing headers matter here.
    } finally {
      globalThis.fetch = real;
    }

    const headers = lower(seen);
    expect(headers["x-title"]).toBe("nah");
    expect(headers["http-referer"]).toBe("https://nah.astracollab.com");
  });

  it("lets a fork rename itself", async () => {
    let seen: Record<string, unknown> = {};
    const real = globalThis.fetch;
    globalThis.fetch = (async (_url: unknown, init: { headers?: Record<string, unknown> }) => {
      seen = { ...(init?.headers ?? {}) };
      return new Response("{}", { status: 400 });
    }) as unknown as typeof fetch;
    try {
      const resolved = await resolveModel("openrouter:some-model", {
        OPENROUTER_API_KEY: "sk-test",
        NAH_APP_NAME: "nah-fork",
        NAH_APP_URL: "https://example.test",
      } as never);
      await (resolved.model as unknown as {
        doGenerate: (args: unknown) => Promise<unknown>;
      }).doGenerate({ prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }], tools: {} });
    } catch {
      // Same: headers only.
    } finally {
      globalThis.fetch = real;
    }

    const headers = lower(seen);
    expect(headers["x-title"]).toBe("nah-fork");
    expect(headers["http-referer"]).toBe("https://example.test");
  });
});
