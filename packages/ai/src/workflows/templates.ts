import type { UserWorkflowGraph } from "./graph-schema.js";

export type WorkflowTemplate = {
  id: string;
  name: string;
  description: string;
  graph: UserWorkflowGraph;
};

export const WORKFLOW_TEMPLATES: WorkflowTemplate[] = [
  {
    id: "ticket-created-triage",
    name: "Ticket created → AI triage",
    description: "When a ticket is created, run an AI agent to summarize and suggest priority.",
    graph: {
      nodes: [
        {
          id: "trigger-1",
          type: "trigger",
          position: { x: 0, y: 0 },
          data: {
            label: "Ticket created",
            config: {
              triggerType: "activity",
              activityType: "ticket_created",
              entityType: "ticket",
            },
          },
        },
        {
          id: "ai-1",
          type: "ai_agent",
          position: { x: 0, y: 120 },
          data: {
            label: "Triage with AI",
            config: {
              userPromptTemplate:
                "Triage ticket {{trigger.ticketId}} in project {{trigger.projectId}}. Summarize and suggest priority.",
              toolIds: ["getTicket", "updateTicket"],
            },
          },
        },
        {
          id: "end-1",
          type: "end",
          position: { x: 0, y: 240 },
          data: { label: "Done", config: {} },
        },
      ],
      edges: [
        { id: "e1", source: "trigger-1", target: "ai-1" },
        { id: "e2", source: "ai-1", target: "end-1" },
      ],
    },
  },
  {
    id: "file-upload-notify",
    name: "File uploaded → notify",
    description: "When a file is uploaded, post an activity update.",
    graph: {
      nodes: [
        {
          id: "trigger-1",
          type: "trigger",
          position: { x: 0, y: 0 },
          data: {
            label: "File uploaded",
            config: {
              triggerType: "activity",
              activityType: "file_created",
              entityType: "file",
            },
          },
        },
        {
          id: "tool-1",
          type: "tool_action",
          position: { x: 0, y: 120 },
          data: {
            label: "Insert activity",
            config: {
              toolId: "insertActivityItem",
              inputTemplate: {
                activityType: "automation_file_processed",
                entityType: "file",
                entityId: "{{trigger.entityId}}",
              },
            },
          },
        },
        {
          id: "end-1",
          type: "end",
          position: { x: 0, y: 240 },
          data: { label: "Done", config: {} },
        },
      ],
      edges: [
        { id: "e1", source: "trigger-1", target: "tool-1" },
        { id: "e2", source: "tool-1", target: "end-1" },
      ],
    },
  },
];

export const getWorkflowTemplate = (id: string): WorkflowTemplate | undefined =>
  WORKFLOW_TEMPLATES.find((template) => template.id === id);
