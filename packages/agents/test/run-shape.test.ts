import { describe, expect, it } from "vitest";

import {
  calledTool,
  dedupeAndCapSummary,
  executeCommandsFrom,
  summaryFrom,
  toolNamesFrom,
  usageSummary,
  wroteFiles,
} from "../src/run-shape.js";

/**
 * Reading a finished run.
 *
 * Each test here corresponds to something that used to be a probe across several
 * result shapes, because the Mastra result is loosely typed. The fixtures are
 * therefore built from the harness's own message shape, and the cases named after
 * the behaviour they replace.
 */

type Part = Record<string, unknown>;
type Msg = { role: string; content: Part[] | string };

const result = (parts: Part[], toolParts: Part[] = [], text = "done") =>
  ({
    messages: [
      ...parts.map((part, index) => ({ role: "assistant", content: [part] }) as Msg),
      ...toolParts.map((part) => ({ role: "tool", content: [part] }) as Msg),
    ],
    text,
    usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 },
    steps: 2,
    reason: "completed",
  }) as never;

const call = (toolName: string, input: unknown, toolCallId = `t${toolName}`): Part => ({
  type: "tool-call",
  toolCallId,
  toolName,
  input,
});
const text = (value: string): Part => ({ type: "text", text: value });
/** A tool result the SDK would write for a tool that did its job. */
const ok = (toolCallId: string): Part => ({
  type: "tool-result",
  toolCallId,
  output: { type: "text", value: "done" },
});
/** And for one that threw — which is how a failure reaches the transcript. */
const failed = (toolCallId: string): Part => ({
  type: "tool-result",
  toolCallId,
  output: { type: "error-text", value: "Error: ENOENT: no such file" },
});

describe("tool names", () => {
  it("reads tool names in call order", () => {
    const names = toolNamesFrom(result([call("read", {}), text("now"), call("bash", { command: "ls" })]));
    expect(names).toEqual(["read", "bash"]);
  });

  it("deduplicates while keeping first-seen order", () => {
    expect(toolNamesFrom(result([call("read", {}), call("bash", {}), call("read", {})]))).toEqual(["read", "bash"]);
  });

  it("ignores non-call parts", () => {
    expect(toolNamesFrom(result([text("hello"), { type: "reasoning", text: "thinking" }]))).toEqual([]);
  });

  it("honours a limit", () => {
    const many = [call("a", {}), call("b", {}), call("c", {})];
    expect(toolNamesFrom(result(many), { limit: 2 })).toEqual(["a", "b"]);
  });

  it("answers whether one specific tool ran", () => {
    expect(calledTool(result([call("read", {})]), "read")).toBe(true);
    expect(calledTool(result([call("read", {})]), "bash")).toBe(false);
  });

  it("returns nothing for an empty run", () => {
    expect(toolNamesFrom(result([]))).toEqual([]);
  });
});

describe("shell commands", () => {
  it("collects the commands, not just the count", () => {
    // A gate that counted calls would pass an agent that only ran `git status`.
    const commands = executeCommandsFrom(result([call("bash", { command: "  git status  " }), call("bash", { command: "pnpm test" })]));
    expect(commands).toEqual(["git status", "pnpm test"]);
  });

  it("ignores a call with no usable command", () => {
    expect(executeCommandsFrom(result([call("bash", {}), call("bash", { command: "   " }), call("bash", null)]))).toEqual([]);
  });

  it("accepts an alternative command tool name", () => {
    expect(executeCommandsFrom(result([call("execute_command", { command: "ls" })]))).toEqual(["ls"]);
    expect(executeCommandsFrom(result([call("execute_command", { command: "ls" })]), ["execute_command"])).toEqual(["ls"]);
  });

  it("notices a write that worked", () => {
    expect(wroteFiles(result([call("read", {})], [ok("tread")]))).toBe(false);
    expect(wroteFiles(result([call("edit", {})], [ok("tedit")]))).toBe(true);
  });
});

