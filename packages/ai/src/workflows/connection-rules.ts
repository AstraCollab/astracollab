import type { WorkflowEdge, WorkflowNode } from "./graph-schema.js";
import type { WorkflowNodeType } from "./node-types.js";

export type ConnectionCandidate = {
  source: string;
  target: string;
  sourceHandle?: string | null;
  targetHandle?: string | null;
};

const MAX_OUT: Partial<Record<WorkflowNodeType, number>> = {
  trigger: 1,
  tool_action: 1,
  ai_agent: 1,
  delay: 1,
  wait_until: 1,
  loop: 1,
  parallel_fork: 8,
  condition: 4,
  end: 0,
};

const MAX_IN: Partial<Record<WorkflowNodeType, number>> = {
  trigger: 0,
  parallel_join: 8,
  end: 8,
};

const defaultMaxIn = 1;

export const isValidWorkflowConnection = (
  nodes: WorkflowNode[],
  edges: WorkflowEdge[],
  connection: ConnectionCandidate,
): boolean => {
  const nodesById = new Map(nodes.map((node) => [node.id, node]));
  const source = nodesById.get(connection.source);
  const target = nodesById.get(connection.target);
  if (!source || !target) return false;
  if (source.id === target.id) return false;
  if (target.type === "trigger") return false;
  if (source.type === "end") return false;

  const incomingToTarget = edges.filter((edge) => edge.target === target.id);
  const maxIn = MAX_IN[target.type] ?? defaultMaxIn;
  if (incomingToTarget.length >= maxIn) return false;

  const outgoingFromSource = edges.filter((edge) => edge.source === source.id);
  const maxOut = MAX_OUT[source.type];
  if (maxOut !== undefined && outgoingFromSource.length >= maxOut) return false;

  if (source.type === "parallel_fork" && target.type === "parallel_join") {
    return false;
  }

  return true;
};
