import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  cloneWorkflow,
  createStep,
  createWorkflow,
  createWorkflowRegistry,
  formatWorkflowList,
  StepSuspend,
  workflowStepsSummary,
  type WorkflowEvent,
} from "../src/workflow.js";

/** Appends to a log so ordering and repeat-runs are assertable. */
const traced = (log: string[], id: string) =>
  createStep({
    id,
    outputSchema: z.object({ text: z.string() }),
    execute: async ({ inputData }) => {
      log.push(id);
      return { text: `${JSON.stringify(inputData)}→${id}` };
    },
  });

describe("sequence", () => {
  it("threads each step's output into the next", async () => {
    const log: string[] = [];
    const workflow = createWorkflow({ id: "chain" })
      .then(traced(log, "one"))
      .then(traced(log, "two"))
      .commit();

    const result = await workflow.createRun().start({ inputData: { label: "go" } });

    expect(result.status).toBe("success");
    expect(result.steps.one?.input).toEqual({ label: "go" });
    expect(result.steps.two?.input).toEqual({ text: '{"label":"go"}→one' });
    expect(log).toEqual(["one", "two"]);
  });

  it("hands a step the keys its own schema declares", async () => {
    const workflow = createWorkflow({ id: "picky" })
      .then(createStep({ id: "classify", outputSchema: z.object({ id: z.string(), severity: z.string() }), execute: () => ({ id: "7", severity: "high" }) }))
      .then(createStep({ id: "summarise", inputSchema: z.object({ severity: z.string() }), execute: ({ inputData }) => `issue ${(inputData as { severity: string }).severity}` }))
      .commit();

    const result = await workflow.createRun().start();

    // `id` is dropped on purpose: a step declares the slice it needs, so two steps
    // that read different fields of one record do not have to agree on its shape.
    expect(result.steps.summarise?.input).toEqual({ severity: "high" });
    expect(result.result).toBe("issue high");
  });

  it("passes a scalar straight through to the next step", async () => {
    const seen: unknown[] = [];
    const workflow = createWorkflow({ id: "chain" })
      .then(createStep({ id: "head", outputSchema: z.string(), execute: () => "plain string" }))
      .then(createStep({ id: "tail", inputSchema: z.string(), execute: ({ inputData }) => {
        seen.push(inputData);
        return "done";
      } }))
      .commit();

    await workflow.createRun().start();

    expect(seen).toEqual(["plain string"]);
  });

  it("gives the first step the workflow's own input", async () => {
    let seen: unknown;
    const workflow = createWorkflow({ id: "chain", inputSchema: z.object({ title: z.string() }) })
      .then(createStep({ id: "head", inputSchema: z.object({ title: z.string() }), execute: ({ inputData }) => {
        seen = inputData;
        return "ok";
      } }))
      .commit();

    await workflow.createRun().start({ inputData: { title: "issue 12" } });

    expect(seen).toEqual({ title: "issue 12" });
  });

  it("keeps runs independent", async () => {
    let count = 0;
    const workflow = createWorkflow({ id: "counter" })
      .then(createStep({ id: "bump", execute: () => ++count }))
      .commit();

    await workflow.createRun().start();
    await workflow.createRun().start();

    expect(count).toBe(2);
  });
});

describe("state", () => {
  it("merges setState and carries it to later steps", async () => {
    const seen: unknown[] = [];
    const workflow = createWorkflow({ id: "stately", stateSchema: z.object({ count: z.number().default(0), notes: z.array(z.string()).default([]) }) })
      .then(createStep({ id: "add", execute: ({ state, setState }) => {
        setState({ count: (state.count as number) + 1 });
        return "ok";
      } }))
      .then(createStep({ id: "add-again", execute: ({ state, setState }) => {
        setState((current) => ({ count: (current.count as number) + 1 }));
        return "ok";
      } }))
      .then(createStep({ id: "read", execute: ({ state }) => {
        seen.push(state.count);
        return "ok";
      } }))
      .commit();

    const result = await workflow.createRun().start();

    // Defaults come from the schema, so a step can read a field before any step writes it.
    expect(seen).toEqual([2]);
    expect(result.state).toEqual({ count: 2, notes: [] });
  });
});

