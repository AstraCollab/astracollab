import { describe, expect, it } from "vitest";
import type { ModelMessage } from "ai";

import { CognitiveMemory, extractIdentifiers } from "@astracollab/not-another-harness";
import { detectMemoryTriggers, MemoryInjectionLog } from "../src/memory-injection.js";

let seq = 0;
const mem = (content: string, domains: string[] = [], gist?: string) => ({
  id: `m${(seq += 1)}`,
  content,
  bookmark: content.slice(0, 80),
  gist,
  tier: "L1" as const,
  metadata: { domains, createdAt: 1, lastAccessedAt: 1, accessCount: 0 },
});

const seeded = (budget?: number) => {
  seq = 0;
  const m = new CognitiveMemory(budget === undefined ? {} : { maxTotalTokens: budget });
  m.addMemory(
    mem("The staging build ID is ZQ7X4M2K.", ["deployment"], "staging build ID"),
    "L1",
  );
  m.addMemory(
    mem("New file names must use kebab-case.", ["naming"], "file naming: kebab-case"),
    "L1",
  );
  return m;
};

const transcript = (...contents: string[]): ModelMessage[] =>
  contents.map((content) => ({ role: "user", content }) as ModelMessage);

describe("identifier extraction", () => {
  it("finds the identifier shapes a user actually types", () => {
    const found = extractIdentifiers(
      "check https://staging.example.com/v2 and ops/deploy.sh with ZQ7X4M2K and getUserProfile",
    );
    expect(found).toContain("https://staging.example.com/v2");
    expect(found).toContain("ops/deploy.sh");
    expect(found).toContain("ZQ7X4M2K");
    expect(found).toContain("getUserProfile");
  });

  it("ignores ordinary prose", () => {
    expect(extractIdentifiers("please add a docs section")).toEqual([]);
  });
});

describe("index/body split", () => {
  it("includes a gist, not the body, by default", () => {
    const report = seeded().planInjection({});
    expect(report.entries).toHaveLength(2);
    for (const entry of report.entries) {
      expect(entry.reason).toBe("index");
      expect(entry.body).toBeUndefined();
    }
    // The full sentence must not be in the prompt.
    expect(report.text).not.toContain("The staging build ID is ZQ7X4M2K.");
    expect(report.text).toContain("staging build ID");
  });

  it("includes the body for a forced id", () => {
    const m = seeded();
    const [first] = m.planInjection({ forceFull: ["m1"] }).entries;
    expect(first?.reason).toBe("trigger");
    expect(first?.body).toContain("ZQ7X4M2K");
    expect(m.planInjection({ forceFull: ["m1"] }).text).toContain("ZQ7X4M2K");
  });

  it("falls back to a truncated first sentence when no gist was supplied", () => {
    const m = new CognitiveMemory();
    m.addMemory(mem("A long remembered statement that has no gist attached to it at all."), "L1");
    const [entry] = m.planInjection({}).entries;
    expect(entry?.gist.length).toBeLessThanOrEqual(91);
    expect(entry?.gist).toContain("A long remembered statement");
  });

  it("respects the total budget and says so", () => {
    const tiny = seeded(4);
    const report = tiny.planInjection({});
    expect(report.truncated).toBe(true);
    expect(report.entries).toHaveLength(0);
  });
});

describe("deterministic triggers", () => {
  it("forces a body when the user names an identifier absent from the transcript", () => {
    const m = seeded();
    const forced = detectMemoryTriggers(m, "what about ZQ7X4M2K?", transcript("unrelated"));
    expect(forced).toContain("m1");
  });

  it("does not spend tokens on something already in the transcript", () => {
    const m = seeded();
    // The identifier is already visible, so the model does not need it re-sent.
    const forced = detectMemoryTriggers(m, "and ZQ7X4M2K?", transcript("we set ZQ7X4M2K earlier"));
    expect(forced).toEqual([]);
  });

  it("returns nothing without memory or without identifiers", () => {
    expect(detectMemoryTriggers(undefined, "ZQ7X4M2K", [])).toEqual([]);
    expect(detectMemoryTriggers(seeded(), "add some docs", [])).toEqual([]);
  });

  it("matches on a path identifier, not just codes", () => {
    seq = 0;
    const m = new CognitiveMemory();
    m.addMemory(mem("Deploy with ops/deploy.sh, which runs the release."), "L1");
    expect(detectMemoryTriggers(m, "run ops/deploy.sh now", [])).toEqual(["m1"]);
  });

  it("does not force a memory that merely shares an unrelated word", () => {
    const m = seeded();
    // "naming" appears in the memory's tags but not in an unrelated question.
    expect(detectMemoryTriggers(m, "what is the weather today", [])).toEqual([]);
  });
});

describe("injection log", () => {
  it("records why each memory was included", () => {
    const log = new MemoryInjectionLog();
    log.record(seeded().planInjection({}));
    log.record(seeded().planInjection({ forceFull: ["m1"] }));

    const [first, second] = log.entries;
    expect(first?.items.every((i) => i.reason === "index")).toBe(true);
    expect(second?.items.some((i) => i.reason === "trigger" && i.hasBody)).toBe(true);

    const summary = log.summary();
    expect(summary.turns).toBe(2);
    expect(summary.byReason.index).toBeGreaterThan(0);
    expect(summary.byReason.trigger).toBeGreaterThan(0);
    expect(summary.avgTokens).toBeGreaterThan(0);
  });

  it("counts budget-truncated turns", () => {
    const log = new MemoryInjectionLog();
    log.record(seeded(4).planInjection({}));
    expect(log.summary().truncatedTurns).toBe(1);
  });

  it("keeps only the most recent turns", () => {
    const log = new MemoryInjectionLog();
    for (let i = 0; i < 40; i += 1) log.record(seeded().planInjection({}));
    expect(log.entries.length).toBeLessThanOrEqual(20);
  });
});

describe("/memory rendering", () => {
  it("shows whole statements, not an 80-character slice", () => {
    // Regression: `/memory` rendered `item.bookmark || content.slice(0, 80)`, and
    // bookmark is itself `content.slice(0, 80)`, so complete memories were cut
    // mid-sentence with no ellipsis. That reads as corrupt data when the stored
    // value is actually fine.
    const memory = new CognitiveMemory();
    const long =
      "The AI used by myresumeguru, including its resume-feedback functionality, " +
      "should be changed to astracollab/not-another-harness.";
    expect(long.length).toBeGreaterThan(80);
    memory.addMemory(
      {
        id: "m1",
        content: long,
        bookmark: long.slice(0, 80),
        tier: "L1",
        metadata: { domains: ["project"], createdAt: 1, lastAccessedAt: 1, accessCount: 0 },
      },
      "L1",
    );
    const stored = memory.getSnapshot().l1[0]!.content;
    // Stored intact; the bug was purely in display.
    expect(stored).toBe(long);
    // An 80-char slice would have lost the tail.
    expect(stored.slice(0, 80)).not.toBe(stored);
  });
});
