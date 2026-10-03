import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { composeTurnRequest } from "../src/session.js";
import type { SessionState } from "../src/session.js";
import { createWorkflowTools, formatWorkflowResult } from "../src/workflow-tools.js";
import { createNahWorkflows } from "../src/workflows.js";

const baseState = (tools: Record<string, unknown> = {}): SessionState =>
  ({ system: "base system", tools, messages: [], cwd: "/repo", taskLedger: null }) as unknown as SessionState;

/** The orchestrator is a collaborator here, so its one method is a stub. */
const stubOrchestrator = (runWorkflow: (workflow: { id: string }, options: { inputData?: unknown }) => Promise<unknown>) =>
  ({ runWorkflow }) as never;

const withWorkflows = (approve: (name: string, input: unknown) => Promise<boolean> = async () => true) => {
  const registry = createNahWorkflows({ cwd: process.cwd() });
  const tools = createWorkflowTools({
    orchestrator: stubOrchestrator(async (workflow) => ({
      status: "success",
      workflowId: workflow.id,
      result: { ok: true },
    })) as never,
    registry,
    cwd: process.cwd(),
    approve,
  });
  return { registry, tools };
};

describe("the model is told about workflows before it can use them", () => {
  it("points at list_workflows and run_workflow when they are registered", () => {
    const { system } = composeTurnRequest(baseState({ run_workflow: {} }), "review my changes", "");
    // The gap this closes: a tool the prompt never mentions is one the model
    // reaches for only after improvising the same sequence out of other tools.
    expect(system).toContain("list_workflows");
    expect(system).toContain("run_workflow");
  });

  it("says nothing about workflows when there are none", () => {
    // A sandboxed session has no registry and no tools. Naming them anyway would
    // teach the model to ask for something it cannot have.
    const { system } = composeTurnRequest(baseState(), "review my changes", "");
    expect(system).not.toContain("workflow");
  });

  it("leaves the system half byte-identical across turns", () => {
    const tools = { run_workflow: {}, list_workflows: {} };
    const first = composeTurnRequest(baseState(tools), "one", "").system;
    const second = composeTurnRequest(baseState(tools), "two", "").system;
    expect(second).toBe(first);
  });
});

describe("running a workflow by name", () => {
  it("points at list_workflows rather than naming the workflows in the schema", () => {
    const { tools } = withWorkflows();
    // One tool rather than one per workflow: the choice stays explicit, and
    // adding a workflow does not change any tool schema. The names are read at
    // call time instead, because a workflow written during the session is not in
    // the registry the schema was built from.
    expect(Object.keys(tools)).toEqual(["run_workflow", "list_workflows"]);
    expect(tools.run_workflow!.description).toContain("list_workflows");
    expect(tools.list_workflows!.inputSchema).toBeDefined();
  });

  it("asks for approval before it starts, and does nothing when refused", async () => {
    const asked: Array<{ name: string; input: unknown }> = [];
    const { tools } = withWorkflows(async (name, input) => {
      asked.push({ name, input });
      return false;
    });
    const result = await tools.run_workflow!.execute!({ workflow: "ship-check", input: {} }, { toolCallId: "1", messages: [] } as never);
    expect(result).toBe("The workflow was not started because approval was denied.");
    expect(asked).toEqual([{ name: "run_workflow", input: { workflow: "ship-check", input: {} } }]);
  });

  it("reports a run the model has to hand back to a human", () => {
    // The distinction that matters: a paused run is still open, and a second run
    // started to work around it would duplicate whatever it was waiting on.
    const text = formatWorkflowResult({
      status: "suspended",
      workflowId: "review-changes",
      suspended: ["review-batch"],
      suspendPayload: { question: "approve these edits?" },
    } as never);
    expect(text).toContain("review-batch");
    expect(text).toContain("still open");
  });

  it("reports a failure as a failure, with the message", () => {
    const text = formatWorkflowResult({
      status: "failed",
      workflowId: "ship-check",
      error: new Error("pnpm run test exited 1"),
    } as never);
    expect(text).toBe("Workflow ship-check failed: pnpm run test exited 1");
  });
});

describe("the built-in sequences run the way they are described", () => {
  it("lists both, and refuses to invent a third", () => {
    const { registry } = withWorkflows();
    expect(registry.list().map(({ id }) => id)).toEqual(["review-changes", "ship-check"]);
    expect(registry.get("nope")).toBeUndefined();
  });

  it("ship-check runs the scripts the workspace defines and skips the rest", async () => {
    // A workflow that invoked a missing script would report a failure the
    // project never claimed to have — and a skipped one that claimed to pass
    // would be the same lie with the sign flipped.
    const cwd = await mkdtemp(join(tmpdir(), "nah-workflow-"));
    await writeFile(join(cwd, "package.json"), JSON.stringify({ scripts: { lint: "echo lint-ok" } }));
    const shipCheck = createNahWorkflows({ cwd }).get("ship-check")!;
    const result = await shipCheck.createRun().start({ inputData: {} });
    expect(result.status).toBe("success");
    const output = result.result as { clean: boolean; skipped: string[]; report: string };
    expect(output.clean).toBe(true);
    expect(output.report).toContain("pass  lint");
    expect(output.report).toContain("lint-ok");
    expect(output.report).toContain("skip  test");
    expect(output.skipped).toEqual(["typecheck", "test"]);
  });

  it("ship-check says so when the workspace has no verification at all", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "nah-workflow-"));
    const result = await createNahWorkflows({ cwd }).get("ship-check")!.createRun().start({ inputData: {} });
    expect(result.status).toBe("success");
    const output = result.result as { clean: boolean; report: string };
    expect(output.clean).toBe(true);
    expect(output.report).not.toContain("pass");
  });
});
