import { createStep } from "@mastra/core/workflows";
import { z } from "zod";

import type { WorkflowNode } from "../graph-schema.js";
import {
  aiAgentNodeConfigSchema,
  delayNodeConfigSchema,
  loopNodeConfigSchema,
  toolActionNodeConfigSchema,
  waitUntilNodeConfigSchema,
} from "../graph-schema.js";
import {
  buildVariableContext,
  resolveTemplate,
  resolveTemplateObject,
} from "../variables/index.js";
import type {
  ToolExecutor,
  WorkflowRunContext,
  WorkflowRuntimeAdapters,
  WorkflowState,
} from "./adapters.js";
import { workflowStateSchema } from "./adapters.js";

const readRunContext = (state: WorkflowState, input: {
  workflowDefinitionId: string;
  workflowVersion: number;
  orgId: string;
  runId: string;
  triggerType: string;
  triggerPayload: unknown;
  actorUserId?: string;
}): WorkflowRunContext => ({
  orgId: input.orgId,
  workflowDefinitionId: input.workflowDefinitionId,
  workflowVersion: input.workflowVersion,
  runId: input.runId,
  triggerType: input.triggerType,
  triggerPayload: input.triggerPayload,
  actorUserId: input.actorUserId,
});

const updateNodeOutput = (
  state: WorkflowState,
  nodeId: string,
  output: unknown,
): WorkflowState => ({
  ...state,
  currentNodeId: nodeId,
  nodes: {
    ...state.nodes,
    [nodeId]: output,
  },
});

const defaultEvaluatePredicate = (predicate: string, state: WorkflowState) => {
  if (predicate === "true") return true;
  if (predicate === "false") return false;
  const ctx = buildVariableContext(state);
  const resolved = resolveTemplate(predicate, ctx);
  return resolved === "true" || resolved === "1";
};

export const createWorkflowNodeStep = (
  node: WorkflowNode,
  adapters: WorkflowRuntimeAdapters,
  runInput: {
    workflowDefinitionId: string;
    workflowVersion: number;
    orgId: string;
    runId: string;
    triggerType: string;
    triggerPayload: unknown;
    actorUserId?: string;
  },
) =>
  createStep({
    id: node.id,
    inputSchema: workflowStateSchema,
    outputSchema: workflowStateSchema,
    suspendSchema: z.record(z.string(), z.unknown()).optional(),
    resumeSchema: z.record(z.string(), z.unknown()).optional(),
    execute: async ({ inputData, suspend, resumeData }) => {
      const ctx = readRunContext(inputData, runInput);
      await adapters.hooks?.onNodeStart?.(node.id, ctx);

      let nextState: WorkflowState = { ...inputData, currentNodeId: node.id };

      if (node.type === "trigger") {
        nextState = updateNodeOutput(nextState, node.id, {
          triggerType: runInput.triggerType,
          payload: runInput.triggerPayload,
        });
      }

      if (node.type === "tool_action") {
        const config = toolActionNodeConfigSchema.parse(node.data.config ?? {});
        const tool = adapters.tools[config.toolId] as ToolExecutor | undefined;
        if (!tool) {
          throw new Error(`Unknown tool: ${config.toolId}`);
        }
        const varCtx = buildVariableContext(nextState);
        const resolvedInput = resolveTemplateObject(config.inputTemplate, varCtx);
        const output = await tool(resolvedInput, ctx);
        nextState = updateNodeOutput(nextState, node.id, output);
      }

      if (node.type === "ai_agent") {
        const config = aiAgentNodeConfigSchema.parse(node.data.config ?? {});
        const varCtx = buildVariableContext(nextState);
        const prompt = resolveTemplate(config.userPromptTemplate, varCtx);
        const agent = await adapters.createAgent(config, ctx);
        const response = await agent.generate(prompt, {
          system: config.systemPrompt,
        });
        nextState = updateNodeOutput(nextState, node.id, {
          text: response.text,
        });
      }

      if (node.type === "delay") {
        const config = delayNodeConfigSchema.parse(node.data.config ?? {});
        if (config.mode === "duration" && config.durationMs) {
          await new Promise((resolve) => setTimeout(resolve, config.durationMs));
        }
        nextState = updateNodeOutput(nextState, node.id, { delayed: true });
      }

      if (node.type === "wait_until") {
        const config = waitUntilNodeConfigSchema.parse(node.data.config ?? {});
        if (!resumeData) {
          await adapters.hooks?.onSuspend?.(node.id, config, ctx);
          return suspend({ mode: config.mode, nodeId: node.id });
        }
        nextState = updateNodeOutput(nextState, node.id, { resumed: resumeData });
      }

      if (node.type === "condition") {
        const predicate =
          typeof node.data.config?.predicate === "string"
            ? node.data.config.predicate
            : "true";
        const evaluate = adapters.evaluatePredicate ?? defaultEvaluatePredicate;
        const result = await evaluate(predicate, nextState);
        nextState = updateNodeOutput(nextState, node.id, { result });
      }

      if (node.type === "loop") {
        const config = loopNodeConfigSchema.parse(node.data.config ?? {});
        const evaluate = adapters.evaluatePredicate ?? defaultEvaluatePredicate;
        const done = config.untilPredicate
          ? await evaluate(config.untilPredicate, nextState)
          : false;
        nextState = updateNodeOutput(nextState, node.id, {
          iteration: ((nextState.nodes[node.id] as { iteration?: number })?.iteration ?? 0) + 1,
          done,
        });
      }

      if (node.type === "parallel_fork" || node.type === "parallel_join") {
        nextState = updateNodeOutput(nextState, node.id, { passed: true });
      }

      if (node.type === "end") {
        nextState = updateNodeOutput(nextState, node.id, { finished: true });
      }

      await adapters.hooks?.onNodeComplete?.(node.id, nextState.nodes[node.id], ctx);
      return nextState;
    },
  });

export const createStepsForGraph = (
  nodes: WorkflowNode[],
  adapters: WorkflowRuntimeAdapters,
  runInput: Parameters<typeof createWorkflowNodeStep>[2],
) => {
  const steps = new Map<string, ReturnType<typeof createWorkflowNodeStep>>();
  for (const node of nodes) {
    if (node.type === "trigger") continue;
    steps.set(node.id, createWorkflowNodeStep(node, adapters, runInput));
  }
  return steps;
};
