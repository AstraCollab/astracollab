import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";

import { handleSlashCommand } from "../src/repl.js";
import { SLASH_COMMANDS } from "../src/commands.js";
import type { SessionState } from "../src/session.js";

/**
 * The step ceiling is unset unless asked for, and there is no way to set one
 * other than asking. Both halves matter: a default nobody chose is what cut a
 * working merge at 32 steps, and an unset option with no knob is the other half
 * of the same problem.
 */
const state = (over: Partial<SessionState> = {}): SessionState =>
  ({
    turnSpendLimitUsd: null,
    turnStepLimit: null,
    model: null,
    messages: [],
    ...over,
  }) as unknown as SessionState;

const run = async (line: string, s: SessionState = state()) => {
  const output: string[] = [];
  const stream = new Writable({
    write(chunk, _encoding, done) {
      output.push(String(chunk));
      done();
    },
  });
  await handleSlashCommand(line, s, ".", stream);
  return { s, text: output.join("") };
};

describe("/steps", () => {
  it("reports that there is no ceiling, by default", async () => {
    const { text } = await run("/steps");
    expect(text).toContain("no per-turn step ceiling");
  });

  it("sets a ceiling when given a number", async () => {
    const { s, text } = await run("/steps 100");
    expect(s.turnStepLimit).toBe(100);
    expect(text).toContain("100 steps");
  });

  it("removes the ceiling again", async () => {
    const { s, text } = await run("/steps off", state({ turnStepLimit: 100 }));
    expect(s.turnStepLimit).toBeNull();
    expect(text).toContain("no per-turn step ceiling");
  });

  it("shows the current value when asked without an argument", async () => {
    const { text } = await run("/steps", state({ turnStepLimit: 64 }));
    expect(text).toContain("64 step ceiling");
  });

  it("refuses nonsense rather than silently disabling the cap", async () => {
    // Falling through to "no limit" on a typo would be the worst outcome: the
    // user believes they capped a run and did not.
    for (const bad of ["/steps abc", "/steps 0", "/steps -4"]) {
      const { s, text } = await run(bad);
      expect(s.turnStepLimit, bad).toBeNull();
      expect(text, bad).toContain("not a step count");
    }
  });

  it("is discoverable in the command list", () => {
    const entry = SLASH_COMMANDS.find((c) => c.name === "steps");
    expect(entry).toBeDefined();
    expect(entry?.argumentHint).toContain("off");
  });
});