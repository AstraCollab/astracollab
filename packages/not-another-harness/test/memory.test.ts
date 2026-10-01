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

  it("holds a paraphrase for adjudication instead of merging it blind", async () => {
    // Lexical overlap peaks on identical strings and bottoms out on the
    // paraphrases that add information, so it must not make this call itself.
    // Under-merge is the safe bias: a duplicate row is recoverable, a wrong merge
    // is not.
    const m = new CognitiveMemory({
      extract: async () => ({
        // The real pair from a live session: same request, two angles.
        memories: [
          {
            content:
              "The user wants the AI used by myresumeguru to be swappable and the change to apply to resume feedback as well.",
          },
          {
            content:
              "The AI used by myresumeguru, including its resume-feedback functionality, should be changed to astracollab/not-another-harness.",
          },
        ],
      }),
    });
    await m.postTurnAsync({ userMessage: "teach", assistantResponse: "ok" });
    // Held as two candidates: lexical overlap is 0.4, below any safe gate, and
    // nothing can adjudicate without a reconcile function.
    expect(m.getSnapshot().l1.length).toBe(2);
  });

  it("merges a restatement when the adjudicator says so, keeping the fuller text", async () => {
    const m = new CognitiveMemory({
      extract: async () => ({
        memories: [
          { content: "User prefers kebab-case." },
          { content: "User prefers kebab-case file names for new source files." },
        ],
      }),
      reconcile: async ({ items }) => items.map(() => ({
        action: "merge" as const,
        content: "User prefers kebab-case file names for new source files.",
      })),
    });
    await m.postTurnAsync({ userMessage: "teach", assistantResponse: "ok" });
    const stored = [...m.getSnapshot().l1, ...m.getSnapshot().l2].map((i) => i.content);
    expect(stored).toEqual(["User prefers kebab-case file names for new source files."]);
  });

  it("declines a merge that would drop a qualifier, keeping both", async () => {
    const m = new CognitiveMemory({
      extract: async () => ({
        memories: [
          { content: "Deploys go to the staging environment." },
          { content: "Deploys go to the staging environment these days." },
        ],
      }),
      // The adjudicator calls this a restatement and offers a "fuller" text
      // that quietly drops "never production", the part that made the two
      // statements differ.
      reconcile: async ({ items }) => items.map(() => ({
        action: "merge" as const,
        content: "Deploys go to the staging environment.",
      })),
    });
    await m.postTurnAsync({ userMessage: "teach", assistantResponse: "ok" });
    const stored = [...m.getSnapshot().l1, ...m.getSnapshot().l2].map((i) => i.content);
    // Both survive: a duplicate costs one index line, a silent deletion is gone.
    expect(stored).toHaveLength(2);
    expect(stored).toContain("Deploys go to the staging environment.");
  });

  it("keeps the survivor intact when a merge would drop an identifier", async () => {
    const m = new CognitiveMemory({
      extract: async () => ({
        memories: [
          { content: "The staging build ID is ZQ7X4M2K." },
          { content: "Staging build ID is ZQ7X4M2K for the staging environment." },
        ],
      }),
      reconcile: async ({ items }) => items.map(() => ({
        action: "merge" as const,
        content: "There is a staging build ID.",
      })),
    });
    await m.postTurnAsync({ userMessage: "teach", assistantResponse: "ok" });
    const stored = [...m.getSnapshot().l1, ...m.getSnapshot().l2].map((i) => i.content);
    expect(stored).toContain("The staging build ID is ZQ7X4M2K.");
    expect(stored).not.toContain("There is a staging build ID.");
  });

  it("allows a merge that only folds a plural", async () => {
    const m = new CognitiveMemory({
      extract: async () => ({
        memories: [
          { content: "The deploys target staging." },
          { content: "The deploys target staging these days." },
        ],
      }),
      reconcile: async ({ items }) => items.map(() => ({
        action: "merge" as const,
        content: "The deploy target staging these days.",
      })),
    });
    await m.postTurnAsync({ userMessage: "teach", assistantResponse: "ok" });
    const stored = [...m.getSnapshot().l1, ...m.getSnapshot().l2].map((i) => i.content);
    expect(stored).toEqual(["The deploy target staging these days."]);
  });

  it("leaves a replace target unchanged when its new text drops detail", async () => {
    const m = new CognitiveMemory({
      extract: async () => ({
        memories: [
          { content: "The staging build ID is ZQ7X4M2K." },
          { content: "The staging build ID is QP8N1R3T." },
        ],
      }),
      reconcile: async ({ items }) =>
        items.map(() => ({ action: "replace" as const, content: "A staging build ID." })),
    });
    await m.postTurnAsync({ userMessage: "teach", assistantResponse: "ok" });
    const stored = [...m.getSnapshot().l1, ...m.getSnapshot().l2].map((i) => i.content);
    // The old value is still superseded, but the new entry keeps its own text
    // rather than being trimmed to something that dropped the id.
    expect(stored).not.toContain("The staging build ID is ZQ7X4M2K.");
    expect(stored).toContain("The staging build ID is QP8N1R3T.");
  });

  it("supersedes the old entry on replace", async () => {
    const first = new CognitiveMemory({
      extract: async () => ({ memories: [{ content: "Staging host is h1.example." }] }),
    });
    await first.postTurnAsync({ userMessage: "teach", assistantResponse: "ok" });

    const second = new CognitiveMemory({
      extract: async () => ({ memories: [{ content: "Staging host is h2.example." }] }),
      reconcile: async ({ items }) => items.map(() => ({ action: "replace" as const })),
    });
    second.loadSnapshot(first.getSnapshot());
    await second.postTurnAsync({ userMessage: "teach", assistantResponse: "ok" });

    const stored = [...second.getSnapshot().l1, ...second.getSnapshot().l2].map((i) => i.content);
    expect(stored).not.toContain("Staging host is h1.example.");
    expect(stored).toContain("Staging host is h2.example.");
  });

  it("honours reject, and keeps the candidate if the adjudicator throws", async () => {
    const seed = new CognitiveMemory({
      extract: async () => ({ memories: [{ content: "Deploys run from the release branch." }] }),
    });
    await seed.postTurnAsync({ userMessage: "teach", assistantResponse: "ok" });

    const rejected = new CognitiveMemory({
      extract: async () => ({
        memories: [{ content: "The deploy script lives at ops/deploy.sh and runs the release." }],
      }),
      reconcile: async ({ items }) => items.map(() => ({ action: "reject" as const })),
    });
    rejected.loadSnapshot(seed.getSnapshot());
    await rejected.postTurnAsync({ userMessage: "teach", assistantResponse: "ok" });
    expect(rejected.getSnapshot().l1).toHaveLength(1);
    expect(rejected.getSnapshot().l1[0]!.content).toBe("Deploys run from the release branch.");

    const failing = new CognitiveMemory({
      extract: async () => ({
        memories: [
          { content: "User prefers tabs over spaces." },
          { content: "The user prefers tab characters in this repository." },
        ],
      }),
      reconcile: async () => {
        throw new Error("model unavailable");
      },
    });
    await failing.postTurnAsync({ userMessage: "teach", assistantResponse: "ok" });
    expect(failing.getSnapshot().l1.length).toBe(2);
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
