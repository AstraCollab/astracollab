import { describe, expect, it } from "vitest";

import { extractDeterministic } from "../src/memory-rules.js";

const texts = (message: string) => extractDeterministic(message).map((m) => m.content);

describe("deterministic extraction", () => {
  it("keeps a dotted value intact instead of truncating at the first period", () => {
    // Truncating here produced "internal-hbr-2291" and then poisoned recall.
    const found = texts("The internal staging host is internal-hbr-2291.pineapple.example.");
    expect(found).toContain("internal staging host is internal-hbr-2291.pineapple.example");
  });

  it("captures identifiers, paths and ports", () => {
    expect(texts("The staging build ID is ZQ7X4M2K.")).toContain("staging build ID is ZQ7X4M2K");
    expect(texts("The default port is 8080.")).toContain("default port is 8080");
    expect(texts("Deploy with ./ops/deploy.sh for that.")).toContain("User-referenced path: ./ops/deploy.sh");
  });

  it("captures URLs whole, query string included", () => {
    expect(texts("Deploy URL is https://staging.example.com/v2?x=1")).toContain(
      "User-provided URL: https://staging.example.com/v2?x=1",
    );
  });

  it("captures positive requirements", () => {
    // Kept in the user's own words: paraphrasing "Never force push" as
    // "requires: force push" inverted the instruction.
    expect(texts("For this repo, always use kebab-case for new file names.")).toContain(
      "User requirement (always): use kebab-case for new file names",
    );
    expect(texts("Never force push to main.")).toContain("User requirement (never): force push to main");
  });

  it("does not invert a negation into a requirement", () => {
    // "do not verify it against the repo" must never become
    // "The user requires: verify it against the repo".
    const found = texts("Just remember it, do not verify it against the repo.");
    expect(found.join(" | ")).not.toMatch(/requirement.*verify/i);
  });

  it("stops at a sentence boundary but not inside a value", () => {
    expect(texts("The staging host is a.example. Please deploy it.")).toContain(
      "staging host is a.example",
    );
  });

  it("ignores filler and non-assertions", () => {
    expect(texts("ok thanks")).toEqual([]);
    expect(texts("It is not important.")).toEqual([]);
    expect(texts("yes")).toEqual([]);
    expect(texts("")).toEqual([]);
  });

  it("deduplicates within a single message", () => {
    const found = texts("The port is 8080. The port is 8080.");
    expect(new Set(found).size).toBe(found.length);
  });
});
