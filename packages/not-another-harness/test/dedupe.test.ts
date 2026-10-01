import { describe, expect, it } from "vitest";

import { createStepDedupe } from "../src/dedupe.js";

const counter = () => {
  let n = 0;
  return {
    execute: async () => `run ${(n += 1)}`,
    get calls() {
      return n;
    },
  };
};

const wrap = (tool: { execute: (i: unknown, c: unknown) => Promise<unknown> }) => {
  const dedupe = createStepDedupe({ probe: tool as never });
  return { dedupe, ctx: {} };
};

describe("per-step tool de-duplication", () => {
  it("runs an identical call once and replays the result", async () => {
    const tool = counter();
    const { dedupe, ctx } = wrap(tool);
    dedupe.beginStep();

    expect(await dedupe.tools.probe!.execute!({ command: "ls" }, ctx)).toBe("run 1");
    expect(await dedupe.tools.probe!.execute!({ command: "ls" }, ctx)).toBe("run 1");
    expect(tool.calls).toBe(1);
    expect(dedupe.skipped).toBe(1);
  });

  it("does not collapse calls with different input", async () => {
    const tool = counter();
    const { dedupe, ctx } = wrap(tool);
    dedupe.beginStep();

    await dedupe.tools.probe!.execute!({ command: "ls" }, ctx);
    await dedupe.tools.probe!.execute!({ command: "cat x" }, ctx);
    expect(tool.calls).toBe(2);
  });

  it("allows a re-run in a later step, since state may have changed", async () => {
    const tool = counter();
    const { dedupe, ctx } = wrap(tool);

    dedupe.beginStep();
    await dedupe.tools.probe!.execute!({ command: "ls" }, ctx);
    dedupe.beginStep();
    await dedupe.tools.probe!.execute!({ command: "ls" }, ctx);

    expect(tool.calls).toBe(2);
  });

  it("distinguishes different tools with identical input", async () => {
    let a = 0;
    let b = 0;
    const dedupe = createStepDedupe({
      one: { execute: async () => `a${(a += 1)}` },
      two: { execute: async () => `b${(b += 1)}` },
    } as never);
    dedupe.beginStep();

    expect(await dedupe.tools.one!.execute!({ x: 1 }, {})).toBe("a1");
    expect(await dedupe.tools.two!.execute!({ x: 1 }, {})).toBe("b1");
  });

  it("leaves non-executable tools alone", () => {
    const dedupe = createStepDedupe({ meta: { description: "not executable" } } as never);
    expect(dedupe.tools.meta).toEqual({ description: "not executable" });
  });

  it("does not collapse calls whose input cannot be serialised", async () => {
    let calls = 0;
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const dedupe = createStepDedupe({
      probe: {
        execute: async () => {
          calls += 1;
          return `run ${calls}`;
        },
      },
    } as never);
    dedupe.beginStep();

    await dedupe.tools.probe!.execute!(cyclic, {});
    await dedupe.tools.probe!.execute!(cyclic, {});
    expect(calls).toBe(2);
  });
});