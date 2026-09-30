import type { UserWorkflowGraph } from "./graph-schema.js";
import { compileGraphMeta, validateGraph } from "./validate-graph.js";
import type { CompilePublishedGraphResult } from "./compile-result.js";

export const compilePublishedGraph = (
  graph: UserWorkflowGraph,
): CompilePublishedGraphResult => {
  const validation = validateGraph(graph);
  if (!validation.ok) {
    return {
      ok: false,
      errors: validation.issues.map(
        (issue) =>
          issue.nodeId
            ? `${issue.message} (${issue.nodeId})`
            : issue.message,
      ),
    };
  }

  return {
    ok: true,
    meta: compileGraphMeta(validation.graph),
  };
};
