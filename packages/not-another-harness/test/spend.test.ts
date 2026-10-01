import { describe, expect, it } from "vitest";

import { createSpendMeter, usageCostUsd } from "../src/spend.js";

/**
 * Prices chosen to make the arithmetic obvious: $3/M input, $15/M output — the
 * published Sonnet figures. Cache multipliers are the documented defaults.
 */
const RATES = { input: 3, output: 15 };

describe("usageCostUsd", () => {
  it("prices fresh input at the base rate", () => {
    expect(usageCostUsd({ inputTokens: 1_000_000, outputTokens: 0 }, RATES)).toBeCloseTo(3, 10);
  });

  it("prices output at the output rate", () => {
    expect(usageCostUsd({ inputTokens: 0, outputTokens: 1_000_000 }, RATES)).toBeCloseTo(15, 10);
  });

  it("charges a cache read at a tenth of fresh input by default", () => {
    const cached = usageCostUsd(
      { inputTokens: 0, outputTokens: 0, cachedInputTokens: 1_000_000 },
      RATES,
    );
    expect(cached).toBeCloseTo(0.3, 10);
  });

  it("charges a cache write at 1.25x fresh input by default", () => {
    const written = usageCostUsd(
      { inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 1_000_000 },
      RATES,
    );
    expect(written).toBeCloseTo(3.75, 10);
  });

  it("honours explicit cache rates over the defaults", () => {
    // The 1h write multiplier is 2x, not 1.25x, so a caller choosing a 1h TTL
    // must be able to say so.
    const rates = { ...RATES, cacheWrite: 6, cacheRead: 0.15 };
    expect(
      usageCostUsd({ inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 1_000_000 }, rates),
    ).toBeCloseTo(6, 10);
    expect(
      usageCostUsd({ inputTokens: 0, outputTokens: 0, cachedInputTokens: 1_000_000 }, rates),
    ).toBeCloseTo(0.15, 10);
  });

  it("makes a fully cached run cost about a tenth of an uncached one", () => {
    // This is the whole reason spend is denominated in dollars. Counting raw
    // tokens charges these two runs identically, which is what turned the old
    // token budget into a step counter: it fired on cache efficiency rather than
    // on money actually spent.
    const uncached = usageCostUsd({ inputTokens: 100_000, outputTokens: 0 }, RATES);
    const cached = usageCostUsd(
      { inputTokens: 0, outputTokens: 0, cachedInputTokens: 100_000 },
      RATES,
    );
    expect(cached / uncached).toBeCloseTo(0.1, 2);
  });

  it("treats absent cache fields as zero rather than NaN", () => {
    expect(usageCostUsd({ inputTokens: 1000, outputTokens: 1000 }, RATES)).toBeCloseTo(
      (1000 / 1e6) * 3 + (1000 / 1e6) * 15,
      10,
    );
  });
});

describe("createSpendMeter", () => {
  it("accumulates across requests", () => {
    const meter = createSpendMeter(RATES);
    expect(meter.total()).toBe(0);
    meter.charge({ inputTokens: 1_000_000, outputTokens: 0 });
    expect(meter.total()).toBeCloseTo(3, 10);
    meter.charge({ inputTokens: 1_000_000, outputTokens: 0 });
    expect(meter.total()).toBeCloseTo(6, 10);
  });

  it("returns the running total from charge so callers need not track it", () => {
    const meter = createSpendMeter(RATES);
    meter.charge({ inputTokens: 1_000_000, outputTokens: 0 });
    expect(meter.charge({ inputTokens: 500_000, outputTokens: 0 })).toBeCloseTo(4.5, 10);
  });
});
