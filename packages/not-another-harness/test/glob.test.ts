import { describe, expect, it } from "vitest";

import { globStaticPrefix, globToRegExp, hasGlobMagic } from "../src/glob.js";
import { normalizeWorkspacePath } from "../src/tools.js";

describe("globToRegExp", () => {
  const matches = (pattern: string, path: string) => globToRegExp(pattern).test(path);

  it("matches a single-segment wildcard", () => {
    expect(matches("*.ts", "a.ts")).toBe(true);
    expect(matches("*.ts", "src/a.ts")).toBe(false);
    expect(matches("src/*.ts", "src/a.ts")).toBe(true);
    expect(matches("src/*.ts", "src/nested/a.ts")).toBe(false);
  });

  it("matches across segments with **", () => {
    expect(matches("**/*.ts", "a.ts")).toBe(true);
    expect(matches("**/*.ts", "src/a.ts")).toBe(true);
    expect(matches("**/*.ts", "src/nested/deep/a.ts")).toBe(true);
    expect(matches("src/**", "src/a.ts")).toBe(true);
    expect(matches("src/**", "src/nested/a.ts")).toBe(true);
    // `src/**` means beneath src, not src itself.
    expect(matches("src/**", "src")).toBe(false);
  });

  it("supports ? and brace alternation", () => {
    expect(matches("a?.ts", "ab.ts")).toBe(true);
    expect(matches("a?.ts", "abc.ts")).toBe(false);
    expect(matches("**/*.{ts,tsx}", "src/a.tsx")).toBe(true);
    expect(matches("**/*.{ts,tsx}", "src/a.js")).toBe(false);
  });

  it("escapes regex metacharacters in literal segments", () => {
    expect(matches("src/a.b.ts", "src/a.b.ts")).toBe(true);
    expect(matches("src/a.b.ts", "src/axbxts")).toBe(false);
    expect(matches("a+b/c.ts", "a+b/c.ts")).toBe(true);
  });

  it("treats bare ** as matching everything", () => {
    expect(matches("**", "a")).toBe(true);
    expect(matches("**", "a/b/c")).toBe(true);
  });
});

describe("globStaticPrefix", () => {
  it("extracts leading literal segments for subtree pruning", () => {
    expect(globStaticPrefix("apps/nah/src/**/*.tsx")).toEqual(["apps", "nah", "src"]);
    expect(globStaticPrefix("**/page.tsx")).toEqual([]);
    expect(globStaticPrefix("src/*.ts")).toEqual(["src"]);
  });
});

describe("hasGlobMagic", () => {
  it("detects metacharacters", () => {
    expect(hasGlobMagic("src/*.ts")).toBe(true);
    expect(hasGlobMagic("src/main.ts")).toBe(false);
  });
});

describe("normalizeWorkspacePath", () => {
  it("collapses equivalent spellings so read-before-write matches", () => {
    expect(normalizeWorkspacePath("./notes.md")).toBe("notes.md");
    expect(normalizeWorkspacePath("notes.md")).toBe("notes.md");
    expect(normalizeWorkspacePath("src//notes.md")).toBe("src/notes.md");
    expect(normalizeWorkspacePath("src/./notes.md")).toBe("src/notes.md");
    expect(normalizeWorkspacePath("./src/../src/notes.md")).toBe("src/notes.md");
    expect(normalizeWorkspacePath(".")).toBe(".");
  });
});
