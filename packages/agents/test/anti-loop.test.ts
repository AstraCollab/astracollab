import { describe, expect, it, vi } from "vitest";
import type { ModelMessage } from "ai";

import {
  createAntiLoopStop,
  evaluateAntiLoop,
  isGitVerificationCommand,
  isHallucinatedToolName,
  reconstructSteps,
  resolveGitVerifyStreak,
  resolveHallucinatedToolStreak,
} from "../src/anti-loop.js";

/**
 * The anti-loop rules.
 *
 * Each fixture is the failure the rule exists for, reconstructed in the shape the
 * harness produces. The rule that matters is the one that must *not* fire, so
 * several tests assert a healthy run continues.
 */

const assistant = (parts: Array<Record<string, unknown>>): ModelMessage =>
  ({ role: "assistant", content: parts }) as ModelMessage;
const tool = (toolCallId: string, output: unknown, isError = false): ModelMessage =>
  ({ role: "tool", content: [{ type: "tool-result", toolCallId, toolName: "read", output, ...(isError ? { isError } : {}) }] }) as ModelMessage;

const call = (toolName: string, input: Record<string, unknown> = {}, id = `t${toolName}`) => ({
  type: "tool-call",
  toolCallId: id,
  toolName,
  input,
});

const bash = (command: string, id: string) => assistant([call("bash", { command }, id)]);
const wrote = (path: string, id = "w1") => [assistant([call("edit", { path }, id)]), tool(id, "ok")];

describe("step reconstruction", () => {
  it("pairs a call with its result and reads what it did", () => {
    const steps = reconstructSteps([
      assistant([{ type: "text", text: "editing" }, call("edit", { path: "src/a.ts" }, "w1")]),
      tool("w1", "ok"),
      bash("git status", "b1"),
    ]);

    expect(steps).toHaveLength(2);
    expect(steps[0]!.mutated).toBe(true);
    expect(steps[0]!.writtenPaths).toEqual(["src/a.ts"]);
    expect(steps[0]!.text).toBe("editing");
    expect(steps[1]!.commands).toEqual(["git status"]);
    expect(steps[1]!.errors).toEqual([]);
  });

  it("records a failed tool result", () => {
    const steps = reconstructSteps([
      assistant([call("edit", { path: "a.ts" }, "w1")]),
      tool("w1", "ENOENT", true),
    ]);
    expect(steps[0]!.errors).toEqual(["ENOENT"]);
  });

  it("skips an empty assistant message", () => {
    expect(reconstructSteps([assistant([])])).toHaveLength(0);
  });
});

describe("predicates", () => {
  it("recognises git verification and not arbitrary commands", () => {
    expect(isGitVerificationCommand("git status")).toBe(true);
    expect(isGitVerificationCommand("git diff --stat")).toBe(true);
    expect(isGitVerificationCommand("pnpm test")).toBe(true);
    expect(isGitVerificationCommand("git commit -m 'x'")).toBe(false);
    expect(isGitVerificationCommand("rm -rf /")).toBe(false);
    expect(isGitVerificationCommand("   ")).toBe(false);
  });

  it("recognises invented tool names", () => {
    expect(isHallucinatedToolName("task_complete")).toBe(true);
    expect(isHallucinatedToolName("mastra_workspace_read_file")).toBe(true);
    expect(isHallucinatedToolName("read")).toBe(false);
    expect(isHallucinatedToolName("bash")).toBe(false);
  });

  it("clamps a streak so a typo cannot disable a guard", () => {
    expect(resolveGitVerifyStreak({ env: { TICKET_CODING_STOP_GIT_VERIFY_STREAK: "0" } })).toBe(2);
    expect(resolveGitVerifyStreak({ env: { TICKET_CODING_STOP_GIT_VERIFY_STREAK: "abc" } })).toBe(2);
    expect(resolveGitVerifyStreak({ env: { TICKET_CODING_STOP_GIT_VERIFY_STREAK: "99" } })).toBe(6);
    expect(resolveGitVerifyStreak({ env: { TICKET_CODING_STOP_GIT_VERIFY_STREAK: "3" } })).toBe(3);
    // The fast path is deliberately harsher: one verification pass is enough when
    // a profile preamble has already oriented the run.
    expect(resolveGitVerifyStreak({ implementFastPath: true, env: { TICKET_CODING_STOP_GIT_VERIFY_STREAK: "6" } })).toBe(1);
    expect(resolveHallucinatedToolStreak({ env: {} })).toBe(2);
  });
});

