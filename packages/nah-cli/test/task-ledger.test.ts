import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { createJsonlSessionStore } from "@astracollab/not-another-harness";
import { afterEach, describe, expect, it } from "vitest";
import { createTaskLedgerTool } from "../src/task-ledger.js";
import type { SessionState } from "../src/session.js";

describe("durable task ledger", () => {
  let directory = "";
  afterEach(async () => { if (directory) await rm(directory, { recursive: true, force: true }); });

  it("requires discovered commands and records real execution outcomes before completion", async () => {
    directory = await mkdtemp(path.join(tmpdir(), "nah-task-ledger-"));
    const store = createJsonlSessionStore(path.join(directory, "session.jsonl"));
    const results = [
      { stdout: "type error", stderr: "", exitCode: 1 },
      { stdout: "typecheck passed", stderr: "", exitCode: 0 },
    ];
    const state = {
      taskLedger: null,
      discoveredChecks: [],
      activeFileChanges: null,
      store,
      workspace: {
        exists: async (file: string) => ["package.json", "pnpm-lock.yaml"].includes(file),
        readFile: async () => JSON.stringify({ scripts: { typecheck: "tsc --noEmit" } }),
        exec: async () => results.shift()!,
      },
    } as unknown as SessionState;
    const approvals: unknown[] = [];
    const ledgerTool = createTaskLedgerTool(state, async (name, input) => { approvals.push([name, input]); return true; }) as unknown as {
      execute: (input: unknown, context: unknown) => Promise<string>;
    };
    const invoke = (input: unknown) => ledgerTool.execute(input, {});

    const prematurePlan = await invoke({ action: "plan", goal: "Feature", steps: ["Implement"], checks: [{ description: "Typecheck", command: "CI=true pnpm run typecheck" }] });
    expect(prematurePlan).toContain("discover_checks");
    const found = await invoke({ action: "discover_checks" });
    expect(found).toContain("CI=true pnpm run typecheck");
    await invoke({ action: "plan", goal: "Feature", steps: ["Implement"], checks: [{ description: "Typecheck", command: "CI=true pnpm run typecheck" }] });
    expect(await invoke({ action: "status", status: "completed" })).toContain("Cannot complete task");

    const failed = await invoke({ action: "run_check", id: "1" });
    expect(failed).toContain("failed (exit 1");
    expect(state.taskLedger?.checks[0]?.status).toBe("failed");
    await invoke({ action: "step", id: "1", status: "completed" });
    expect(await invoke({ action: "status", status: "completed" })).toContain("1 acceptance check(s) remain");

    const passed = await invoke({ action: "run_check", id: "1" });
    expect(passed).toContain("passed (exit 0");
    await invoke({ action: "status", status: "completed" });
    expect(approvals).toHaveLength(2);
    expect((approvals[0] as [string])[0]).toBe("bash");

    const restored = await createJsonlSessionStore(path.join(directory, "session.jsonl")).loadTaskLedger();
    expect(restored?.status).toBe("completed");
    expect(restored?.steps.every((step) => step.status === "completed")).toBe(true);
    expect(restored?.checks[0]?.attempts.map((attempt) => attempt.exitCode)).toEqual([1, 0]);
  });
});
