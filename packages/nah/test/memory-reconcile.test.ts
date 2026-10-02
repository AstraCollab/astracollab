import { describe, expect, it } from "vitest";
import { MockLanguageModelV4 } from "ai/test";

import { createMemoryReconciler, parseReconciliation } from "../src/memory.js";
import { finishReason, v4Usage } from "./helpers/ai.js";

const USAGE = v4Usage({ input: 10, output: 5 });

const textModel = (text: string) =>
  new MockLanguageModelV4({
    doGenerate: async () => ({
      content: [{ type: "text" as const, text }],
      finishReason: finishReason("stop"),
      usage: USAGE,
      warnings: [],
    }),
  });

/** The bug this suite exists for: a model with no structured-output support. */
const textOnlyModelThatRejectsSchemas = (text: string) =>
  new MockLanguageModelV4({
    doGenerate: async (options) => {
      if (options.responseFormat?.type === "json") {
        throw new Error("AI_NoObjectGeneratedError: no object generated");
      }
      return {
        content: [{ type: "text" as const, text }],
        finishReason: finishReason("stop"),
        usage: USAGE,
        warnings: [],
      };
    },
  });

describe("parseReconciliation", () => {
  it("reads the requested {verdicts:[...]} shape", () => {
    const out = parseReconciliation(
      '{"verdicts":[{"index":0,"action":"merge","content":"User prefers kebab-case file names."},{"index":1,"action":"add"}]}',
      2,
    );
    expect(out).toEqual([
      { action: "merge", content: "User prefers kebab-case file names." },
      { action: "add" },
    ]);
  });

  it("reads a bare array, dropping the wrapper", () => {
    const out = parseReconciliation('[{"index":1,"action":"reject"}]', 2);
    expect(out[0]).toEqual({ action: "add" });
    expect(out[1]).toEqual({ action: "reject" });
  });

  it("reads a lone verdict answered without the wrapper", () => {
    const out = parseReconciliation('{"index":0,"action":"replace","content":"Staging is us-east."}', 1);
    expect(out).toEqual([{ action: "replace", content: "Staging is us-east." }]);
  });

  it("survives prose around the JSON and code fences", () => {
    expect(parseReconciliation('Here you go:\n```json\n{"verdicts":[{"index":0,"action":"merge"}]}\n```\nHope that helps!', 1)).toEqual([
      { action: "merge" },
    ]);
  });

  it("keeps a brace inside a remembered statement from truncating the reply", () => {
    const out = parseReconciliation(
      '{"verdicts":[{"index":0,"action":"merge","content":"Build tag is {staging:1} for the API."},{"index":1,"action":"reject"}]}',
      2,
    );
    expect(out[0].content).toBe("Build tag is {staging:1} for the API.");
    expect(out[1]).toEqual({ action: "reject" });
  });

  it("takes index as a numeric string, and falls back to order when absent", () => {
    expect(parseReconciliation('{"verdicts":[{"index":"1","action":"reject"}]}', 2)[1]).toEqual({
      action: "reject",
    });
    expect(parseReconciliation('{"verdicts":[{"action":"reject"},{"action":"merge"}]}', 2)).toEqual([
      { action: "reject" },
      { action: "merge" },
    ]);
  });

  it("defaults anything missing, unknown or out of range to add", () => {
    // No verdict for index 1, unknown action, out-of-range index.
    const out = parseReconciliation(
      '{"verdicts":[{"index":0,"action":"merge"},{"index":1,"action":"explode"},{"index":9,"action":"reject"}]}',
      2,
    );
    expect(out).toEqual([{ action: "merge" }, { action: "add" }]);
  });

  it("keeps every candidate when the reply is unusable", () => {
    for (const reply of ["", "I cannot help with that.", '{"verdicts":[{"index":0,', "not json at all"]) {
      expect(parseReconciliation(reply, 2)).toEqual([{ action: "add" }, { action: "add" }]);
    }
  });

  it("returns nothing to adjudicate for an empty batch", () => {
    expect(parseReconciliation("{}", 0)).toEqual([]);
  });
});

describe("createMemoryReconciler", () => {
  const items = [
    { candidate: "User prefers kebab-case.", remember: ["User prefers kebab-case."] },
    { candidate: "The staging build ID is ZQ7X4M2K.", remember: ["Staging build ID is ZQ7X4M2K."] },
  ];

  it("adjudicates on a model that rejects structured output", async () => {
    // This is the regression guard. The reconciler used `generateObject`, which
    // sends a responseFormat; on a model without structured output it threw and
    // every candidate fell back to "add", so dedup never ran.
    const reconcile = createMemoryReconciler(
      textOnlyModelThatRejectsSchemas(
        '{"verdicts":[{"index":0,"action":"merge","content":"User prefers kebab-case names."},{"index":1,"action":"add"}]}',
      ),
    );

    expect(await reconcile({ items })).toEqual([
      { action: "merge", content: "User prefers kebab-case names." },
      { action: "add" },
    ]);
  });

  it("judges every candidate in the turn with one call", async () => {
    let calls = 0;
    const reconcile = createMemoryReconciler(
      new MockLanguageModelV4({
        doGenerate: async () => {
          calls += 1;
          return {
            content: [
              { type: "text" as const, text: '{"verdicts":[{"index":0,"action":"merge"}]}' },
            ],
            finishReason: finishReason("stop"),
            usage: USAGE,
            warnings: [],
          };
        },
      }),
    );

    await reconcile({ items });
    expect(calls).toBe(1);
  });

  it("keeps everything when the model errors", async () => {
    const reconcile = createMemoryReconciler(
      new MockLanguageModelV4({
        doGenerate: async () => {
          throw new Error("rate limited");
        },
      }),
    );
    expect(await reconcile({ items })).toEqual([{ action: "add" }, { action: "add" }]);
  });

  it("does not call the model for an empty batch", async () => {
    let calls = 0;
    const reconcile = createMemoryReconciler(
      new MockLanguageModelV4({
        doGenerate: async () => {
          calls += 1;
          return { content: [], finishReason: finishReason("stop"), usage: USAGE, warnings: [] };
        },
      }),
    );
    expect(await reconcile({ items: [] })).toEqual([]);
    expect(calls).toBe(0);
  });
});