describe("the rules", () => {
  const messages = (...parts: ModelMessage[]) => parts;

  it("stops a run that verifies git over and over after editing", () => {
    const verdict = evaluateAntiLoop(
      messages(...wrote("src/a.ts"), bash("git status", "b1"), bash("git diff", "b2")),
    );
    expect(verdict).toMatchObject({ stopped: true, reason: "git-verify-loop" });
  });

  it("stops when verification runs twice after a write", () => {
    const verdict = evaluateAntiLoop(messages(...wrote("src/a.ts"), bash("git status", "b1"), bash("git status", "b2")));
    expect(verdict.stopped).toBe(true);
  });

  it("does not stop a healthy run that edits and verifies once", () => {
    const verdict = evaluateAntiLoop(
      messages(...wrote("src/a.ts"), bash("git status", "b1"), ...wrote("src/b.ts", "w2"), bash("git status", "b2")),
    );
    expect(verdict).toEqual({ stopped: false });
  });

  it("does not treat verification before any write as a loop", () => {
    // A run orienting itself in a repository it has not touched is doing its job.
    const verdict = evaluateAntiLoop(messages(bash("git log", "b1"), bash("git status", "b2")));
    expect(verdict).toEqual({ stopped: false });
  });

  it("honours an application-path filter", () => {
    const run = messages(...wrote("node_modules/x/i.ts"), bash("git status", "b1"), bash("git diff", "b2"));
    // A vendored file is not the agent's work, so verifying after it is not a loop.
    expect(evaluateAntiLoop(run, { isApplicationPath: () => false })).toEqual({ stopped: false });
    expect(evaluateAntiLoop(run).stopped).toBe(true);
  });

  it("stops a run calling tools that do not exist", () => {
    const verdict = evaluateAntiLoop(
      messages(
        assistant([call("task_complete", {}, "h1")]),
        tool("h1", "unknown tool"),
        assistant([call("end", {}, "h2")]),
        tool("h2", "unknown tool"),
      ),
    );
    expect(verdict).toMatchObject({ stopped: true, reason: "hallucinated-tool-loop" });
  });

  it("stops a run repeating the same validation failure", () => {
    const verdict = evaluateAntiLoop(
      messages(
        assistant([call("edit", { path: "a.ts" }, "e1")]),
        tool("e1", "schema error", true),
        assistant([call("edit", { path: "a.ts" }, "e2")]),
        tool("e2", "schema error", true),
      ),
    );
    expect(verdict).toMatchObject({ stopped: true, reason: "validation-failure-loop" });
  });

  it("does not stop one failed step", () => {
    const verdict = evaluateAntiLoop(
      messages(assistant([call("edit", { path: "a.ts" }, "e1")]), tool("e1", "boom", true)),
    );
    expect(verdict).toEqual({ stopped: false });
  });

  it("stops a run that keeps saying it is finished", () => {
    const done = () => assistant([{ type: "text", text: "I'm done with the implementation." }]);
    const verdict = evaluateAntiLoop(messages(done(), done(), done()));
    expect(verdict).toMatchObject({ stopped: true, reason: "completion-spam" });
  });

  it("returns nothing for an empty transcript", () => {
    expect(evaluateAntiLoop([])).toEqual({ stopped: false });
  });
});

describe("createAntiLoopStop", () => {
  it("returns a boolean a run can use directly", () => {
    const stop = createAntiLoopStop({ sink: () => {} });
    expect(stop({ messages: [...wrote("src/a.ts"), bash("git status", "b1"), bash("git diff", "b2")] })).toBe(true);
    expect(stop({ messages: [...wrote("src/a.ts"), bash("git status", "b1")] })).toBe(false);
  });

  it("logs which rule fired", () => {
    // "anti-loop" with no cause is a line nobody can act on.
    const lines: Array<[string, Record<string, unknown>]> = [];
    createAntiLoopStop({
      sink: (line, detail) => lines.push([line, detail as Record<string, unknown>]),
    })({ messages: [...wrote("src/a.ts"), bash("git status", "b1"), bash("git diff", "b2")] });

    expect(lines[0]![0]).toBe("[coding-agent] anti-loop stop");
    expect(lines[0]![1]).toMatchObject({ reason: "git-verify-loop", mode: "implement" });
  });

  it("stays quiet on a healthy run", () => {
    const sink = vi.fn();
    createAntiLoopStop({ sink })({ messages: [...wrote("src/a.ts"), bash("git status", "b1")] });
    expect(sink).not.toHaveBeenCalled();
  });
});