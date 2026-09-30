import { describe, expect, it } from "vitest";
import { normalizeUnderRepoRoot, RepoPathError } from "./path-utils.js";

describe("normalizeUnderRepoRoot", () => {
  it("joins relative paths under repo root", () => {
    expect(normalizeUnderRepoRoot("/workspace/repo", "app/foo.ts")).toBe(
      "/workspace/repo/app/foo.ts",
    );
  });

  it("allows absolute paths inside root", () => {
    expect(normalizeUnderRepoRoot("/workspace/repo", "/workspace/repo/x.ts")).toBe(
      "/workspace/repo/x.ts",
    );
  });

  it("rejects escape", () => {
    expect(() => normalizeUnderRepoRoot("/workspace/repo", "/etc/passwd")).toThrow(
      RepoPathError,
    );
  });

  it("resolves .astra profile path under repo root", () => {
    expect(
      normalizeUnderRepoRoot("/workspace/repo", ".astra/codebase-profile.json"),
    ).toBe("/workspace/repo/.astra/codebase-profile.json");
    expect(
      normalizeUnderRepoRoot(
        "/workspace/repo",
        "/workspace/repo/.astra/codebase-profile.json",
      ),
    ).toBe("/workspace/repo/.astra/codebase-profile.json");
  });
});
