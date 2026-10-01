import { describe, expect, it } from "vitest";

import { defaultTurnSpendUsd, formatUsd, projectStepCostUsd, resolveTurnSpendUsd } from "../src/budget.js";

const RATES = { input: 3, output: 15 };

describe("defaultTurnSpendUsd", () => {
  it("gives a fresh session a floor, not the old flat ceiling", () => {
    // Two read-only "explain this codebase" runs cost $0.11 and $0.15 against the
    // old $5. A rail that never binds is decoration, not a safety net.
    expect(defaultTurnSpendUsd(0)).toBeLessThan(5);
    expect(defaultTurnSpendUsd(2_000)).toBeLessThan(5);
  });

  it("still leaves room for a real turn on an empty session", () => {
    // The floor must cover a genuine 32-step turn that grows its context: roughly
    // 1.4M cumulative input plus output lands near $1, so $2 has headroom.
    expect(defaultTurnSpendUsd(0)).toBeGreaterThanOrEqual(2);
  });

  it("grows with the transcript, which is what actually drives cost", () => {
    // Every step re-sends the transcript, so a turn resuming a large one pays
    // more per step for identical work. A flat number got this backwards.
    expect(defaultTurnSpendUsd(150_000)).toBeGreaterThan(defaultTurnSpendUsd(20_000));
  });

  it("reaches the historical ceiling at a full window", () => {
    expect(defaultTurnSpendUsd(180_000)).toBeCloseTo(5, 6);
    // And never exceeds it, however much context is carried.
    expect(defaultTurnSpendUsd(1_000_000)).toBe(5);
  });

  it("is monotonic across the whole range", () => {
    let previous = 0;
    for (const context of [0, 10_000, 50_000, 100_000, 180_000, 500_000]) {
      const value = defaultTurnSpendUsd(context);
      expect(value).toBeGreaterThanOrEqual(previous);
      previous = value;
    }
  });

  it("treats a negative context as empty rather than shrinking the floor", () => {
    expect(defaultTurnSpendUsd(-5_000)).toBe(defaultTurnSpendUsd(0));
  });
});

describe("resolveTurnSpendUsd", () => {
  it("prefers an explicit override over the scaled default", () => {
    expect(resolveTurnSpendUsd(0, 25, {})).toBe(25);
  });

  it("still honours the env var for existing setups", () => {
    expect(resolveTurnSpendUsd(0, null, { NAH_TURN_SPEND_USD: "8" })).toBe(8);
  });

  it("falls back to scaling when neither is set", () => {
    expect(resolveTurnSpendUsd(100_000, null, {})).toBe(defaultTurnSpendUsd(100_000));
  });

  it("ignores a nonsense override rather than disabling the rail", () => {
    // Falling through to 0 here would remove the safety net entirely, which is
    // the opposite of what "set it to nothing" should mean.
    for (const bad of [0, -3, Number.NaN]) {
      expect(resolveTurnSpendUsd(0, bad, {})).toBe(defaultTurnSpendUsd(0));
    }
    expect(resolveTurnSpendUsd(0, null, { NAH_TURN_SPEND_USD: "abc" })).toBe(defaultTurnSpendUsd(0));
    expect(resolveTurnSpendUsd(0, null, { NAH_TURN_SPEND_USD: "-1" })).toBe(defaultTurnSpendUsd(0));
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
    // A turn that costs $0.082 must not render as "$0" next to a $2 rail.
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
