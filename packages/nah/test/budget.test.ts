import { describe, expect, it } from "vitest";

import { formatUsd, projectStepCostUsd, resolveTurnSpendUsd } from "../src/budget.js";

const RATES = { input: 3, output: 15 };

describe("resolveTurnSpendUsd", () => {
  it("is zero by default, so a turn has no ceiling", () => {
    // This is the fix. A run stopped at `$1.99 / $2.00` on every turn, mid-task,
    // with the work unfinished — a ceiling inside the cost of doing the job.
    // Long-running agents run until the task is done, the window is full, or a
    // human interrupts.
    expect(resolveTurnSpendUsd(null, {})).toBe(0);
    expect(resolveTurnSpendUsd(undefined, {})).toBe(0);
  });

  it("does not scale with context any more", () => {
    // It did, and it was the right idea on the wrong signal: the turn's starting
    // context, which nothing ever wrote. contextUsedTokens sat at 0 for every
    // turn in a real session, so the $2 floor was the only number that ever
    // applied — a fresh session and a 3.9M-token session got the same budget.
    expect(resolveTurnSpendUsd(null, {})).toBe(0);
  });

  it("honours an explicit ceiling when the user asks for one", () => {
    expect(resolveTurnSpendUsd(25, {})).toBe(25);
  });

  it("still honours the env var for existing setups", () => {
    expect(resolveTurnSpendUsd(null, { NAH_TURN_SPEND_USD: "8" })).toBe(8);
  });

  it("prefers the explicit value over the env var", () => {
    expect(resolveTurnSpendUsd(3, { NAH_TURN_SPEND_USD: "8" })).toBe(3);
  });

  it("treats a nonsense ceiling as none rather than inventing one", () => {
    // Guessing a fallback here would reintroduce exactly the automatic ceiling
    // this removed, so a bad value means no ceiling and nothing says otherwise.
    for (const bad of [0, -3, Number.NaN]) {
      expect(resolveTurnSpendUsd(bad, {})).toBe(0);
    }
    expect(resolveTurnSpendUsd(null, { NAH_TURN_SPEND_USD: "abc" })).toBe(0);
    expect(resolveTurnSpendUsd(null, { NAH_TURN_SPEND_USD: "-1" })).toBe(0);
  });
});

describe("projectStepCostUsd", () => {
  it("prices a fully cached step about 10x below an uncached one", () => {
    // This is the whole argument for watching the hit rate: the same step, at the
    // same context size, differs by an order of magnitude.
    const cached = projectStepCostUsd(50_000, 1, RATES);
    const uncached = projectStepCostUsd(50_000, 0, RATES);
    expect(uncached / cached).toBeGreaterThan(5);
  });

  it("clamps a rate outside 0..1 instead of projecting a negative cost", () => {
    expect(projectStepCostUsd(50_000, 2, RATES)).toBeCloseTo(projectStepCostUsd(50_000, 1, RATES), 10);
    expect(projectStepCostUsd(50_000, -1, RATES)).toBeCloseTo(projectStepCostUsd(50_000, 0, RATES), 10);
  });

  it("includes output, which dominates at short context", () => {
    const withOutput = projectStepCostUsd(1_000, 1, RATES, 10_000);
    expect(withOutput).toBeGreaterThan(projectStepCostUsd(1_000, 1, RATES, 0));
  });
});

describe("formatUsd", () => {
  it("keeps enough precision at small spend", () => {
    // A turn that costs $0.082 must not render as "$0" next to a two-digit figure.
    expect(formatUsd(0.0824)).toBe("$0.082");
    expect(formatUsd(2)).toBe("$2.00");
    expect(formatUsd(12.4)).toBe("$12");
  });

  it("reads a missing figure as zero rather than throwing", () => {
    // Called from the sidebar's per-frame render; a NaN there would take the
    // terminal down over a cosmetic value.
    expect(formatUsd(Number.NaN)).toBe("$0");
    expect(formatUsd(undefined as unknown as number)).toBe("$0");
  });
});
