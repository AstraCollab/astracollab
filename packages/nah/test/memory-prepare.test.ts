import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { memoryFileFor, prepareMemory } from "../src/memory.js";
import type { MemoryItem } from "not-another-harness";

/**
 * What `prepareMemory` actually hands the engine.
 *
 * Two ways this can go quietly wrong, and both look healthy from the outside:
 * an option that is accepted, threaded in from the caller, and then dropped on
 * the floor, and a persistence switch that is documented but never read. Neither
 * throws, so only a test that asks the engine a question can see them.
 */

const KNOWN = "The staging build ID is ZQ7X4M2K.";

const seed = (content: string): MemoryItem => ({
  id: "m-seed",
  content,
  bookmark: "staging build id",
  tier: "L1",
  metadata: { domains: [], createdAt: 1_000, lastAccessedAt: 1_000, accessCount: 1 },
});

/** No "?" and no "always/is" phrasing, so the deterministic pass stays silent. */
const TURN = {
  userMessage: "We settled on ZQ7X4M2K for that release.",
  assistantResponse: "Understood, I will use ZQ7X4M2K.",
};

describe("prepareMemory: the reconciler reaches the engine", () => {
  it("adjudicates a restatement instead of storing it twice", async () => {
    const prepared = await prepareMemory({
      cwd: "/tmp/nah-reconcile-project",
      persist: false,
      extractor: async () => ({ memories: [{ content: "The staging build id is ZQ7X4M2K" }] }),
      reconciler: async () => [
        { action: "merge" as const, content: `${KNOWN} Staging only.` },
      ],
    });
    prepared.memory.addMemory(seed(KNOWN), "L1");

    await prepared.memory.postTurnAsync(TURN);

    // The restatement folded into the survivor, and what it added survived.
    expect(prepared.memory.getSnapshot().l1.map((m) => m.content)).toEqual([
      `${KNOWN} Staging only.`,
    ]);
  });

  it("keeps both statements when no reconciler is supplied", async () => {
    const prepared = await prepareMemory({
      cwd: "/tmp/nah-no-reconcile-project",
      persist: false,
      extractor: async () => ({ memories: [{ content: "The staging build id is ZQ7X4M2K" }] }),
    });
    prepared.memory.addMemory(seed(KNOWN), "L1");

    await prepared.memory.postTurnAsync(TURN);

    // Only a byte-identical restatement collapses without an adjudicator, so
    // this is the documented floor rather than a defect.
    expect(prepared.memory.getSnapshot().l1).toHaveLength(2);
  });
});

describe("prepareMemory: persistence", () => {
  let home: string;
  let cwd: string;
  let previousHome: string | undefined;
  let previousNoPersist: string | undefined;

  beforeEach(() => {
    previousHome = process.env.HOME;
    previousNoPersist = process.env.NAH_MEMORY_NOPERSIST;
    delete process.env.NAH_MEMORY_NOPERSIST;
    home = mkdtempSync(join(tmpdir(), "nah-home-"));
    cwd = mkdtempSync(join(tmpdir(), "nah-project-"));
    process.env.HOME = home;
  });

  afterEach(() => {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousNoPersist === undefined) delete process.env.NAH_MEMORY_NOPERSIST;
    else process.env.NAH_MEMORY_NOPERSIST = previousNoPersist;
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  });

  it("carries a turn into the next process by default", async () => {
    const first = await prepareMemory({
      cwd,
      extractor: async () => ({ memories: [{ content: KNOWN }] }),
    });
    await first.memory.postTurnAsync(TURN);
    expect(existsSync(memoryFileFor(cwd))).toBe(true);

    const second = await prepareMemory({ cwd });
    expect(second.restored).toBe(true);
    expect(second.memory.getSnapshot().l1.map((m) => m.content)).toEqual([KNOWN]);
  });

  it("touches nothing on disk when NAH_MEMORY_NOPERSIST=1", async () => {
    // The escape hatch has to be a real switch, not a documented intention: it
    // is what someone sets when a project directory should stay untouched.
    process.env.NAH_MEMORY_NOPERSIST = "1";
    const prepared = await prepareMemory({
      cwd,
      extractor: async () => ({ memories: [{ content: KNOWN }] }),
    });
    await prepared.memory.postTurnAsync(TURN);

    // Still learned, just not written: memory works for the life of the process.
    expect(prepared.memory.getSnapshot().l1).toHaveLength(1);
    expect(existsSync(join(home, ".nah"))).toBe(false);
  });

  it("honours persist: false as well", async () => {
    const prepared = await prepareMemory({
      cwd,
      persist: false,
      extractor: async () => ({ memories: [{ content: KNOWN }] }),
    });
    await prepared.memory.postTurnAsync(TURN);

    expect(prepared.memory.getSnapshot().l1).toHaveLength(1);
    expect(existsSync(join(home, ".nah"))).toBe(false);
  });
});
