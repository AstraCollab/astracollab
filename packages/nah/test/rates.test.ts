import { describe, expect, it } from "vitest";

import { lookupRates, ratesFor } from "../src/rates.js";

describe("ratesFor", () => {
  it("prices Sonnet 4.x at its published rates", () => {
    const rates = ratesFor("claude-sonnet-4-5", {});
    expect(rates.input).toBe(3);
    expect(rates.output).toBe(15);
    // 1h cache write is 2x base input, not the 1.25x of a 5m write.
    expect(rates.cacheWrite).toBe(6);
    expect(rates.cacheRead).toBe(0.3);
  });

  it("prices Opus above Sonnet", () => {
    expect(ratesFor("claude-opus-4-5", {}).output).toBeGreaterThan(ratesFor("claude-sonnet-4-5", {}).output);
  });

  it("falls back for an unknown model rather than returning nothing", () => {
    // A missing rate would disable the spend rail silently, which is the one
    // outcome worse than an imprecise one.
    const rates = ratesFor("some-unreleased-model", {});
    expect(rates.input).toBeGreaterThan(0);
    expect(rates.output).toBeGreaterThan(0);
  });

  it("lets NAH_RATES override the table so a price change needs no release", () => {
    const env = { NAH_RATES: JSON.stringify({ input: 11, output: 22 }) };
    const rates = ratesFor("claude-sonnet-4-5", env);
    expect(rates.input).toBe(11);
    expect(rates.output).toBe(22);
    // Unspecified fields keep the default multipliers rather than becoming NaN.
    expect(rates.cacheRead).toBeGreaterThan(0);
    expect(rates.cacheWrite).toBeGreaterThan(0);
  });

  it("ignores a malformed override instead of failing startup", () => {
    expect(ratesFor("claude-sonnet-4-5", { NAH_RATES: "not json" }).input).toBe(3);
    expect(ratesFor("claude-sonnet-4-5", { NAH_RATES: '{"input":"free"}' }).input).toBe(3);
  });
});

describe("lookupRates provenance", () => {
  it("marks table matches as measured", () => {
    expect(lookupRates("claude-sonnet-4-5", {}).source).toBe("table");
  });

  it("marks an env override as measured", () => {
    const env = { NAH_RATES: '{"input":1,"output":2}' };
    expect(lookupRates("anything", env).source).toBe("env");
  });

  it("marks an unrecognised model as assumed, not measured", () => {
    // `gpt-5` and `stealth/space-bunny-alpha` both land here. Presenting these
    // as a real price is what made /stats show money for a free route.
    for (const id of ["gpt-5", "stealth/space-bunny-alpha", "some-unreleased-model"]) {
      expect(lookupRates(id, {}).source).toBe("assumed");
    }
  });

  it("still returns numbers, so an in-flight caller keeps working", () => {
    expect(typeof ratesFor("stealth/space-bunny-alpha", {}).input).toBe("number");
  });
});
