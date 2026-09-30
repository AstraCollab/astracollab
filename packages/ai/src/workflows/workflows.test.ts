import { describe, expect, it } from "vitest";

import { compilePublishedGraph } from "./compile-graph.js";
import { isValidWorkflowConnection } from "./connection-rules.js";
import { matchTriggers } from "./triggers/matcher.js";
import { resolveTemplate } from "./variables/resolver.js";
import type { UserWorkflowGraph } from "./graph-schema.js";

const linearGraph: UserWorkflowGraph = {
  nodes: [
    {
      id: "trigger-1",
      type: "trigger",
      position: { x: 0, y: 0 },
      data: { config: { triggerType: "manual" } },
    },
    {
      id: "tool-1",
      type: "tool_action",
      position: { x: 0, y: 100 },
      data: { config: { toolId: "getTicket" } },
    },
    {
      id: "end-1",
      type: "end",
      position: { x: 0, y: 200 },
      data: {},
    },
  ],
  edges: [
    { id: "e1", source: "trigger-1", target: "tool-1" },
    { id: "e2", source: "tool-1", target: "end-1" },
  ],
};

describe("workflows core", () => {
  it("compiles a valid linear graph", () => {
    const result = compilePublishedGraph(linearGraph);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.meta.stepOrder).toEqual(["trigger-1", "tool-1", "end-1"]);
    }
  });

  it("resolves template variables", () => {
    const resolved = resolveTemplate("Ticket {{trigger.ticketId}}", {
      trigger: { ticketId: "abc" },
    });
    expect(resolved).toBe("Ticket abc");
  });

  it("matches activity triggers with filters", () => {
    const matches = matchTriggers(
      {
        orgId: "org-1",
        activityType: "ticket_created",
        entityType: "ticket",
        entityId: "t1",
        projectId: "p1",
      },
      [
        {
          id: "r1",
          workflowId: "wf-1",
          enabled: true,
          activityType: "ticket_created",
          filters: { projectId: "p1" },
        },
      ],
    );
    expect(matches).toHaveLength(1);
  });

  it("rejects invalid connections into trigger", () => {
    const ok = isValidWorkflowConnection(
      linearGraph.nodes,
      linearGraph.edges,
      { source: "tool-1", target: "trigger-1" },
    );
    expect(ok).toBe(false);
  });
});
