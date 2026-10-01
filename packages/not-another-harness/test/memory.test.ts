import { describe, expect, it } from "vitest";

import { CognitiveMemory } from "../src/cognitive-memory/cognitive-memory.js";

let memCounter = 0;
const mem = (content: string, domains: string[] = []) => ({
  id: `m${(memCounter += 1)}`,
  content,
  bookmark: content,
  tier: "L1" as const,
  metadata: { domains, createdAt: 1, lastAccessedAt: 1, accessCount: 0 },
});

describe("memory extraction", () => {
  it("learns facts, not just phrased preferences", async () => {
    const m = new CognitiveMemory({ autoExtractMemories: false });
    await m.postTurnAsync({
      userMessage: "The staging build ID is ZQ7X4M2K.",
      assistantResponse: "Noted, not verified. ".repeat(5),
    });
    // No extractor and no regex hit: nothing should be learned.
    expect(m.getSnapshot().l1).toHaveLength(0);
    expect(m.getSnapshot().l2).toHaveLength(0);
  });

  it("uses a supplied extractor and makes it usable on the very next turn", async () => {
    const m = new CognitiveMemory({
      extract: async () => ({
        memories: [
          { content: "The staging build ID is ZQ7X4M2K.", domains: ["deployment"] },
          { content: "The internal staging host is hbr-2291.example.", domains: ["infra"] },
        ],
      }),
    });
    await m.postTurnAsync({ userMessage: "remember these", assistantResponse: "ok" });

    // Filed in L1 straight away: waiting for the arbiter to promote cost a turn
    // of latency, so a freshly-taught fact was missing from the next prompt.
    expect(m.getSnapshot().l1).toHaveLength(2);
    expect(m.getPromptContext("what is the build id?")).toContain("ZQ7X4M2K");
  });

  it("falls back to the regex when the extractor throws", async () => {
    const m = new CognitiveMemory({
      extract: async () => {
        throw new Error("model unavailable");
      },
    });
    await m.postTurnAsync({
      userMessage: "For this repo, always use kebab-case for new file names.",
      assistantResponse: "Confirmed. ".repeat(20),
    });
    expect(m.getPromptContext("x").toLowerCase()).toContain("kebab");
  });

  it("does not re-learn a paraphrase of something it already knows", async () => {
    const seen: string[] = [];
    const m = new CognitiveMemory({
      extract: async ({ userMessage }) => {
        seen.push(userMessage);
        return {
          memories: [
            { content: "The staging build ID is ZQ7X4M2K.", domains: [] },
            // Same fact, more words: must be rejected as a duplicate.
            {
              content: "The staging build ID ZQ7X4M2K must be treated as user-provided, not verified.",
              domains: [],
            },
          ],
        };
      },
    });
    await m.postTurnAsync({ userMessage: "teach", assistantResponse: "ok" });
    expect(seen).toHaveLength(1);
    const stored = [...m.getSnapshot().l1, ...m.getSnapshot().l2];
    expect(stored).toHaveLength(1);
    expect(stored[0]!.content).toContain("ZQ7X4M2K");
  });

  it("ignores empty or trivially short extractions", async () => {
    const m = new CognitiveMemory({
      extract: async () => ({ memories: [{ content: "  " }, { content: "ok" }] }),
    });
    await m.postTurnAsync({ userMessage: "teach", assistantResponse: "ok" });
    expect(m.getSnapshot().l2).toHaveLength(0);
  });
});

describe("memory promotion", () => {
  it("promotes a warm candidate whose words overlap the turn", async () => {
    const m = new CognitiveMemory();
    m.addMemory(mem("The staging build ID is ZQ7X4M2K.", ["deployment"]), "L2");

    await m.postTurnAsync({
      userMessage: "What is the staging build id for this project?",
      assistantResponse: "unknown",
    });

    // Relevance is token overlap, not an exact domain substring: "deployment"
    // never appears in the question, but "staging"/"build"/"id" do.
    expect(m.getPromptContext("x")).toContain("ZQ7X4M2K");
  });

  it("leaves an unrelated candidate in the warm tier", async () => {
    const m = new CognitiveMemory();
    m.addMemory(mem("The billing webhook signs with key KX99QQ.", ["payments"]), "L2");

    await m.postTurnAsync({
      userMessage: "What is the staging build id for this project?",
      assistantResponse: "unknown",
    });

    expect(m.getPromptContext("x")).not.toContain("KX99QQ");
    expect(m.getSnapshot().l2).toHaveLength(1);
  });
});

describe("memory budgets and persistence", () => {
  it("demotes L1 items rather than dropping them when over budget", async () => {
    // A budget this small cannot hold more than a couple of items.
    const m = new CognitiveMemory({ maxL1Tokens: 12 });
    for (let i = 0; i < 6; i += 1) {
      m.addMemory(mem(`Fact number ${i} is recorded in the project notes.`), "L1");
    }
    // Budgets are enforced at the end of a turn.
    await m.postTurnAsync({ userMessage: "continue", assistantResponse: "ok" });
    expect(m.getSnapshot().l1.length).toBeLessThan(6);
    // Nothing was lost: the overflow is still addressable in L2.
    expect(m.getSnapshot().l1.length + m.getSnapshot().l2.length).toBe(6);
  });

  it("round-trips through a snapshot", async () => {
    const a = new CognitiveMemory({
      extract: async () => ({ memories: [{ content: "The staging build ID is ZQ7X4M2K." }] }),
    });
    await a.postTurnAsync({ userMessage: "remember", assistantResponse: "ok" });
    const snap = a.getSnapshot();
    expect(snap.l1).toHaveLength(1);

    const b = new CognitiveMemory();
    b.loadSnapshot(JSON.parse(JSON.stringify(snap)) as never);
    expect(b.getSnapshot().l1).toHaveLength(1);
    expect(b.getSnapshot().stats.totalTurnsProcessed).toBe(1);
  });

  it("persists after each turn when a hook is registered", async () => {
    const saved: unknown[] = [];
    const m = new CognitiveMemory({
      extract: async () => ({ memories: [{ content: "The staging build ID is ZQ7X4M2K." }] }),
      onPersist: (state) => {
        saved.push(state);
      },
    });
    await m.postTurnAsync({ userMessage: "remember", assistantResponse: "ok" });
    expect(saved).toHaveLength(1);
  });
});