describe("composition", () => {
  it("runs parallel branches and returns their outputs in order", async () => {
    const log: string[] = [];
    const workflow = createWorkflow({ id: "fan" })
      .parallel([
        [traced(log, "left"), traced(log, "left-tail")],
        traced(log, "right"),
      ])
      .commit();

    const result = await workflow.createRun().start({ inputData: { label: "x" } });

    expect(result.status).toBe("success");
    expect(result.result).toEqual([
      { text: '{"text":"{\\"label\\":\\"x\\"}→left"}→left-tail' },
      { text: '{"label":"x"}→right' },
    ]);
    expect(log).toContain("right");
    // A branch's own steps run in sequence, so the second step in a branch sees
    // the first step's output while the other branch still sees the branch input.
    expect(result.steps["left-tail"]?.input).toEqual({ text: '{"label":"x"}→left' });
  });

  it("takes the first matching branch and reports which one", async () => {
    const workflow = createWorkflow({ id: "choose" })
      .then(createStep({ id: "classify", outputSchema: z.object({ kind: z.string() }), execute: () => ({ kind: "bug" }) }))
      .branch([
        [(previous) => (previous as { kind: string }).kind === "bug", createStep({ id: "fix", execute: () => "fixed" })],
        [() => true, createStep({ id: "other", execute: () => "other" })],
      ])
      .commit();

    const result = await workflow.createRun().start();

    expect(result.result).toBe("fixed");
    expect(Object.keys(result.steps)).toEqual(["classify", "fix"]);
  });

  it("falls back to otherwise when nothing matches", async () => {
    const workflow = createWorkflow({ id: "choose" })
      .branch([[() => false, createStep({ id: "never", execute: () => "no" })]], { otherwise: createStep({ id: "fallback", execute: () => "fallback" }) })
      .commit();

    const result = await workflow.createRun().start();

    expect(result.result).toBe("fallback");
  });

  it("sees the run context in a branch condition", async () => {
    const workflow = createWorkflow({ id: "choose" })
      .branch([[(_previous, context) => context.mode === "fast", createStep({ id: "fast", execute: () => "fast" })]], {
        otherwise: createStep({ id: "slow", execute: () => "slow" }),
      })
      .commit();

    const result = await workflow.createRun().start({ context: { mode: "fast" } });

    expect(result.result).toBe("fast");
  });

  it("maps over an array and gathers the results", async () => {
    const workflow = createWorkflow({ id: "each" })
      .then(createStep({ id: "start", execute: () => ({ files: ["a.ts", "b.ts"] }) }))
      .map({
        inputKey: "files",
        outputKey: "sizes",
        mapper: (file: string) => createStep({ id: `size-${file}`, execute: () => ({ file, size: file.length }) }),
      })
      .commit();

    const result = await workflow.createRun().start();

    expect(result.result).toEqual({ files: ["a.ts", "b.ts"], sizes: [{ file: "a.ts", size: 4 }, { file: "b.ts", size: 4 }] });
  });

  it("nests a workflow and reports its steps under the parent", async () => {
    const inner = createWorkflow({ id: "inner" })
      .then(createStep({ id: "deep", execute: () => "deep value" }))
      .commit();
    const outer = createWorkflow({ id: "outer" }).then(inner).then(createStep({ id: "after", execute: () => "after" })).commit();

    const result = await outer.createRun().start();

    expect(result.status).toBe("success");
    expect(result.result).toBe("after");
    expect(result.steps["inner/deep"]?.output).toBe("deep value");
  });
});

describe("validation", () => {
  it("fails the run when a step returns the wrong shape", async () => {
    const workflow = createWorkflow({ id: "strict" })
      .then(createStep({ id: "wrong", outputSchema: z.object({ text: z.string() }), execute: () => ({ text: 42 }) as never }))
      .commit();

    const result = await workflow.createRun().start();

    expect(result.status).toBe("failed");
    expect(result.status === "failed" && result.error.message).toContain("step \"wrong\" output");
    expect(result.steps.wrong?.status).toBe("failed");
  });

  it("rejects input that does not match the workflow's schema", async () => {
    const workflow = createWorkflow({ id: "strict", inputSchema: z.object({ id: z.string() }) })
      .then(createStep({ id: "any", execute: () => "ok" }))
      .commit();

    const result = await workflow.createRun().start({ inputData: { id: 7 } as never });

    expect(result.status).toBe("failed");
  });

  it("rejects a workflow that uses one step id twice", () => {
    const step = createStep({ id: "same", execute: () => "ok" });
    const builder = createWorkflow({ id: "dup" }).then(step);

    expect(() => builder.then(step).commit()).toThrow(/appears twice/);
  });
});

