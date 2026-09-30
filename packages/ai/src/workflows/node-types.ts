/** Canvas node kinds — each maps to a Mastra construct when compiled natively. */
export const WORKFLOW_NODE_TYPES = [
  "trigger",
  "tool_action",
  "ai_agent",
  "condition",
  "parallel_fork",
  "parallel_join",
  "loop",
  "delay",
  "wait_until",
  "end",
] as const;

export type WorkflowNodeType = (typeof WORKFLOW_NODE_TYPES)[number];

export type WorkflowNodePaletteCategory =
  | "triggers"
  | "tickets"
  | "projects"
  | "storage"
  | "messaging"
  | "ai"
  | "flow";

export type WorkflowNodePaletteMeta = {
  category: WorkflowNodePaletteCategory;
  label: string;
  description?: string;
  icon?: string;
};

export const WORKFLOW_NODE_PALETTE: Record<
  WorkflowNodeType,
  WorkflowNodePaletteMeta
> = {
  trigger: {
    category: "triggers",
    label: "Trigger",
    description: "When an activity event occurs",
  },
  tool_action: {
    category: "tickets",
    label: "Workspace action",
    description: "Run a workspace tool (ticket, file, message, …)",
  },
  ai_agent: {
    category: "ai",
    label: "AI agent",
    description: "LLM step with optional tools",
  },
  condition: {
    category: "flow",
    label: "Condition",
    description: "Branch on a predicate",
  },
  parallel_fork: {
    category: "flow",
    label: "Parallel fork",
    description: "Run branches in parallel",
  },
  parallel_join: {
    category: "flow",
    label: "Parallel join",
    description: "Wait for all parallel branches",
  },
  loop: {
    category: "flow",
    label: "Loop",
    description: "Repeat until a condition is met",
  },
  delay: {
    category: "flow",
    label: "Delay",
    description: "Wait for a duration or until a time",
  },
  wait_until: {
    category: "flow",
    label: "Wait until",
    description: "Pause until an event or approval",
  },
  end: {
    category: "flow",
    label: "End",
    description: "Finish the automation",
  },
};

export const isWorkflowNodeType = (value: string): value is WorkflowNodeType =>
  (WORKFLOW_NODE_TYPES as readonly string[]).includes(value);
