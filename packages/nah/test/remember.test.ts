import { describe, expect, it } from "vitest";

import { CognitiveMemory } from "not-another-harness";
import { localMemory, type SessionMemory } from "../src/memory-backend.js";
import { createRememberTool } from "../src/memory-tool.js";

/** A write counter, standing in for the SQLite save. */
const persisting = () => {
  let saves = 0;
  return {
    flush: () => {
      saves += 1;
      return Promise.resolve();
    },
    get saves() {
      return saves;
    },
  };
};

const backend = (over: { flush?: () => Promise<void> } = {}) => {
  const memory = new CognitiveMemory();
  return {
    memory,
    session: localMemory({ memory, location: ":memory:", ...over }),
  };
};

const remember = async (session: SessionMemory, input: unknown): Promise<string> =>
  await createRememberTool(() => session).execute(input as never, {});

describe("removing a memory from the engine", () => {
  it("drops an id from whichever tier is holding it", () => {
    const memory = new CognitiveMemory();
    const item = (id: string, tier: "L1" | "L2" | "L3") => ({
      id,
      content: `the ${id} record is QX7${id}`,
      bookmark: `the ${id} record is QX7${id}`,
      tier,
      metadata: { domains: [], createdAt: 1, lastAccessedAt: 1, accessCount: 0 },
    });
    memory.addMemory(item("hot", "L1"), "L1");
    memory.addMemory(item("warm", "L2"), "L2");
    memory.addMemory(item("cold", "L3"), "L3");
    const held = (tier: "l1" | "l2" | "l3") => memory.getSnapshot()[tier].map((entry) => entry.id);

    expect(held("l1")).toEqual(["hot"]);
    expect(held("l2")).toEqual(["warm"]);
    expect(held("l3")).toEqual(["cold"]);

    // A demoted or promoted id may be in any of the three, so one lookup is not
    // enough to be sure it is gone.
    expect(memory.removeMemory("warm")).toBe(true);
    expect(memory.removeMemory("hot")).toBe(true);
    expect(memory.removeMemory("cold")).toBe(true);

    expect(held("l1")).toEqual([]);
    expect(held("l2")).toEqual([]);
    expect(held("l3")).toEqual([]);
  });

  it("says no when nothing held that id", () => {
    expect(new CognitiveMemory().removeMemory("mem-never-existed")).toBe(false);
  });
});

describe("writing to the local backend", () => {
  it("stores a stated fact so the next turn recalls it", async () => {
    const { memory, session } = backend();

    const result = await session.remember({ content: "  we deploy on netlify  ", domains: ["deployment"] });

    expect(result.stored).toHaveLength(1);
    expect(result.merged).toBe(false);
    // Trimmed on the way in, and findable immediately — a write the engine held
    // but could not find would be indistinguishable from a lost one.
    expect(memory.search("what do we deploy on")[0]!.item.content).toBe("we deploy on netlify");
  });

  it("puts an unstated tier's default in L1, so it is pre-staged", async () => {
    const { memory, session } = backend();

    await session.remember({ content: "File names are kebab-case." });

    expect(memory.getSnapshot().l1.map((item) => item.content)).toContain("File names are kebab-case.");
  });

  it("honours an explicit tier", async () => {
    const { memory, session } = backend();

    await session.remember({ content: "The billing key is KX99QQ.", tier: "L3" });

    expect(memory.getSnapshot().l3.map((item) => item.content)).toContain("The billing key is KX99QQ.");
  });

  it("folds a restatement instead of holding it twice", async () => {
    const { memory, session } = backend();
    await session.remember({ content: "we deploy on netlify" });

    const again = await session.remember({ content: "We deploy on Netlify." });

    expect(again.merged).toBe(true);
    expect(again.stored).toHaveLength(1);
    expect(memory.search("we deploy on netlify")).toHaveLength(1);
  });

  it("persists immediately rather than waiting for the next turn", async () => {
    const store = persisting();
    const { session } = backend({ flush: store.flush });

    await session.remember({ content: "the staging host is hbr-2291" });
    expect(store.saves).toBe(1);

    await session.forget("mem-does-not-exist");
    // Nothing was held, so there is nothing new to write.
    expect(store.saves).toBe(1);
  });

  it("retires a fact that is now wrong", async () => {
    const { memory, session } = backend();
    const { stored } = await session.remember({ content: "we deploy on vercel" });

    expect(await session.forget(stored[0]!)).toBe(true);
    expect(memory.search("we deploy on vercel")).toEqual([]);
    expect(await session.forget(stored[0]!)).toBe(false);
  });
});

describe("the remember tool", () => {
  it("says what it stored, in the user's words", async () => {
    const { session } = backend();

    const text = await remember(session, { content: "we deploy on netlify", domains: ["deployment"] });

    expect(text).toContain("Stored as mem-");
    expect(text).toContain("we deploy on netlify");
  });

  it("retires what the new fact replaces", async () => {
    const { memory, session } = backend();
    const stale = (await session.remember({ content: "we deploy on vercel and fly" })).stored[0]!;

    const text = await remember(session, { content: "we deploy on netlify", replaces: [stale] });

    expect(text).toContain(`Retired 1 memory id(s): ${stale}`);
    expect(memory.search("vercel and fly")).toEqual([]);
  });

  it("names an id it could not retire instead of implying it did", async () => {
    const { session } = backend();

    const text = await remember(session, { content: "we deploy on netlify", replaces: ["mem-gone"] });

    expect(text).toContain("mem-gone");
    expect(text).toContain("nothing to retire");
    // The new fact is still written: a stale id is not a reason to drop it.
    expect(text).toContain("Stored as mem-");
  });

  it("reports a refused write rather than claiming it saved", async () => {
    // A backend that absorbed a failure, which is what both implementations do.
    const failing = {
      degraded: "the key lacks the memories:write scope (403)",
      remember: () => Promise.resolve({ stored: [], merged: false }),
      forget: () => Promise.resolve(false),
    } as unknown as SessionMemory;

    const text = await remember(failing, { content: "we deploy on netlify" });

    expect(text).toContain("NOT stored");
    expect(text).toContain("memories:write");
    expect(text).not.toContain("Stored as");
  });

  it("says so when the session has no memory at all", async () => {
    expect(await remember(undefined as unknown as SessionMemory, { content: "we deploy on netlify" })).toBe(
      "No memory is available in this session.",
    );
  });
});
