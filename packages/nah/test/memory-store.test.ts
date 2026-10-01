import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openEphemeralStore } from "../src/memory-store.js";
import { legacyMemoryJsonPath, MemoryStore } from "../src/memory-store.js";
import type { CognitiveMemoryStateSnapshot } from "@astracollab/not-another-harness";

/**
 * The SQLite store.
 *
 * Every case here is a way memory can be lost, which is the only failure mode
 * this file cares about: a snapshot that does not round-trip, a tier that
 * silently vanishes, and a migration that removes the old file before the new one
 * is known to be readable.
 */

const snapshot = (): CognitiveMemoryStateSnapshot => ({
  l0: {
    tensions: [
      {
        id: "tension-1",
        status: "active",
        claimA: { source: "user", statement: "We deploy on Fridays", timestamp: 1000 },
        claimB: { source: "conversation", statement: "We never deploy on Fridays", timestamp: 2000 },
        impact: "critical",
        taskRelevance: 1,
        actionableQuestion: "Which is it?"
      }
    ],
    selfModel: {
      domains: {
        database: {
          reliabilityScore: 0.53,
          sampleCount: 2,
          knownFailurePatterns: ["migrated without a backup"],
          recommendedStrategies: ["always snapshot first"]
        }
      },
      calibrationFactor: 0.9,
      activeDomains: ["database"]
    },
    activeTaskTrace: "trace text"
  },
  l1: [
    {
      id: "m1",
      content: "The staging build id is ZQ7X4M2K",
      bookmark: "staging build",
      gist: "staging build id",
      tier: "L1",
      metadata: {
        domains: ["deployment"],
        createdAt: 1000,
        lastAccessedAt: 2000,
        accessCount: 3,
        sourceSessionId: "session-1"
      }
    }
  ],
  l2: [
    {
      id: "m2",
      content: "File naming is kebab-case",
      bookmark: "naming",
      tier: "L2",
      metadata: { domains: ["naming"], createdAt: 1100, lastAccessedAt: 2100, accessCount: 0 }
    }
  ],
  l3: [
    {
      id: "m3",
      content: "The old billing endpoint was decommissioned",
      bookmark: "billing",
      tier: "L3",
      metadata: { domains: [], createdAt: 1200, lastAccessedAt: 2200, accessCount: 0 }
    }
  ],
  stats: { totalTurnsProcessed: 7, predictionsHit: 3, predictionsTotal: 5, tensionsDetected: 1 }
});

describe("MemoryStore", () => {
  let store: MemoryStore;

  beforeEach(() => {
    store = openEphemeralStore();
  });

  afterEach(() => {
    store.close();
  });

  it("round-trips a full snapshot without losing a field", () => {
    const original = snapshot();
    store.save(original);
    const loaded = store.load();

    expect(loaded).not.toBeNull();
    expect(loaded?.l1).toHaveLength(1);
    expect(loaded?.l2).toHaveLength(1);
    expect(loaded?.l3).toHaveLength(1);
    expect(loaded?.l1[0]).toEqual(original.l1[0]);
    expect(loaded?.l2[0]).toEqual(original.l2[0]);
    expect(loaded?.l3[0]).toEqual(original.l3[0]);
    expect(loaded?.l0.tensions).toEqual(original.l0.tensions);
    expect(loaded?.l0.selfModel).toEqual(original.l0.selfModel);
    expect(loaded?.l0.activeTaskTrace).toBe("trace text");
    expect(loaded?.stats).toEqual(original.stats);
  });

  it("keeps tiers apart", () => {
    store.save(snapshot());
    const loaded = store.load();

    expect(loaded?.l1.map((m) => m.id)).toEqual(["m1"]);
    expect(loaded?.l2.map((m) => m.id)).toEqual(["m2"]);
    expect(loaded?.l3.map((m) => m.id)).toEqual(["m3"]);
    expect(store.counts()).toEqual({ L1: 1, L2: 1, L3: 1 });
  });

  it("replaces rather than accumulates on the second save", () => {
    store.save(snapshot());
    store.save({ ...snapshot(), l1: [], l2: [], l3: [] });

    // The engine hands over the whole truth every turn; a store that appended
    // would resurrect deleted memories forever.
    expect(store.load()?.l1).toHaveLength(0);
    expect(store.counts()).toEqual({});
  });

  it("reports an empty store as absent rather than as empty memory", () => {
    // These are different states: a first run, and memory that was cleared.
    expect(store.isEmpty()).toBe(true);
    expect(store.load()).toBeNull();
  });

  it("survives a reopen, because that is the entire point of persistence", () => {
    const dir = mkdtempSync(join(tmpdir(), "nah-memory-"));
    try {
      const path = join(dir, "memory.sqlite");
      const first = new MemoryStore({ path });
      first.save(snapshot());
      first.close();

      const second = new MemoryStore({ path });
      expect(second.load()?.l1[0]?.content).toBe("The staging build id is ZQ7X4M2K");
      second.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("leaves the store untouched when a save fails part-way", () => {
    store.save(snapshot());
    const before = store.load();

    // A snapshot that throws mid-save must not leave half a state behind.
    const broken = snapshot();
    (broken.l0.tensions as unknown as Array<{ id: string }>).push(null as never);
    expect(() => store.save(broken)).toThrow();

    expect(store.load()).toEqual(before);
  });
});

describe("importing a pre-SQLite memory", () => {
  let home: string;
  let previousHome: string | undefined;

  beforeEach(() => {
    previousHome = process.env.HOME;
    home = mkdtempSync(join(tmpdir(), "nah-home-"));
    process.env.HOME = home;
    // The store creates this itself; a test that writes the legacy file directly
    // has to as well, and forgetting produces a confusing ENOENT rather than a
    // failure that points at the migration.
    mkdirSync(join(home, ".nah", "memory"), { recursive: true });
  });

  afterEach(() => {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  });

  it("brings a JSON memory forward and keeps the original", () => {
    const cwd = "/tmp/some-project";
    const legacy = legacyMemoryJsonPath(cwd);
    writeFileSync(legacy, JSON.stringify(snapshot(), null, 2));

    const store = openEphemeralStore();
    const result = store.importLegacyJson(cwd);
    const imported = store.load();
    store.close();

    expect(result.imported).toBe(true);
    expect(imported?.l1[0]?.content).toBe("The staging build id is ZQ7X4M2K");

    // The original is renamed, not deleted. It is the only copy of someone's
    // memory, and a migration that destroys the source before the destination is
    // known to be readable is not a migration.
    expect(result.path).toBe(`${legacy}.imported`);
    const kept = JSON.parse(readFileSync(`${legacy}.imported`, "utf8")) as CognitiveMemoryStateSnapshot;
    expect(kept.l1[0]?.content).toBe("The staging build id is ZQ7X4M2K");
  });

  it("does nothing when there is no legacy file", () => {
    const store = openEphemeralStore();
    const result = store.importLegacyJson("/tmp/never-seen-this-project");
    store.close();

    expect(result.imported).toBe(false);
    expect(result.path).toBeUndefined();
  });

  it("leaves the legacy file alone when it is not a memory snapshot", () => {
    const cwd = "/tmp/corrupt-project";
    const legacy = legacyMemoryJsonPath(cwd);
    writeFileSync(legacy, "{ this is not json");

    const store = openEphemeralStore();
    const result = store.importLegacyJson(cwd);
    store.close();

    expect(result.imported).toBe(false);
    // Nothing was written, so nothing was renamed: the operator can still look
    // at whatever that file was.
    expect(readFileSync(legacy, "utf8")).toBe("{ this is not json");
  });
});
