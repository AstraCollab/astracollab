import type { UserWorkflowGraph, WorkflowEdge, WorkflowNode } from "./graph-schema.js";
import type { WorkflowNodeType } from "./node-types.js";
import type { CompiledMeta, CompiledParallelRegion } from "./compile-result.js";

export type GraphValidationIssue = {
  code: string;
  message: string;
  nodeId?: string;
  edgeId?: string;
};

export type GraphValidationResult =
  | { ok: true; graph: UserWorkflowGraph }
  | { ok: false; issues: GraphValidationIssue[] };

const SINGLE_IN_TYPES = new Set<WorkflowNodeType>([
  "trigger",
  "tool_action",
  "ai_agent",
  "condition",
  "parallel_fork",
  "loop",
  "delay",
  "wait_until",
  "end",
]);

const buildAdjacency = (edges: WorkflowEdge[]) => {
  const outgoing = new Map<string, WorkflowEdge[]>();
  const incoming = new Map<string, WorkflowEdge[]>();
  for (const edge of edges) {
    outgoing.set(edge.source, [...(outgoing.get(edge.source) ?? []), edge]);
    incoming.set(edge.target, [...(incoming.get(edge.target) ?? []), edge]);
  }
  return { outgoing, incoming };
};

const collectReachable = (
  startId: string,
  outgoing: Map<string, WorkflowEdge[]>,
): Set<string> => {
  const seen = new Set<string>();
  const queue = [startId];
  while (queue.length > 0) {
    const id = queue.shift();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    for (const edge of outgoing.get(id) ?? []) {
      queue.push(edge.target);
    }
  }
  return seen;
};

const hasCycle = (
  startId: string,
  outgoing: Map<string, WorkflowEdge[]>,
  allowedBackEdgeTargets: Set<string>,
): boolean => {
  const visiting = new Set<string>();
  const visited = new Set<string>();

  const dfs = (nodeId: string): boolean => {
    if (visiting.has(nodeId)) return !allowedBackEdgeTargets.has(nodeId);
    if (visited.has(nodeId)) return false;
    visiting.add(nodeId);
    for (const edge of outgoing.get(nodeId) ?? []) {
      if (dfs(edge.target)) return true;
    }
    visiting.delete(nodeId);
    visited.add(nodeId);
    return false;
  };

  return dfs(startId);
};

export const validateGraph = (graph: UserWorkflowGraph): GraphValidationResult => {
  const issues: GraphValidationIssue[] = [];
  const nodesById = new Map<string, WorkflowNode>(
    graph.nodes.map((node) => [node.id, node]),
  );

  const triggers = graph.nodes.filter((node) => node.type === "trigger");
  if (triggers.length !== 1) {
    issues.push({
      code: "trigger_count",
      message: "Workflow must have exactly one trigger node",
    });
  }

  const trigger = triggers[0];
  const { outgoing, incoming } = buildAdjacency(graph.edges);

  for (const node of graph.nodes) {
    const inCount = incoming.get(node.id)?.length ?? 0;
    const outCount = outgoing.get(node.id)?.length ?? 0;

    if (node.type === "trigger" && inCount > 0) {
      issues.push({
        code: "trigger_incoming",
        message: "Trigger cannot have incoming edges",
        nodeId: node.id,
      });
    }

    if (node.type === "end" && outCount > 0) {
      issues.push({
        code: "end_outgoing",
        message: "End node cannot have outgoing edges",
        nodeId: node.id,
      });
    }

    if (node.type === "parallel_join") {
      if (inCount < 2) {
        issues.push({
          code: "join_inputs",
          message: "Parallel join requires at least two incoming edges",
          nodeId: node.id,
        });
      }
    } else if (SINGLE_IN_TYPES.has(node.type) && node.type !== "trigger" && inCount > 1) {
      issues.push({
        code: "multiple_incoming",
        message: `${node.type} allows at most one incoming edge`,
        nodeId: node.id,
      });
    }

    if (node.type === "condition") {
      if (outCount < 2 || outCount > 4) {
        issues.push({
          code: "condition_branches",
          message: "Condition must have 2–4 outgoing edges",
          nodeId: node.id,
        });
      }
    }

    if (node.type === "parallel_fork" && outCount < 2) {
      issues.push({
        code: "fork_outputs",
        message: "Parallel fork requires at least two outgoing edges",
        nodeId: node.id,
      });
    }
  }

  for (const edge of graph.edges) {
    if (!nodesById.has(edge.source) || !nodesById.has(edge.target)) {
      issues.push({
        code: "dangling_edge",
        message: "Edge references a missing node",
        edgeId: edge.id,
      });
    }
  }

  const forkNodes = graph.nodes.filter((node) => node.type === "parallel_fork");
  const joinNodes = graph.nodes.filter((node) => node.type === "parallel_join");
  if (forkNodes.length !== joinNodes.length) {
    issues.push({
      code: "fork_join_balance",
      message: "Each parallel fork must have a matching parallel join",
    });
  }

  if (trigger) {
    const reachable = collectReachable(trigger.id, outgoing);
    for (const node of graph.nodes) {
      if (!reachable.has(node.id)) {
        issues.push({
          code: "orphan_node",
          message: "Node is not reachable from trigger",
          nodeId: node.id,
        });
      }
    }

    const loopNodes = new Set<string>(
      graph.nodes.filter((node) => node.type === "loop").map((node) => node.id),
    );
    if (hasCycle(trigger.id, outgoing, loopNodes)) {
      issues.push({
        code: "invalid_cycle",
        message: "Graph contains a cycle outside of a loop region",
      });
    }
  }

  const ends = graph.nodes.filter((node) => node.type === "end");
  if (ends.length === 0) {
    issues.push({
      code: "missing_end",
      message: "Workflow must include at least one end node",
    });
  }

  if (issues.length > 0) {
    return { ok: false, issues };
  }

  return { ok: true, graph };
};

