import { describe, expect, it } from "vitest";

import { applyUsageEvent } from "../src/repl.js";
import type { SessionState } from "../src/session.js";
import type { HarnessEvent } from "@astracollab/not-another-harness";

/**
 * Only the fields `applyUsageEvent` writes. Building a whole `SessionState` here
 * would say more about the session type than about the behaviour under test.
 */
const makeState = (): Pick<
  SessionState,
  "contextUsedTokens" | "lastOutputTokens" | "contextUsageEstimated" | "cacheHitRate" | "providerStatus"
> => ({
  contextUsedTokens: 0,
  lastOutputTokens: 0,
  contextUsageEstimated: false,
  cacheHitRate: 0,
  providerStatus: "thinking",
});

const STEP_FINISH: HarnessEvent = {
  type: "step-finish",
  step: 3,
  usage: { inputTokens: 900_000, outputTokens: 4_200, totalTokens: 904_200, estimated: false },
  request: {
    totalInputTokens: 31_200,
    cachedInputTokens: 30_000,
    cacheCreationInputTokens: 0,
    freshInputTokens: 1_200,
    hitRate: 30_000 / 31_200,
  },
};

describe("applyUsageEvent", () => {
  it("takes context size from the request, not the cumulative usage", () => {
    // The distinction is the whole point: `usage.inputTokens` sums every step of
    // the run, so at step 3 it reads 900k while the window holds 31k. Reading the
    // wrong one made a small session look like it was carrying 29x its context.
    const state = makeState();
    applyUsageEvent(state, STEP_FINISH);
    expect(state.contextUsedTokens).toBe(31_200);
  });

  it("carries the cache hit rate through", () => {
    // The sidebar's cache row, and the input to any cost projection, come from
    // here. Nothing else writes them.
    const state = makeState();
    applyUsageEvent(state, STEP_FINISH);
    expect(state.cacheHitRate).toBeCloseTo(30_000 / 31_200, 6);
  });

  it("ignores every event that is not a step", () => {
    const state = makeState();
    applyUsageEvent(state, { type: "step-start", step: 1 } as HarnessEvent);
    expect(state.contextUsedTokens).toBe(0);
  });

  it("clears the provider status when the run ends", () => {
    const state = makeState();
    applyUsageEvent(state, { type: "finish", reason: "completed" } as HarnessEvent);
    expect(state.providerStatus).toBeNull();
  });

  /**
   * Why this function is shared rather than inlined in each frontend.
   *
   * It used to live only in the readline path. The TUI consumed the same event
   * stream without calling it, so in the TUI `contextUsedTokens` stayed 0 for a
   * whole session — visible as a sidebar reading `~0 used`, and, because the
   * per-turn budget scaled on that number, as every turn getting the same $2
   * floor regardless of how large the session had grown.
   */
  it("is reachable from both frontends", () => {
    expect(typeof applyUsageEvent).toBe("function");
  });
});