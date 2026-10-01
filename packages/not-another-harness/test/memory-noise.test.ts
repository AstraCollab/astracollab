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

describe("dedup", () => {
  it("collapses the deterministic and model restatements of one fact", async () => {
    const stored = await learn([
      "User requirement (always): use kebab-case for new file names",
      "New file names in this repository must always use kebab-case.",
      "For this repository, always use kebab-case when adding files.",
    ]);
    expect(stored).toHaveLength(1);
    expect(stored[0]).toContain("kebab-case");
  });

  it("collapses paraphrases of a stored fact", async () => {
    const stored = await learn([
      "The staging build ID is ZQ7X4M2K.",
      "The staging build ID ZQ7X4M2K must be treated as user-provided.",
    ]);
    expect(stored).toHaveLength(1);
  });

  it("keeps genuinely different facts apart", async () => {
    const stored = await learn([
      "The staging build ID is ZQ7X4M2K.",
      "The staging host is internal-hbr-2291.example.",
      "Deploys run via ops/deploy.sh.",
    ]);
    expect(stored).toHaveLength(3);
  });

  it("ignores the extractor's own label when comparing", async () => {
    // Same fact, one carrying a provenance label and one not.
    const stored = await learn([
      "User-provided URL: https://staging.example.com/v2",
      "The staging URL is https://staging.example.com/v2",
    ]);
    expect(stored).toHaveLength(1);
  });
});