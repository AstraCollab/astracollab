import { describe, expect, it } from "vitest";

import { CognitiveMemory } from "not-another-harness";
import { createRecallTool } from "../src/memory-tool.js";

let seq = 0;
const mem = (content: string, domains: string[] = [], tier: "L1" | "L2" | "L3" = "L1") => ({
  id: `m${(seq += 1)}`,
  content,
  bookmark: content.slice(0, 80),
  tier,
  metadata: { domains, createdAt: 1, lastAccessedAt: 1, accessCount: 0 },
});

const seeded = () => {
  seq = 0;
  const m = new CognitiveMemory();
  m.addMemory(mem("The staging build ID is ZQ7X4M2K.", ["deployment"]), "L1");
  m.addMemory(mem("The internal staging host is internal-hbr-2291.pineapple.example.", ["infra"]), "L1");
  m.addMemory(mem("New file names in this repository must use kebab-case.", ["naming"]), "L2");
  m.addMemory(mem("The billing webhook signs requests with KX99QQ.", ["payments"]), "L3");
  return m;
};

const ask = async (memory: CognitiveMemory | undefined, input: unknown): Promise<string> =>
  await createRecallTool(() => memory).execute(input as never, {});

describe("memory search", () => {
  it("ranks the relevant memory first regardless of tier", () => {
    const results = seeded().search("what is the staging build id");
    expect(results[0]!.item.content).toContain("ZQ7X4M2K");
    expect(results.some((r) => r.item.content.includes("KX99QQ"))).toBe(false);
  });

  it("finds a fact that was only ever demoted to L2 or L3", () => {
    const m = seeded();
    expect(m.search("file naming convention")[0]!.item.content).toContain("kebab-case");
    expect(m.search("billing webhook signing key")[0]!.item.content).toContain("KX99QQ");
  });

  it("returns nothing for an unrelated or empty query", () => {
    const m = seeded();
    expect(m.search("kubernetes ingress")).toEqual([]);
    expect(m.search("")).toEqual([]);
    expect(m.search("the")).toEqual([]);
  });

  it("collapses paraphrases rather than returning both", () => {
    const m = new CognitiveMemory();
    m.addMemory(mem("The staging build ID is ZQ7X4M2K."), "L1");
    m.addMemory(mem("The staging build ID ZQ7X4M2K must be treated as user-provided."), "L1");
    const results = m.search("staging build id");
    expect(results).toHaveLength(1);
  });

  it("honours the limit", () => {
    const m = seeded();
    expect(m.search("staging", 1)).toHaveLength(1);
  });
});

describe("recall tool", () => {
  it("returns the matching memory as text the model can use", async () => {
    const out = await ask(seeded(), { query: "staging build id" });
    expect(out).toContain("ZQ7X4M2K");
    expect(out).toContain("Remembered");
    // It must not drag in unrelated facts.
    expect(out).not.toContain("KX99QQ");
  });

  it("tells the model to admit ignorance instead of guessing", async () => {
    const out = await ask(seeded(), { query: "kubernetes ingress controller" });
    expect(out).toContain("No stored memory matches");
    expect(out).toMatch(/say so rather than guessing/i);
  });

  it("degrades cleanly when no memory is configured", async () => {
    expect(await ask(undefined, { query: "anything" })).toContain("No memory is available");
  });

  it("is not approval-gated (it only reads)", () => {
    // `recall` is absent from the mutation gate set.
    const { APPROVAL_GATED_TOOLS } = require("not-another-harness") as {
      APPROVAL_GATED_TOOLS: Set<string>;
    };
    expect(APPROVAL_GATED_TOOLS.has("recall")).toBe(false);
  });
});
