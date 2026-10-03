import { describe, expect, it } from "vitest";

import { DEFAULT_CAPS, resolveCaps } from "../src/caps.js";
import { createCodingTools } from "../src/tools.js";
import type { ToolEnvironment } from "../src/types.js";

/**
 * Cap overrides.
 *
 * The defaults are tuned for an interactive session; a different workload wants
 * different numbers, and the previous answer was "copy the tools". These tests
 * pin the merge and, more importantly, that an override actually reaches the
 * tool output rather than only the option bag.
 */

const env = {
  readFile: async () => Array.from({ length: 300 }, (_, i) => `line ${i + 1}`).join("\n"),
  writeFile: async () => {},
  exists: async () => true,
  readdir: async () => [],
  grep: async () => "",
  exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
} as unknown as ToolEnvironment;

const runRead = async (caps?: Parameters<typeof createCodingTools>[1]) => {
  const tools = createCodingTools(env, caps ?? {});
  const read = tools.read as { execute: (i: unknown, o: unknown) => Promise<string> };
  return read.execute({ path: "a.ts" }, {});
};

describe("resolveCaps", () => {
  it("returns the defaults untouched when there is nothing to override", () => {
    expect(resolveCaps()).toEqual(DEFAULT_CAPS);
    expect(resolveCaps(undefined)).toEqual(DEFAULT_CAPS);
  });

  it("overrides one number without requiring the other", () => {
    // The reason the type is partial at the number level: restating maxChars to
    // change maxLines is how an override ends up loosening what it meant to keep.
    const caps = resolveCaps({ read: { maxLines: 5 } });
    expect(caps.read.maxLines).toBe(5);
    expect(caps.read.maxChars).toBe(DEFAULT_CAPS.read.maxChars);
  });

  it("leaves other tools alone", () => {
    expect(resolveCaps({ read: { maxLines: 5 } }).list).toEqual(DEFAULT_CAPS.list);
    expect(resolveCaps({ read: { maxLines: 5 } }).bashFailure).toEqual(DEFAULT_CAPS.bashFailure);
  });

  it("ignores an unknown tool rather than inventing one", () => {
    expect(resolveCaps({ nope: { maxLines: 1 } } as never)).toEqual(DEFAULT_CAPS);
  });

  it("does not mutate the defaults", () => {
    resolveCaps({ read: { maxLines: 5 } });
    expect(DEFAULT_CAPS.read.maxLines).toBe(250);
  });
});

describe("the caps reach the tool", () => {
  it("caps read output by the default", async () => {
    const out = await runRead();
    expect(out).toContain("[truncated: lines 1-250 of 300");
    expect(out).toContain("offset=251");
  });

  it("caps read output by the override", async () => {
    const out = await runRead({ caps: { read: { maxLines: 2 } } });
    // The paging notice must name the override's number, or the model is told to
    // resume at a line that was never printed.
    expect(out).toContain("[truncated: lines 1-2 of 300");
    expect(out).toContain("offset=3");
  });

  it("names the configured limit in the tool description", async () => {
    const tools = createCodingTools(env, { caps: { read: { maxLines: 7 } } });
    expect((tools.read as { description: string }).description).toContain("7 lines");
  });

  it("applies bashFailure caps only on failure", async () => {
    const failing = {
      ...env,
      exec: async () => ({ stdout: "", stderr: "x\n".repeat(50), exitCode: 1 }),
    } as unknown as ToolEnvironment;
    const tools = createCodingTools(failing, { caps: { bashFailure: { maxLines: 2 } } });
    const bash = tools.bash as { execute: (i: unknown, o: unknown) => Promise<string> };
    const out = await bash.execute({ command: "false" }, {});
    expect(out).toContain("stderr:");
  });
});