describe("suspend and resume", () => {
  const approvalStep = createStep({
    id: "approve",
    execute: async ({ resumeData, context }) => {
      if (resumeData === undefined) throw new StepSuspend({ question: "ship it?" });
      return { decision: resumeData, by: context.actor ?? "unknown" };
    },
  });

  it("stops at the suspended step and keeps what already ran", async () => {
    const log: string[] = [];
    const workflow = createWorkflow({ id: "gated" }).then(traced(log, "before")).then(approvalStep).then(traced(log, "after")).commit();
    const run = workflow.createRun();

    const suspended = await run.start({ context: { actor: "elias" } });

    expect(suspended.status).toBe("suspended");
    expect(suspended.status === "suspended" && suspended.suspended).toEqual(["approve"]);
    expect(suspended.status === "suspended" && suspended.suspendPayload).toEqual({ question: "ship it?" });
    expect(log).toEqual(["before"]);
    expect(run.status).toBe("suspended");
    expect(run.snapshot()?.pending).toEqual([{ id: "approve", payload: { question: "ship it?" } }]);
  });

  it("resumes at the suspended step and replays nothing", async () => {
    const log: string[] = [];
    const workflow = createWorkflow({ id: "gated" }).then(traced(log, "before")).then(approvalStep).then(traced(log, "after")).commit();
    const run = workflow.createRun();
    await run.start({ context: { actor: "elias" } });

    const resumed = await run.resume({ resumeData: "yes" });

    expect(resumed.status).toBe("success");
    expect(resumed.steps.approve?.output).toEqual({ decision: "yes", by: "elias" });
    // "before" appears once across both executions: a step that already succeeded
    // is not paid for twice.
    expect(log).toEqual(["before", "after"]);
    expect(resumed.steps.before?.output).toEqual({ text: "undefined→before" });
    expect(run.status).toBe("success");
  });

  it("can suspend again after resuming", async () => {
    const workflow = createWorkflow({ id: "twice" })
      .then(createStep({
        id: "gate",
        execute: ({ resumeData }) => {
          if (resumeData === undefined) throw new StepSuspend("first");
          if (resumeData === "partial") throw new StepSuspend("second");
          return "through";
        },
      }))
      .commit();
    const run = workflow.createRun();

    expect((await run.start()).status).toBe("suspended");
    expect((await run.resume({ resumeData: "partial" })).status).toBe("suspended");
    expect((await run.resume({ resumeData: "done" })).status).toBe("success");
  });
});

describe("streaming", () => {
  it("emits start, deltas and finish from the same execution", async () => {
    const workflow = createWorkflow({ id: "chatty" })
      .then(createStep({
        id: "write",
        execute: async ({ writer }) => {
          writer("hello ");
          writer("world");
          return "hello world";
        },
      }))
      .commit();

    const { events, result } = workflow.createRun().stream();
    const seen: WorkflowEvent[] = [];
    for await (const event of events) seen.push(event);

    expect(seen.map((event) => event.type)).toEqual(["workflow-start", "step-start", "step-delta", "step-delta", "step-finish", "workflow-finish"]);
    const final = await result;
    expect(final.status).toBe("success");
    // One run, one result: reading `result` after streaming must not start a second run.
    expect(final.steps.write?.output).toBe("hello world");
  });

  it("reports a failure as an event and a result, not a throw", async () => {
    const workflow = createWorkflow({ id: "broken" })
      .then(createStep({ id: "boom", execute: () => { throw new Error("kaboom"); } }))
      .commit();

    const { events, result } = workflow.createRun().stream();
    const seen: string[] = [];
    for await (const event of events) seen.push(event.type);

    expect(seen).toEqual(["workflow-start", "step-start", "step-error", "workflow-finish"]);
    const final = await result;
    expect(final.status === "failed" && final.error.message).toBe("kaboom");
  });
});

describe("registry and cloning", () => {
  it("registers, resolves and rejects duplicates", () => {
    const workflow = createWorkflow({ id: "known", description: "does a thing" }).then(createStep({ id: "noop", execute: () => 1 })).commit();
    const registry = createWorkflowRegistry({ known: workflow });

    expect(registry.get("known")).toBe(workflow);
    expect(registry.has("nope")).toBe(false);
    expect(formatWorkflowList(registry)).toBe("known  does a thing");
    expect(() => createWorkflowRegistry({ known: workflow, again: workflow })).toThrow(/duplicate/);
  });

  it("clones the same steps under a new id", async () => {
    const original = createWorkflow({ id: "base" }).then(createStep({ id: "noop", execute: () => "value" })).commit();
    const clone = cloneWorkflow(original, { id: "per-tenant" });

    const result = await clone.createRun().start();

    expect(clone.id).toBe("per-tenant");
    expect(result.workflowId).toBe("per-tenant");
    expect(result.result).toBe("value");
  });

  it("summarises a run's steps for a caller rendering it as text", async () => {
    const workflow = createWorkflow({ id: "report" })
      .then(createStep({ id: "ok", execute: () => 1 }))
      .then(createStep({ id: "bad", execute: () => { throw new Error("nope"); } }))
      .commit();

    const result = await workflow.createRun().start();

    expect(workflowStepsSummary(result)).toMatch(/^ok: success \(\d+ms\)\nbad: failed \(failed: nope\)$/);
  });
});
