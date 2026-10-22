import { describe, expect, it } from "vitest";

import { providerTokenTotals, type SessionState } from "../src/session.js";

const state = (over: Partial<SessionState>): SessionState =>
  ({
    totalUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    ...over,
  }) as unknown as SessionState;

describe("providerTokenTotals", () => {
  it("counts the prompt the way the provider does — cached tokens included", () => {
    // The harness reports only the uncached remainder of a prompt, because that
    // is the part billed at the full rate. A panel built on that figure
    // under-reports every request by the size of its cache, which is what made
    // the sidebar disagree with the provider's own dashboard.
    const totals = providerTokenTotals(
      state({
        totalUsage: { inputTokens: 84_200, outputTokens: 3_100, totalTokens: 87_300 },
        cacheReadTokens: 184_000,
        cacheWriteTokens: 40_000,
      }),
    );
    expect(totals.promptTokens).toBe(308_200);
    expect(totals.freshInputTokens).toBe(84_200);
    expect(totals.outputTokens).toBe(3_100);
    expect(totals.totalTokens).toBe(311_300);
  });

  it("counts a run with no cache as the whole prompt", () => {
    const totals = providerTokenTotals(
      state({ totalUsage: { inputTokens: 1_200, outputTokens: 300, totalTokens: 1_500 } }),
    );
    expect(totals.promptTokens).toBe(1_200);
    expect(totals.totalTokens).toBe(1_500);
  });

  it("reads missing counters as zero rather than NaN", () => {
    // The counters come off disk, and a session file written before a field
    // existed must not turn every figure into NaN.
    const totals = providerTokenTotals(
      state({ totalUsage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } }),
    );
    expect(totals.promptTokens).toBe(10);
    expect(totals.totalTokens).toBe(15);
  });
});
