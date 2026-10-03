import { describe, expect, it } from "vitest";

import { lookupRates, ratesFor } from "../src/rates.js";

describe("ratesFor", () => {
  it("prices Sonnet 4.x at its published rates", () => {
    const rates = ratesFor("claude-sonnet-4-5", {});
    expect(rates?.input).toBe(3);
    expect(rates?.output).toBe(15);
    // 1h cache write is 2x base input, not the 1.25x of a 5m write.
    expect(rates?.cacheWrite).toBe(6);
    expect(rates?.cacheRead).toBe(0.3);
  });

  it("prices Opus above Sonnet", () => {
    expect(ratesFor("claude-opus-4-5", {})?.output).toBeGreaterThan(ratesFor("claude-sonnet-4-5", {})?.output ?? 0);
  });

  it("returns null for an unknown model rather than inventing a price", () => {
    // The old fallback charged a free route at Sonnet's rates, so /stats printed
    // money for a model the user pays nothing for. No figure is the honest one:
    // the caller can say "not tracked", but it cannot say "not free" and be
    // believed.
    expect(ratesFor("some-unreleased-model", {})).toBeNull();
  });

  it("lets NAH_RATES override the table so a price change needs no release", () => {
    const env = { NAH_RATES: JSON.stringify({ input: 11, output: 22 }) };
    const rates = ratesFor("claude-sonnet-4-5", env);
    expect(rates?.input).toBe(11);
    expect(rates?.output).toBe(22);
    // Unspecified fields take multipliers off the supplied rate, not a default
    // table that would contradict the number next to them.
    expect(rates?.cacheRead).toBeCloseTo(1.1, 6);
    expect(rates?.cacheWrite).toBeCloseTo(22, 6);
  });

  it("treats an explicit zero override as a free model, caches included", () => {
    const env = { NAH_RATES: '{"input":0,"output":0}' };
    const rates = ratesFor("stealth/space-bunny-alpha", env);
    expect(rates).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  });

  it("ignores a malformed override instead of failing startup", () => {
    expect(ratesFor("claude-sonnet-4-5", { NAH_RATES: "not json" })?.input).toBe(3);
    expect(ratesFor("claude-sonnet-4-5", { NAH_RATES: '{"input":"free"}' })?.input).toBe(3);
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

  it("marks an unrecognised model as unknown, with no rates at all", () => {
    // `gpt-5` and `stealth/space-bunny-alpha` both land here. Presenting these
    // as a real price is what made /stats show money for a free route, so the
    // lookup reports the absence of a measurement instead of a stand-in.
    for (const id of ["gpt-5", "stealth/space-bunny-alpha", "some-unreleased-model"]) {
      const lookup = lookupRates(id, {});
      expect(lookup.source).toBe("unknown");
      expect(lookup.rates).toBeNull();
    }
  });

  it("distinguishes a free model from an unpriced one", () => {
    // Both show zero spend, and a UI that cannot tell them apart will call a
    // free route untracked and an unpriced route free.
    expect(lookupRates("gpt-5", { NAH_RATES: '{"input":0,"output":0}' }).source).toBe("free");
    expect(lookupRates("gpt-5", {}).source).toBe("unknown");
  });
});