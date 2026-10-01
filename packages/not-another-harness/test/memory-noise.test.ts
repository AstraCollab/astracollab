import { describe, expect, it } from "vitest";

import { CognitiveMemory, isInteractionScoped } from "../src/cognitive-memory/cognitive-memory.js";

const learn = async (contents: string[], turns = 3): Promise<string[]> => {
  const m = new CognitiveMemory({
    extract: async () => ({ memories: contents.map((content) => ({ content })) }),
  });
  for (let i = 0; i < turns; i += 1) {
    await m.postTurnAsync({ userMessage: `turn ${i}`, assistantResponse: "ok" });
  }
  return m.getSnapshot().l1.map((item) => item.content);
};

describe("interaction-scoped filtering", () => {
  it("recognises instructions about this conversation, not the project", () => {
    for (const phrase of [
      "Do not verify the staging build ID against the repository.",
      "Just remember this, do not check it against the repo.",
      "Held in this conversation only.",
      "Remembered but not verified.",
      "For this session only.",
      "ok",
    ]) {
      expect(isInteractionScoped(phrase), phrase).toBe(true);
    }
  });

  it("does not discard durable project facts", () => {
    for (const fact of [
      "New file names must use kebab-case.",
      "The staging host is h.example.",
      "Deploys run via ops/deploy.sh.",
      "Always check the migration before deploying.",
      "Never commit directly to the release branch.",
    ]) {
      expect(isInteractionScoped(fact), fact).toBe(false);
    }
  });

  it("drops meta-instructions at extraction time", async () => {
    const stored = await learn([
      "Do not verify the staging build ID against the repository.",
      "Just remember this, do not verify it against the repo.",
      "The staging build ID is ZQ7X4M2K.",
    ]);
    expect(stored).toHaveLength(1);
    expect(stored[0]).toContain("ZQ7X4M2K");
  });
});

describe("dedup under the two-stage contract", () => {
  const extract = (a: string, b: string) =>
    new CognitiveMemory({ extract: async () => ({ memories: [{ content: a }, { content: b }] }) });
  const held = (m: CognitiveMemory) => m.getSnapshot().l1.length;

  it("holds near-duplicates when nothing can adjudicate", async () => {
    // The observed failure: one request stated two ways produced two memories.
    // Lexical overlap is 0.4, below any safe gate, so holding both is correct
    // without a reconcile function.
    const m = extract(
      "The user wants the AI used by myresumeguru to be swappable and the change to apply to resume feedback as well.",
      "The AI used by myresumeguru, including its resume-feedback functionality, should be changed to astracollab/not-another-harness.",
    );
    await m.postTurnAsync({ userMessage: "go", assistantResponse: "ok" });
    expect(held(m)).toBe(2);
  });

  it("merges a restatement when the adjudicator returns merge", async () => {
    const m = new CognitiveMemory({
      extract: async () => ({
        memories: [
          { content: "The staging build ID is ZQ7X4M2K." },
          { content: "The staging build ID is ZQ7X4M2K, supplied by the user for the staging environment." },
        ],
      }),
      reconcile: async () => ({
        action: "merge",
        content: "The staging build ID is ZQ7X4M2K, supplied by the user for the staging environment.",
      }),
    });
    await m.postTurnAsync({ userMessage: "go", assistantResponse: "ok" });
    expect(held(m)).toBe(1);
    expect(m.getSnapshot().l1[0]!.content).toContain("supplied by the user");
  });

  it("no longer auto-merges a paraphrase on lexical overlap alone", async () => {
    const m = extract(
      "User prefers tabs for indentation.",
      "The user prefers tab characters when indenting source files.",
    );
    await m.postTurnAsync({ userMessage: "go", assistantResponse: "ok" });
    expect(held(m)).toBe(2);
  });

  it("treats the extractor's own label as not part of the fact", async () => {
    const m = extract(
      "User-provided URL: https://staging.example.com/v2",
      "The staging URL is https://staging.example.com/v2",
    );
    await m.postTurnAsync({ userMessage: "go", assistantResponse: "ok" });
    expect(held(m)).toBe(2);
  });
});
