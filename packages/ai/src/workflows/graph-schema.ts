import { z } from "zod";

import { WORKFLOW_NODE_TYPES } from "./node-types.js";

export const workflowPositionSchema = z.object({
  x: z.number(),
  y: z.number(),
});

export const triggerNodeConfigSchema = z.object({
  triggerType: z.enum(["activity", "manual", "schedule", "webhook"]).default("activity"),
  activityType: z.string().optional(),
  entityType: z.string().optional(),
  filters: z.record(z.string(), z.unknown()).optional(),
  cron: z.string().optional(),
});

export const toolActionNodeConfigSchema = z.object({
  toolId: z.string().min(1),
  inputTemplate: z.record(z.string(), z.unknown()).default({}),
  requireApproval: z.boolean().optional(),
});

export const aiAgentNodeConfigSchema = z.object({
  model: z.string().optional(),
  systemPrompt: z.string().optional(),
  userPromptTemplate: z.string().min(1),
  toolIds: z.array(z.string()).default([]),
  maxSteps: z.number().int().positive().optional(),
  useSandbox: z.boolean().default(false),
});

export const conditionNodeConfigSchema = z.object({
  predicate: z.string().min(1),
  branches: z
    .array(
      z.object({
        id: z.string().min(1),
        label: z.string().optional(),
      }),
    )
    .min(2)
    .max(4),
});

export const delayNodeConfigSchema = z.object({
  mode: z.enum(["duration", "until"]),
  durationMs: z.number().int().nonnegative().optional(),
  untilTemplate: z.string().optional(),
});

export const waitUntilNodeConfigSchema = z.object({
  mode: z.enum(["activity", "predicate", "approval"]),
  activityType: z.string().optional(),
  predicate: z.string().optional(),
  timeoutMs: z.number().int().positive().optional(),
});

export const loopNodeConfigSchema = z.object({
  mode: z.enum(["until", "foreach"]),
  untilPredicate: z.string().optional(),
  foreachPath: z.string().optional(),
  maxIterations: z.number().int().positive().default(100),
});

export const workflowNodeDataSchema = z.object({
  label: z.string().optional(),
  config: z.record(z.string(), z.unknown()).default({}),
});

export const workflowNodeSchema = z.object({
  id: z.string().min(1),
  type: z.enum(WORKFLOW_NODE_TYPES),
  position: workflowPositionSchema,
  data: workflowNodeDataSchema.default({ config: {} }),
});

export const workflowEdgeSchema = z.object({
  id: z.string().min(1),
  source: z.string().min(1),
  target: z.string().min(1),
  sourceHandle: z.string().nullable().optional(),
  targetHandle: z.string().nullable().optional(),
});

export const workflowViewportSchema = z.object({
  x: z.number(),
  y: z.number(),
  zoom: z.number(),
});

export const userWorkflowGraphSchema = z.object({
  nodes: z.array(workflowNodeSchema).min(1),
  edges: z.array(workflowEdgeSchema),
  viewport: workflowViewportSchema.optional(),
});

export type UserWorkflowGraph = z.infer<typeof userWorkflowGraphSchema>;
export type WorkflowNode = z.infer<typeof workflowNodeSchema>;
export type WorkflowEdge = z.infer<typeof workflowEdgeSchema>;
export type TriggerNodeConfig = z.infer<typeof triggerNodeConfigSchema>;
export type ToolActionNodeConfig = z.infer<typeof toolActionNodeConfigSchema>;
export type AiAgentNodeConfig = z.infer<typeof aiAgentNodeConfigSchema>;
