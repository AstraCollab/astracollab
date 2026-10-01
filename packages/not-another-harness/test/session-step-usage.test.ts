import { describe, expect, it } from "vitest";
import { mkdtemp, readFile } from "node:fs/promises";
import * as nodePath from "node:path";
import { tmpdir } from "node:os";

import { createJsonlSessionStore, type SessionStepUsage } from "../src/session.js";

const record = (over: Partial<Omit<SessionStepUsage, "at">> = {}): Omit<SessionStepUsage, "at"> => ({
  turn: 1,
  step: 1,
  inputTokens: 1000,
  outputTokens: 120,
  totalTokens: 1120,
  requestTokens: 31_200,
  freshInputTokens: 5200,
  cachedInputTokens: 26_000,
  cacheCreationInputTokens: 0,
  hitRate: 0.83,
  estimated: false,
  ...over,
});

const withStore = async <T>(body: (store: ReturnType<typeof createJsonlSessionStore>, file: string) => Promise<T>): Promise<T> => {
  const dir = await mkdtemp(nodePath.join(tmpdir(), "nah-stepusage-"));
  const file = nodePath.join(dir, "s.jsonl");
  try {
    return await body(createJsonlSessionStore(file), file);
  } finally {
    await mkdtemp(dir);
  }
};

describe("per-step usage records", () => {
  it("round-trips every field, in order", async () => {
    await withStore(async (store) => {
      await store.appendStepUsage(record({ step: 1, requestTokens: 1200, cachedInputTokens: 0, hitRate: 0 }));
      await store.appendStepUsage(record({ step: 2, requestTokens: 31_200, hitRate: 0.83 }));

      const steps = await store.loadStepUsage();
      expect(steps).toHaveLength(2);
      expect(steps[0]).toMatchObject({ turn: 1, step: 1, requestTokens: 1200, totalTokens: 1120 });
      expect(steps[1]).toMatchObject({ step: 2, requestTokens: 31_200, cachedInputTokens: 26_000, hitRate: 0.83 });
      expect(typeof steps[0]!.at).toBe("string");
    });
  });

  it("is not a message, so the transcript and branch walk ignore it", async () => {
    await withStore(async (store, file) => {
      await store.append([{ role: "user", content: "hello" }]);
      await store.appendStepUsage(record());
      await store.append([{ role: "assistant", content: "hi" }]);
      await store.appendStepUsage(record({ step: 2 }));

      // Messages only, in order, unaffected by the interleaved records.
      expect(await store.load()).toEqual([
        { role: "user", content: "hello" },
        { role: "assistant", content: "hi" },
      ]);
      // And a later message still chains to the last real message.
      const lines = (await readFile(file, "utf8")).trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
      const assistant = lines.find((l) => l.kind === "message" && (l.message as { role?: string }).role === "assistant");
      expect(assistant?.parentId).toBe(
        lines.find((l) => l.kind === "message" && (l.message as { role?: string }).role === "user")?.id,
      );
    });
  });

  it("leaves the cumulative usage record alone", async () => {
    await withStore(async (store) => {
      await store.saveUsage({
        turns: 2,
        inputTokens: 226_000,
        outputTokens: 89_640,
        totalTokens: 315_640,
        contextUsedTokens: 31_200,
        contextUsageEstimated: false,
        lastOutputTokens: 400,
      });
      await store.appendStepUsage(record());

      const usage = await store.loadUsage();
      expect(usage.totalTokens).toBe(315_640);
      expect(usage.turns).toBe(2);
      expect((await store.loadStepUsage())).toHaveLength(1);
    });
  });

  it("reads an empty list from a file written before these existed", async () => {
    await withStore(async (store) => {
      await store.append([{ role: "user", content: "old" }]);
      expect(await store.loadStepUsage()).toEqual([]);
    });
  });

  it("carries the fields that explain a surprising total", async () => {
    // The whole reason for the record: 27 steps summing to 553k, of which the
    // largest single request was 36.6k. Without per-step request sizes those
    // two numbers look like a bug rather than a replayed transcript.
    await withStore(async (store) => {
      const steps = Array.from({ length: 27 }, (_, i) =>
        record({ step: i + 1, requestTokens: 2_000 + i * 1_300, totalTokens: 553_500 }),
      );
      for (const step of steps) await store.appendStepUsage(step);
      const loaded = await store.loadStepUsage();
      expect(loaded).toHaveLength(27);
      expect(Math.max(...loaded.map((s) => s.requestTokens))).toBeLessThan(loaded.at(-1)!.totalTokens);
    });
  });
});