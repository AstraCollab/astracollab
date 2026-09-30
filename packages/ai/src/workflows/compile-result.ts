import type { WorkflowNodeType } from "./node-types.js";

export type CompiledStepRef = {
  nodeId: string;
  nodeType: WorkflowNodeType;
  stepId: string;
};

export type CompiledBranch = {
  conditionNodeId: string;
  branches: Array<{
    handleId: string;
    targetNodeId: string;
  }>;
};

export type CompiledParallelRegion = {
  forkNodeId: string;
  joinNodeId: string;
  branchRootNodeIds: string[];
};

export type CompiledLoopRegion = {
  loopNodeId: string;
  bodyEntryNodeId: string;
  bodyExitNodeIds: string[];
};

export type CompiledMeta = {
  compileMode: "native";
  version: 1;
  entryNodeId: string;
  stepOrder: string[];
  steps: CompiledStepRef[];
  branches: CompiledBranch[];
  parallelRegions: CompiledParallelRegion[];
  loopRegions: CompiledLoopRegion[];
  terminalNodeIds: string[];
};

export type CompileResult = {
  ok: true;
  meta: CompiledMeta;
};

export type CompileError = {
  ok: false;
  errors: string[];
};

export type CompilePublishedGraphResult = CompileResult | CompileError;
