import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as nodePath from "node:path";
import { describe, expect, it } from "vitest";

import { summarizeToolResult, toolLabel } from "../src/render.js";
import { createTaskLedgerTool } from "../src/task-ledger.js";
import type { SessionState } from "../src/session.js";

const strip = (s: string) =>
  s.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "").replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, "");

describe("tool labels", () => {
  it("names bookkeeping tools by intent, not by raw name", () => {
    expect(toolLabel("task_ledger", { action: "discover_checks" })).toBe("find executable checks");
    expect(toolLabel("task_ledger", { action: "plan" })).toBe("save plan");
    expect(toolLabel("task_ledger", { action: "step", id: "step-1", status: "completed" })).toBe(
      "plan · step-1 → completed",
    );
    expect(toolLabel("task_ledger", { action: "run_check", id: "check-1" })).toBe("run check check-1");
  });

  it("never shows a raw snake_case tool name", () => {
    expect(toolLabel("task_ledger", { action: "whatever" })).not.toContain("_");
    expect(toolLabel("some_new_tool", {})).toBe("some new tool");
  });

  it("labels glob and keeps existing tools intact", () => {
    expect(toolLabel("glob", { pattern: "**/*.tsx" })).toBe("glob **/*.tsx");
    expect(toolLabel("read", { path: "a.ts", offset: 10 })).toBe("read a.ts:10");
    expect(toolLabel("bash", { command: "pnpm test" })).toBe("$ pnpm test");
  });
});

describe("tool result summarising", () => {
  it("summarises a ledger check discovery instead of dumping every check", () => {
    const out = "Discovered executable checks (use exact commands in the plan):\n- pnpm test\n- pnpm lint";
    const summary = summarizeToolResult("task_ledger", { action: "discover_checks" }, out, false);
    expect(summary.show).toBe(true);
    expect(summary.text).toBe("2 checks found");
    expect(summary.text).not.toContain("pnpm");
  });

  it("summarises plan/step/check bookkeeping to one short line", () => {
    expect(summarizeToolResult("task_ledger", { action: "plan" }, "Task plan saved...", false)).toEqual({
      show: true,
      text: "plan saved",
    });
    expect(summarizeToolResult("task_ledger", { action: "step" }, "step-2 → completed", false).text).toBe(
      "step-2 → completed",
    );
  });

  it("stays quiet for successful reads and searches", () => {
    expect(summarizeToolResult("read", { path: "a.ts" }, "1|line one", false).show).toBe(false);
    expect(summarizeToolResult("grep", { pattern: "x" }, "3 matches", false).show).toBe(false);
  });

  it("always surfaces errors, whatever the tool", () => {
    expect(summarizeToolResult("read", {}, "Error: nope", true).show).toBe(true);
    expect(summarizeToolResult("task_ledger", { action: "step" }, "Error: no task step", true).show).toBe(true);
  });
});

describe("task ledger step ids", () => {
  const state = (): SessionState => {
    const discovered = ["pnpm test", "pnpm lint"];
    return {
      discoveredChecks: discovered,
      taskLedger: null,
      store: null,
    } as unknown as SessionState;
  };

  const call = async (input: unknown) =>
    await createTaskLedgerTool(state(), async () => true).execute(input as never, {});

  it("mints guessable prefixed ids", async () => {
    const s = state();
    const tool = createTaskLedgerTool(s, async () => true);
    await tool.execute({ action: "plan", goal: "ship", steps: ["a", "b"], checks: [{ description: "tests", command: "pnpm test" }] } as never, {});
    expect(s.taskLedger!.steps.map((x) => x.id)).toEqual(["step-1", "step-2"]);
    expect(s.taskLedger!.checks.map((x) => x.id)).toEqual(["check-1"]);
  });

  it("accepts the natural guess 'step-1' after saving a plan", async () => {
    const s = state();
    const tool = createTaskLedgerTool(s, async () => true);
    await tool.execute({ action: "plan", goal: "ship", steps: ["inspect", "edit"], checks: [{ description: "tests", command: "pnpm test" }] } as never, {});
    const out = await tool.execute({ action: "step", id: "step-1", status: "completed" } as never, {});
    expect(out).not.toContain("Error");
    expect(s.taskLedger!.steps[0]!.status).toBe("completed");
  });

  it("also accepts a bare number, as older plans used", async () => {
    const s = state();
    const tool = createTaskLedgerTool(s, async () => true);
    await tool.execute({ action: "plan", goal: "ship", steps: ["inspect", "edit"], checks: [{ description: "tests", command: "pnpm test" }] } as never, {});
    await tool.execute({ action: "step", id: "2", status: "in_progress" } as never, {});
    expect(s.taskLedger!.steps[1]!.status).toBe("in_progress");
  });

  it("lists the valid ids instead of dead-ending on a wrong guess", async () => {
    const s = state();
    const tool = createTaskLedgerTool(s, async () => true);
    await tool.execute({ action: "plan", goal: "ship", steps: ["inspect"], checks: [{ description: "tests", command: "pnpm test" }] } as never, {});
    const out = await tool.execute({ action: "step", id: "wibble", status: "completed" } as never, {});
    expect(out).toContain('no step with id "wibble"');
    // The message must be self-correcting: it names the real ids.
    expect(out).toContain("step-1");
    void call;
  });
});
