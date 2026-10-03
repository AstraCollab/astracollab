import { describe, expect, it } from "vitest";
import { buildFileMerkleFromEntries, planIndexWork } from "./merkle.js";
import { chunkSourceFile, prioritizeIndexPaths } from "./chunk.js";
import { resolveRepoIndexState, semanticSearchAvailableForState } from "./resolve-state.js";
import { REPO_INDEX_MANIFEST_SCHEMA_VERSION } from "./types.js";

describe("planIndexWork", () => {
  it("detects added, changed, deleted", () => {
    const prior = [
      { path: "a.ts", sha256: "1", size: 1 },
      { path: "b.ts", sha256: "2", size: 2 },
    ];
    const current = [
      { path: "a.ts", sha256: "1", size: 1 },
      { path: "b.ts", sha256: "3", size: 3 },
      { path: "c.ts", sha256: "4", size: 4 },
    ];
    const plan = planIndexWork(current, prior);
    expect(plan.unchanged).toEqual(["a.ts"]);
    expect(plan.changed).toEqual(["b.ts"]);
    expect(plan.added).toEqual(["c.ts"]);
    expect(plan.deleted).toEqual([]);
  });
});

describe("chunkSourceFile", () => {
  it("splits long files into multiple chunks", () => {
    const lines = Array.from({ length: 200 }, (_, i) => `line ${i}`);
    const chunks = chunkSourceFile("lib/x.ts", lines.join("\n"), { maxChunkChars: 200 });
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[0]?.path).toBe("lib/x.ts");
  });
});

describe("prioritizeIndexPaths", () => {
  it("orders entry points first", () => {
    const ordered = prioritizeIndexPaths(
      ["z.ts", "app/page.tsx", "lib/util.ts"],
      { entryPointPaths: ["app/page.tsx"] },
    );
    expect(ordered[0]).toBe("app/page.tsx");
  });
});

describe("resolveRepoIndexState", () => {
  it("returns ready when percent high enough", () => {
    const state = resolveRepoIndexState({
      identity: { orgId: "o1", repoFullName: "a/b", gitHead: "abc" },
      manifest: {
        schemaVersion: REPO_INDEX_MANIFEST_SCHEMA_VERSION,
        orgId: "o1",
        repoFullName: "a/b",
        gitHead: "abc",
        merkleRoot: "r",
        fileCount: 10,
        chunkCount: 100,
        embeddedCount: 85,
        percentComplete: 85,
        status: "partial",
        updatedAt: new Date().toISOString(),
      },
      minPercentForReady: 80,
    });
    expect(state).toBe("ready");
    expect(
      semanticSearchAvailableForState(state, 80, {
        schemaVersion: REPO_INDEX_MANIFEST_SCHEMA_VERSION,
        orgId: "o1",
        repoFullName: "a/b",
        gitHead: "abc",
        merkleRoot: "r",
        fileCount: 10,
        chunkCount: 100,
        embeddedCount: 85,
        percentComplete: 85,
        status: "partial",
        updatedAt: new Date().toISOString(),
      }),
    ).toBe(true);
  });
});

describe("buildFileMerkleFromEntries", () => {
  it("is stable for same inputs", () => {
    const entries = [
      { path: "b.ts", sha256: "2", size: 2 },
      { path: "a.ts", sha256: "1", size: 1 },
    ];
    const a = buildFileMerkleFromEntries(entries);
    const b = buildFileMerkleFromEntries([...entries].reverse());
    expect(a.root).toBe(b.root);
  });
});
