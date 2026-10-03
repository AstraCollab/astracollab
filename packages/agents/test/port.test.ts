import { describe, expect, it, vi } from "vitest";
import { tool } from "ai";
import { z } from "zod";

import {
  coerceOptionalBoolean,
  coerceOptionalNumber,
  coerceOptionalString,
  sanitiseEditInput,
  sanitiseExecuteInput,
  sanitiseListFilesInput,
  sanitiseWriteInput,
  sanitiserFor,
  wrapToolsWithSanitisers,
} from "../src/tool-input.js";
import { createPrepareStep, hasCalledATool, hasWritten, DEFAULT_WRITE_TOOLS } from "../src/coding-agent.js";

/**
 * The ported sanitisers and the ported step rule.
 *
 * These are workarounds for real traffic, so the tests are the real shapes that
 * traffic produced. Each case here was a looping agent before it was a line of
 * coercion.
 */

describe("coercion", () => {
  it("reads the Python-style booleans models actually emit", () => {
    // The patch this replaces existed because Mastra's listFilesTool uses
    // `z.boolean()` and Nemotron sends "True".
    for (const value of ["True", "true", "TRUE", "yes", "y", "1", 1, true]) {
      expect(coerceOptionalBoolean(value)).toBe(true);
    }
    for (const value of ["False", "false", "no", "n", "0", 0, false]) {
      expect(coerceOptionalBoolean(value)).toBe(false);
    }
  });

  it("treats a blank as absent, not as false", () => {
    // The difference between "off" and "not mentioned", and coercing the second
    // into the first silently turns a feature off.
    for (const value of [undefined, null, "", "  ", "null", "None", "undefined"]) {
      expect(coerceOptionalBoolean(value)).toBeUndefined();
    }
  });

  it("returns undefined for something that is not a boolean at all", () => {
    expect(coerceOptionalBoolean({})).toBeUndefined();
    expect(coerceOptionalBoolean("maybe")).toBeUndefined();
  });

  it("reads numbers from strings", () => {
    expect(coerceOptionalNumber("20")).toBe(20);
    expect(coerceOptionalNumber("1.5")).toBe(1.5);
    expect(coerceOptionalNumber("")).toBeUndefined();
    expect(coerceOptionalNumber(Number.NaN)).toBeUndefined();
  });

  it("stringifies a scalar rather than dropping it", () => {
    expect(coerceOptionalString("  a.ts ")).toBe("a.ts");
    expect(coerceOptionalString(7)).toBe("7");
    expect(coerceOptionalString(true)).toBe("true");
    expect(coerceOptionalString("  ")).toBeUndefined();
  });
});

describe("sanitisers", () => {
  it("strips blank optional fields from a command", () => {
    expect(sanitiseExecuteInput({ command: "ls", background: "", timeout: null, cwd: "  " })).toEqual({
      command: "ls",
    });
    expect(sanitiseExecuteInput({ command: "ls", background: "True", timeout: "30" })).toEqual({
      command: "ls",
      background: true,
      timeout: 30,
    });
  });

  it("recovers a write whose fields arrived as a JSON string", () => {
    expect(sanitiseWriteInput('{"path":"a.ts","content":"x","append":"True"}')).toEqual({
      path: "a.ts",
      content: "x",
      append: true,
    });
  });

  it("leaves a non-JSON string alone rather than mangling it", () => {
    expect(sanitiseWriteInput("not json")).toBe("not json");
  });

  it("normalises edit's optional strings", () => {
    expect(sanitiseEditInput({ path: "a.ts", old_string: "", new_string: "  x  " })).toEqual({
      path: "a.ts",
      new_string: "x",
    });
  });

  it("drops a `pattern` that is only the path repeated", () => {
    // Models mirror `path` into `pattern`, and a directory is not a glob. Left
    // alone the failure is indistinguishable from the stream-writer bugs.
    expect(sanitiseListFilesInput({ path: "/workspace/repo", pattern: "/workspace/repo" })).toEqual({
      path: "/workspace/repo",
    });
  });

  it("keeps a pattern that is a real glob", () => {
    // Guessing which one the model meant turns a working filter into a silent
    // full-directory listing.
    expect(sanitiseListFilesInput({ path: "/workspace/repo", pattern: "**/*.ts" })).toEqual({
      path: "/workspace/repo",
      pattern: "**/*.ts",
    });
  });

  it("leaves non-objects untouched", () => {
    expect(sanitiseExecuteInput(undefined)).toBeUndefined();
    expect(sanitiseExecuteInput([1, 2])).toEqual([1, 2]);
  });
});