export const compileGraphMeta = (graph: UserWorkflowGraph): CompiledMeta => {
  const validated = validateGraph(graph);
  if (!validated.ok) {
    throw new Error(
      validated.issues.map((issue) => issue.message).join("; "),
    );
  }

  const { outgoing, incoming } = buildAdjacency(graph.edges);
  const trigger = graph.nodes.find((node) => node.type === "trigger");
  if (!trigger) {
    throw new Error("Missing trigger node");
  }

  const stepOrder: string[] = [];
  const visited = new Set<string>();
  const queue = [trigger.id];

  while (queue.length > 0) {
    const nodeId = queue.shift();
    if (!nodeId || visited.has(nodeId)) continue;
    visited.add(nodeId);
    stepOrder.push(nodeId);
    for (const edge of outgoing.get(nodeId) ?? []) {
      queue.push(edge.target);
    }
  }

  const steps = graph.nodes.map((node) => ({
    nodeId: node.id,
    nodeType: node.type,
    stepId: node.id,
  }));

  const branches = graph.nodes
    .filter((node) => node.type === "condition")
    .map((node) => ({
      conditionNodeId: node.id,
      branches: (outgoing.get(node.id) ?? []).map((edge) => ({
        handleId: edge.sourceHandle ?? "default",
        targetNodeId: edge.target,
      })),
    }));

  const parallelRegions: CompiledParallelRegion[] = [];
  for (const fork of graph.nodes.filter((node) => node.type === "parallel_fork")) {
    const branchRoots = (outgoing.get(fork.id) ?? []).map((edge) => edge.target);
    const join = graph.nodes.find(
      (node) =>
        node.type === "parallel_join" &&
        branchRoots.every((rootId) => {
          const reachable = collectReachable(rootId, outgoing);
          return reachable.has(node.id);
        }),
    );
    if (join) {
      parallelRegions.push({
        forkNodeId: fork.id,
        joinNodeId: join.id,
        branchRootNodeIds: branchRoots,
      });
    }
  }

  const loopRegions = graph.nodes
    .filter((node) => node.type === "loop")
    .map((node) => {
      const bodyEntry = (outgoing.get(node.id) ?? [])[0]?.target;
      return {
        loopNodeId: node.id,
        bodyEntryNodeId: bodyEntry ?? node.id,
        bodyExitNodeIds: (incoming.get(node.id) ?? []).map((edge) => edge.source),
      };
    });

  return {
    compileMode: "native",
    version: 1,
    entryNodeId: trigger.id,
    stepOrder,
    steps,
    branches,
    parallelRegions,
    loopRegions,
    terminalNodeIds: graph.nodes.filter((node) => node.type === "end").map((n) => n.id),
  };
};
