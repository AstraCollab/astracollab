import { z } from "zod";

import type { AiAgentNodeConfig, UserWorkflowGraph } from "../graph-schema.js";
import type { CompiledMeta } from "../compile-result.js";

export type WorkflowRunContext = {
  orgId: string;
  workflowDefinitionId: string;
  workflowVersion: number;
  runId: string;
  triggerType: string;
  triggerPayload: unknown;
  actorUserId?: string;
};

export type ToolExecutor = (
  input: Record<string, unknown>,
  ctx: WorkflowRunContext,
) => Promise<unknown>;

export type AgentLike = {
  generate: (
    prompt: string,
    options?: Record<string, unknown>,
  ) => Promise<{ text: string; [key: string]: unknown }>;
};

export type WorkflowRuntimeAdapters = {
  tools: Record<string, ToolExecutor>;
  createAgent: (
    config: AiAgentNodeConfig,
    ctx: WorkflowRunContext,
  ) => Promise<AgentLike>;
  hooks?: {
    onNodeStart?: (nodeId: string, ctx: WorkflowRunContext) => Promise<void>;
    onNodeComplete?: (
      nodeId: string,
      output: unknown,
      ctx: WorkflowRunContext,
    ) => Promise<void>;
    onSuspend?: (
      nodeId: string,
      payload: unknown,
      ctx: WorkflowRunContext,
    ) => Promise<void>;
    onRunComplete?: (
      result: { ok: boolean; error?: string },
      ctx: WorkflowRunContext,
    ) => Promise<void>;
  };
  evaluatePredicate?: (
    predicate: string,
    state: WorkflowState,
  ) => boolean | Promise<boolean>;
};

export const workflowStateSchema = z.object({
  trigger: z.unknown(),
  nodes: z.record(z.string(), z.unknown()).default({}),
  org: z.unknown().optional(),
  actor: z.unknown().optional(),
  currentNodeId: z.string().optional(),
  suspended: z.boolean().optional(),
});

export type WorkflowState = z.infer<typeof workflowStateSchema>;

export type UserWorkflowRunnerInput = {
  workflowDefinitionId: string;
  workflowVersion: number;
  orgId: string;
  runId: string;
  triggerType: string;
  triggerPayload: unknown;
  graph: UserWorkflowGraph;
  compiledMeta: CompiledMeta;
  actorUserId?: string;
};

export const userWorkflowRunnerInputSchema = z.object({
  workflowDefinitionId: z.string().min(1),
  workflowVersion: z.number().int().positive(),
  orgId: z.string().min(1),
  runId: z.string().min(1),
  triggerType: z.string().min(1),
  triggerPayload: z.unknown(),
  graph: z.custom<UserWorkflowGraph>(),
  compiledMeta: z.custom<CompiledMeta>(),
  actorUserId: z.string().optional(),
});

export const MASTRA_USER_WORKFLOW_RUNNER_ID = "userWorkflowRunner" as const;

export type WorkflowRunnerOutput = {
  ok: boolean;
  state: WorkflowState;
  error?: string;
};