describe("wrapToolsWithSanitisers", () => {
  // `z.boolean()` rejecting "True" is the bug this replaces, so the fixture has to
  // be strict or the test proves nothing.
  const strict = tool({
    description: "a strict command tool",
    inputSchema: z.object({ command: z.string(), background: z.boolean().optional() }),
    execute: async (input) => `ran ${input.command} background=${String(input.background)}`,
  });

  it("sanitises before the schema runs", async () => {
    const wrapped = wrapToolsWithSanitisers({
      execute_command: { ...strict, execute: async (i: never) => strict.execute!(i, {} as never) },
    } as never);
    // Without the sanitiser this input is a schema failure and a wasted step.
    const result = await (
      wrapped.execute_command as { execute: (i: unknown, o: unknown) => Promise<string> }
    ).execute({ command: "ls", background: "True" }, {});
    expect(result).toBe("ran ls background=true");
  });

  it("picks a sanitiser by tool name", () => {
    expect(sanitiserFor("execute_command")).toBe(sanitiseExecuteInput);
    expect(sanitiserFor("bash")).toBe(sanitiseExecuteInput);
    expect(sanitiserFor("list_files")).toBe(sanitiseListFilesInput);
  });

  it("lets an override win", () => {
    const custom = (raw: unknown) => raw;
    expect(sanitiserFor("bash")).not.toBe(custom);
  });

  it("falls through to the raw input when a sanitiser throws", async () => {
    // A bad heuristic must not be a worse failure than the bug it was written for.
    const wrapped = wrapToolsWithSanitisers(
      { t: { ...strict, execute: async () => "ran" } } as never,
      {
        t: () => {
          throw new Error("sanitiser bug");
        },
      },
    );
    await expect((wrapped.t as { execute: (i: unknown, o: unknown) => Promise<string> }).execute({}, {})).resolves.toBe("ran");
  });

  it("leaves a tool with no execute alone", () => {
    const wrapped = wrapToolsWithSanitisers({ passive: { description: "no execute" } } as never);
    expect(wrapped.passive).toEqual({ description: "no execute" });
  });
});

describe("the ported step rule", () => {
  const step = (n: number, toolNames: string[] = []) => ({ step: n, toolNames });
  const base = { mode: "implement" as const, modelId: "deepseek/deepseek-chat" };

  it("treats step 1 as the first step, not step 0", () => {
    // The single most dangerous line in this port: Mastra numbered steps from
    // 0, the harness numbers them from 1.
    const prepareStep = createPrepareStep({ ...base, requireFirstTool: true });
    expect(prepareStep({ stepNumber: 1, steps: [] }).toolChoice).toBe("required");
    expect(prepareStep({ stepNumber: 2, steps: [step(1, ["write"])] }).toolChoice).toBe("auto");
  });

  it("forces a tool until one has been called, when asked", () => {
    const prepareStep = createPrepareStep({ ...base, forceToolChoiceUntilFirstTool: true });
    expect(prepareStep({ stepNumber: 1, steps: [] }).toolChoice).toBe("required");
    // The force is "until the first tool call", so it releases the moment one
    // happens — reading counts. That is the whole name.
    expect(prepareStep({ stepNumber: 4, steps: [step(1, ["read"])] }).toolChoice).toBe("auto");
    expect(prepareStep({ stepNumber: 4, steps: [step(1, []), step(2, [])] }).toolChoice).toBe("required");
  });

  it("keeps requiring a tool while nothing has been written", () => {
    const prepareStep = createPrepareStep({ ...base, requireFirstTool: true });
    // Step 2 with a read but no write: ported from `stepNumber >= 1` under
    // Mastra's numbering, which is step 2 here.
    expect(prepareStep({ stepNumber: 2, steps: [step(1, ["read"])] }).toolChoice).toBe("required");
    expect(prepareStep({ stepNumber: 2, steps: [step(1, ["write"])] }).toolChoice).toBe("auto");
  });

  it("never forces a model that must use auto", () => {
    const mustAuto = vi.fn().mockReturnValue(true);
    const prepareStep = createPrepareStep({ ...base, requireFirstTool: true, mustUseAutoToolChoice: mustAuto });
    expect(prepareStep({ stepNumber: 1, steps: [] }).toolChoice).toBe("auto");
    // Evaluated against the first step, which was step 0 in the Mastra agent.
    expect(mustAuto).toHaveBeenCalledWith("deepseek/deepseek-chat", 1);
  });

  it("scout mode does not apply the implement rule", () => {
    const prepareStep = createPrepareStep({ mode: "scout", modelId: "gpt-5", requireFirstTool: true });
    expect(prepareStep({ stepNumber: 1, steps: [] }).toolChoice).toBe("auto");
  });

  it("recognises a write by tool name", () => {
    expect(hasWritten([step(1, ["read"])], DEFAULT_WRITE_TOOLS)).toBe(false);
    expect(hasWritten([step(1, ["edit"])], DEFAULT_WRITE_TOOLS)).toBe(true);
    expect(hasWritten([step(1, ["write_file"])], DEFAULT_WRITE_TOOLS)).toBe(true);
    expect(hasCalledATool([step(1, ["read"])])).toBe(true);
    expect(hasCalledATool([step(1, [])])).toBe(false);
  });
});