describe("a write that did not happen", () => {
  it("does not count a failed edit", () => {
    // The gate this replaces counted calls. A run whose every `edit` threw on a
    // stale path passes that gate and ships a claim of work that was never done,
    // and the transcript says so in the very next message.
    const run = result([call("edit", { path: "src/a.ts" })], [failed("tedit")]);
    expect(toolNamesFrom(run)).toContain("edit");
    expect(wroteFiles(run)).toBe(false);
  });

  it("counts the edit that worked even when another failed", () => {
    const run = result(
      [call("edit", { path: "src/a.ts" }, "tedit1"), call("edit", { path: "src/b.ts" }, "tedit2")],
      [failed("tedit1"), ok("tedit2")],
    );
    expect(wroteFiles(run)).toBe(true);
  });

  it("does not count a call with no result, which means the run was cut off", () => {
    expect(wroteFiles(result([call("edit", {})], []))).toBe(false);
  });

  it("does not count a denied call", () => {
    // An approval the user refused is a deliberate non-action, and it arrives as a
    // result part like any other — only its output type gives it away.
    const denied = {
      type: "tool-result",
      toolCallId: "tedit",
      output: { type: "execution-denied", reason: "user said no" },
    };
    expect(wroteFiles(result([call("edit", {})], [denied]))).toBe(false);
  });
});

describe("summary", () => {
  it("takes the text the harness already resolved", () => {
    // The 107-line version existed because Mastra can leave `text` empty while
    // the messages hold the answer. `HarnessRunResult.text` is resolved already,
    // so there is no fallback to write.
    expect(summaryFrom({ text: "All done." } as never)).toBe("All done.");
  });

  it("collapses a repeated sentence", () => {
    const repeated =
      "I updated the config. I updated the config. Then the tests pass and the build is green again.";
    const out = dedupeAndCapSummary(repeated);
    expect(out.match(/I updated the config/g)).toHaveLength(1);
    expect(out).toContain("the tests pass");
  });

  it("collapses paragraphs that restate each other", () => {
    const out = dedupeAndCapSummary(
      "The change is in src/a.ts.\n\nThe change is in src/a.ts and the test was updated to match.",
    );
    expect(out.match(/The change is in/g)).toHaveLength(1);
    // Dedupe keeps the first statement and drops the restatement, so the extra
    // detail in the later paragraph goes with it. That is the trade: a duplicate
    // in a PR summary is worse than a lost clause.
    expect(out).toBe("The change is in src/a.ts.");
  });

  it("collapses a restatement whose only difference is trailing punctuation", () => {
    // A real defect in the original, found by porting it: the five-word core key
    // was built verbatim, so a sentence-ending period defeated every duplicate
    // check and repetition shipped to the PR body.
    const out = dedupeAndCapSummary("The change is in src/a.ts.\n\nThe change is in src/a.ts, plus a test.");
    expect(out.match(/The change is in/g)).toHaveLength(1);
  });

  it("keeps genuinely different sentences", () => {
    const out = dedupeAndCapSummary("The change is in src/a.ts. The build now passes on CI.");
    expect(out).toContain("src/a.ts");
    expect(out).toContain("passes on CI");
  });

  it("caps the length with an ellipsis", () => {
    const out = dedupeAndCapSummary("word ".repeat(400));
    expect(out.length).toBeLessThanOrEqual(500);
    expect(out.endsWith("…")).toBe(true);
  });

  it("honours a custom cap", () => {
    expect(dedupeAndCapSummary("abcdefghij".repeat(10), 20).length).toBeLessThanOrEqual(20);
  });

  it("returns nothing for nothing", () => {
    expect(dedupeAndCapSummary("   ")).toBe("");
    expect(summaryFrom({ text: "" } as never)).toBe("");
  });

  it("survives a short fragment, which a dedupe rule would otherwise eat", () => {
    expect(dedupeAndCapSummary("Done.")).toBe("Done.");
  });
});

describe("usage summary", () => {
  it("carries the figures a turn log needs", () => {
    const summary = usageSummary({
      steps: 3,
      reason: "completed",
      usage: { inputTokens: 900, outputTokens: 120, totalTokens: 1020, cachedInputTokens: 400, spendUsd: 0.01 },
    } as never);
    expect(summary).toMatchObject({ steps: 3, inputTokens: 900, outputTokens: 120, cachedInputTokens: 400, spendUsd: 0.01, reason: "completed" });
  });

  it("reports zero cache reads rather than undefined", () => {
    // A log line that says `undefined` reads as a bug in the logging.
    expect(usageSummary({ steps: 1, reason: "completed", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } } as never).cachedInputTokens).toBe(0);
  });
});