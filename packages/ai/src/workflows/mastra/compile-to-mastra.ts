import { createStep, createWorkflow } from "@mastra/core/workflows";
import { z } from "zod";

import { compilePublishedGraph } from "../compile-graph.js";
import type { UserWorkflowGraph } from "../graph-schema.js";
import type { CompilePublishedGraphResult } from "../compile-result.js";
import type {
  UserWorkflowRunnerInput,
  WorkflowRuntimeAdapters,
  WorkflowState,
} from "./adapters.js";
import {
  MASTRA_USER_WORKFLOW_RUNNER_ID,
  userWorkflowRunnerInputSchema,
  workflowStateSchema,
} from "./adapters.js";
import { createStepsForGraph } from "./step-factories.js";

const linearizeExecutableNodes = (
  graph: UserWorkflowGraph,
  meta: UserWorkflowRunnerInput["compiledMeta"],
): string[] =>
  meta.stepOrder.filter((nodeId) => {
    const node = graph.nodes.find((n) => n.id === nodeId);
    return node != null && node.type !== "trigger";
  });

export const compileToMastraWorkflow = (
  input: UserWorkflowRunnerInput,
  adapters: WorkflowRuntimeAdapters,
) => {
  const runInput = {
    workflowDefinitionId: input.workflowDefinitionId,
    workflowVersion: input.workflowVersion,
    orgId: input.orgId,
    runId: input.runId,
    triggerType: input.triggerType,
    triggerPayload: input.triggerPayload,
    actorUserId: input.actorUserId,
  };

  const stepsById = createStepsForGraph(input.graph.nodes, adapters, runInput);
  const ordered = linearizeExecutableNodes(input.graph, input.compiledMeta);

  const workflowId = `${MASTRA_USER_WORKFLOW_RUNNER_ID}:${input.workflowDefinitionId}:v${input.workflowVersion}`;

  let workflow = createWorkflow({
    id: workflowId,
    inputSchema: workflowStateSchema,
    outputSchema: workflowStateSchema,
    stateSchema: workflowStateSchema,
  });

  let chained = false;
  for (const nodeId of ordered) {
    const step = stepsById.get(nodeId);
    if (!step) continue;
    workflow = chained ? workflow.then(step) : workflow.then(step);
    chained = true;
  }

  if (!chained) {
    workflow = workflow.then(
      createStep({
        id: "noop-end",
        inputSchema: workflowStateSchema,
        outputSchema: workflowStateSchema,
        execute: async ({ inputData }) => inputData,
      }),
    );
  }

  return workflow.commit();
};

export const compilePublishedGraphForMastra = (
  graph: UserWorkflowGraph,
): CompilePublishedGraphResult => compilePublishedGraph(graph);

export const buildInitialWorkflowState = (
  input: UserWorkflowRunnerInput,
): WorkflowState => ({
  trigger: input.triggerPayload,
  nodes: {},
  org: { id: input.orgId },
  actor: input.actorUserId ? { id: input.actorUserId } : undefined,
});

export const executeCompiledWorkflow = async (
  input: UserWorkflowRunnerInput,
  adapters: WorkflowRuntimeAdapters,
  mastra: {
    addWorkflow: (wf: unknown, key?: string) => void;
    getWorkflow: (id: string) => {
      createRun: (opts: { runId?: string }) => Promise<{
        start: (args: { inputData: WorkflowState }) => Promise<{
          status: string;
          result?: unknown;
          error?: unknown;
        }>;
      }>;
    };
  },
) => {
  const parsed = userWorkflowRunnerInputSchema.parse(input);
  const initialState = buildInitialWorkflowState(parsed);
  const child = compileToMastraWorkflow(parsed, adapters);
  const workflowKey = child.id;
  mastra.addWorkflow(child, workflowKey);
  const wf = mastra.getWorkflow(workflowKey);
  const run = await wf.createRun({ runId: `${parsed.runId}:exec` });
  const result = await run.start({ inputData: initialState });
  const output = {
    ok: result.status === "success",
    state:
      result.status === "success"
        ? ((result.result as WorkflowState | undefined) ?? initialState)
        : initialState,
    error:
      result.status === "failed"
        ? String(result.error ?? "Workflow execution failed")
        : undefined,
  };
  await adapters.hooks?.onRunComplete?.(
  {
    ok: output.ok,
    error: output.error,
  },
  {
    orgId: parsed.orgId,
    workflowDefinitionId: parsed.workflowDefinitionId,
    workflowVersion: parsed.workflowVersion,
    runId: parsed.runId,
    triggerType: parsed.triggerType,
    triggerPayload: parsed.triggerPayload,
    actorUserId: parsed.actorUserId,
  },
  );
  return output;
};

export const createUserWorkflowRunner = (adapters: WorkflowRuntimeAdapters) =>
  createWorkflow({
    id: MASTRA_USER_WORKFLOW_RUNNER_ID,
    inputSchema: userWorkflowRunnerInputSchema,
    outputSchema: z.object({
      ok: z.boolean(),
      state: workflowStateSchema,
      error: z.string().optional(),
    }),
    stateSchema: workflowStateSchema,
  })
    .then(
      createStep({
        id: "run-user-workflow",
        inputSchema: userWorkflowRunnerInputSchema,
        outputSchema: z.object({
          ok: z.boolean(),
          state: workflowStateSchema,
          error: z.string().optional(),
        }),
        execute: async ({ inputData, mastra }) => {
          if (!mastra) {
            throw new Error("Mastra instance required to run user workflows");
          }
          return executeCompiledWorkflow(
            userWorkflowRunnerInputSchema.parse(inputData),
            adapters,
            mastra as Parameters<typeof executeCompiledWorkflow>[2],
          );
        },
      }),
    )
    .commit();
