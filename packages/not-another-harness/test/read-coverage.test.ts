import { describe, expect, it } from "vitest";
import { tool } from "ai";
import { z } from "zod";

import { createReadCoverage } from "../src/read-coverage.js";
import { DEFAULT_CAPS } from "../src/caps.js";

const FILE_LINES = 1200;

let reads = 0;
const countingRead = () =>
  tool({
    description: "read",
    inputSchema: z.object({
      path: z.string(),
      offset: z.number().optional(),
      limit: z.number().optional(),
    }),
    execute: async ({ offset, limit }) => {
      reads += 1;
      const start = offset ?? 1;
      // Must match the real tool's cap: the cache books a range from the cap,
      // so a stub that returns fewer lines would make the two disagree.
      const end = Math.min(FILE_LINES, start + (limit ?? DEFAULT_CAPS.read.maxLines) - 1);
      const body = Array.from({ length: end - start + 1 }, (_, i) => `${start + i}|line ${start + i}`).join("\n");
      return `${body}${end < FILE_LINES ? `\n[truncated: lines ${start}-${end} of ${FILE_LINES}. Next: read with offset=${end + 1}.]` : ""}`;
    },
  });

const editTool = tool({
  description: "edit",
  inputSchema: z.object({ path: z.string() }),
  execute: async () => "edited",
});

const bashTool = tool({
  description: "bash",
  inputSchema: z.object({ command: z.string() }),
  execute: async () => "ok",
});

const call = async (
  coverage: ReturnType<typeof createReadCoverage>,
  name: string,
  input: unknown,
): Promise<string> => {
  const result = await (coverage.tools[name] as { execute: (i: unknown, c: unknown) => Promise<string> }).execute(
    input,
    {},
  );
  return result;
};

describe("read coverage", () => {
  it("serves a later read that falls inside an earlier one", async () => {
    reads = 0;
    const coverage = createReadCoverage({ read: countingRead() });

    // A no-limit read covers [offset, offset+249]: the tool caps at maxLines,
    // it does not run to end of file.
    await call(coverage, "read", { path: "a.ts", offset: 700 });
    const before = reads;
    const second = await call(coverage, "read", { path: "a.ts", offset: 900, limit: 20 });

    expect(reads).toBe(before);
    expect(coverage.servedFromCache).toBe(1);
    expect(second).toContain("900|line 900");
    expect(second).toContain("[cached:");
  });

  it("strips the stale truncation notice it would otherwise replay", async () => {
    reads = 0;
    const coverage = createReadCoverage({ read: countingRead() });
    await call(coverage, "read", { path: "a.ts", offset: 1, limit: 50 });
    const cached = await call(coverage, "read", { path: "a.ts", offset: 1, limit: 50 });
    // "Next: read with offset=51" would send the model after a range it already has.
    expect(cached).not.toContain("Next: read with offset=51");
  });

  it("still reads a range it has not covered", async () => {
    reads = 0;
    const coverage = createReadCoverage({ read: countingRead() });
    await call(coverage, "read", { path: "a.ts", offset: 1, limit: 50 });
    await call(coverage, "read", { path: "a.ts", offset: 600, limit: 50 });
    expect(reads).toBe(2);
    expect(coverage.servedFromCache).toBe(0);
  });

  it("does not mistake the next page for a covered one", async () => {
    reads = 0;
    const coverage = createReadCoverage({ read: countingRead() });
    // offset 700 with no limit covers 700-949, so the notice's next offset 950
    // is a genuinely new page and must be read.
    await call(coverage, "read", { path: "a.ts", offset: 700 });
    await call(coverage, "read", { path: "a.ts", offset: 950 });
    expect(reads).toBe(2);
    expect(coverage.servedFromCache).toBe(0);
  });

  it("does not confuse one file with another", async () => {
    reads = 0;
    const coverage = createReadCoverage({ read: countingRead() });
    await call(coverage, "read", { path: "a.ts", offset: 1, limit: 50 });
    await call(coverage, "read", { path: "b.ts", offset: 1, limit: 50 });
    expect(reads).toBe(2);
  });

  it("does not treat a partial overlap as covered", async () => {
    reads = 0;
    const coverage = createReadCoverage({ read: countingRead() });
    await call(coverage, "read", { path: "a.ts", offset: 1, limit: 50 });
    // Starts inside but runs past what was fetched.
    await call(coverage, "read", { path: "a.ts", offset: 40, limit: 50 });
    expect(reads).toBe(2);
  });

  it("forgets everything once a file changes", async () => {
    reads = 0;
    const coverage = createReadCoverage({ read: countingRead(), edit: editTool });
    await call(coverage, "read", { path: "a.ts", offset: 1, limit: 50 });
    await call(coverage, "edit", { path: "a.ts" });
    await call(coverage, "read", { path: "a.ts", offset: 1, limit: 50 });
    // A stale read would be far worse than the duplicate this prevents.
    expect(reads).toBe(2);
    expect(coverage.servedFromCache).toBe(0);
  });

  it("forgets everything after a shell command, which can change anything", async () => {
    reads = 0;
    const coverage = createReadCoverage({ read: countingRead(), bash: bashTool });
    await call(coverage, "read", { path: "a.ts", offset: 1, limit: 50 });
    await call(coverage, "bash", { command: "git checkout -- ." });
    await call(coverage, "read", { path: "a.ts", offset: 1, limit: 50 });
    expect(reads).toBe(2);
  });

  it("leaves non-read tools untouched", async () => {
    const coverage = createReadCoverage({ read: countingRead(), bash: bashTool });
    expect(await call(coverage, "bash", { command: "ls" })).toBe("ok");
    expect(coverage.performed).toBe(0);
  });

  it("passes through a read with no usable range", async () => {
    reads = 0;
    const coverage = createReadCoverage({ read: countingRead() });
    // No offset or limit still means "from line 1", and must be tracked as such
    // rather than dropped.
    await call(coverage, "read", { path: "a.ts" });
    await call(coverage, "read", { path: "a.ts" });
    expect(reads).toBe(1);
    expect(coverage.servedFromCache).toBe(1);
  });
});