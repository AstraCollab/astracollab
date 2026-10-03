import { basename } from "node:path";
import { tool, type Tool } from "ai";
import { z } from "zod";
import { formatWorkflowList, type Orchestrator, type WorkflowRegistry, type WorkflowRunResult } from "not-another-harness";
import { WORKSPACE_WORKFLOW_DIR, loadWorkspaceWorkflows, resolveWorkspaceWorkflow } from "./workspace-workflows.js";

type WorkflowToolOptions = {
  orchestrator: Orchestrator;
  registry: WorkflowRegistry;
  /** Where the workspace's own workflow files are read from. */
  cwd: string;
  approve: (toolName: string, input: unknown) => Promise<boolean>;
  /** How a run is rendered back to the model: the answer has to be readable in a tool result. */
  onEvent?: (event: { type: string; stepId?: string; text?: string; error?: Error }) => void;
};

/** A run's result as the model should see it, including which steps ran and what they produced. */
export const formatWorkflowResult = (result: WorkflowRunResult): string => {
  if (result.status === "failed") return `Workflow ${result.workflowId} failed: ${result.error.message}`;
  if (result.status === "suspended") {
    return [
      `Workflow ${result.workflowId} stopped and is waiting on a decision.`,
      `It is paused at: ${result.suspended.join(", ")}`,
      `It is asking: ${JSON.stringify(result.suspendPayload)}`,
      "This run is still open — tell the user what it needs, and do not start a second one to work around it.",
    ].join("\n");
  }
  return [`Workflow ${result.workflowId} completed.`, "", JSON.stringify(result.result, null, 2)].join("\n");
};

/**
 * One tool for the repeatable sequences, rather than one per workflow.
 *
 * A tool per workflow would put the workflows in the schema, where they go stale
 * the moment one is added, and would ask the model to choose between N near-identical
 * tools instead of naming a sequence. One tool with a list of names keeps the choice
 * explicit and lets `createNahWorkflows` change without touching the tool.
 *
 * The names are not baked into the schema either: a workflow written during the
 * session lives in a file that is read when it is asked for, so an enum frozen at
 * startup would exclude the one the model just wrote. `list_workflows` is the roster,
 * and it reads the directory too, so the listing and the name that runs agree.
 *
 * Inputs are a free-form object on purpose: the workflow's own schema validates them,
 * and its validation error names the field and the expectation — which teaches the
 * model the shape of a workflow it has not used before. Validating it here as
 * `z.record(z.unknown())` would pass anything and explain nothing.
 */
export const createWorkflowTools = (options: WorkflowToolOptions): Record<string, Tool> => {
  const runWorkflow = tool({
    description: [
      "Run a repeatable task sequence by name.",
      "Call list_workflows first for the sequences available in this session, and run one of the names it returns.",
      "A workflow runs the same steps in the same order every time, delegating to child agents where judgement is needed, so prefer it over a hand-rolled sequence of tool calls when one of them fits.",
      "Its input is validated by the workflow itself: read its description for what it expects.",
    ].join(" "),
    inputSchema: z.object({
      workflow: z.string().describe("Which sequence to run, as listed by list_workflows."),
      input: z
        .object({})
        .passthrough()
        .optional()
        .describe("Input for the sequence. Pass {} when it takes none; a wrong shape is reported back with what was expected."),
    }),
    execute: async ({ workflow, input }) => {
      const target = await resolveWorkspaceWorkflow({ cwd: options.cwd, registry: options.registry, id: workflow });
      if (!target) return `No workflow named "${workflow}". Call list_workflows for the sequences available in this session.`;

      const approved = await options.approve("run_workflow", { workflow, input: input ?? {} });
      if (!approved) return "The workflow was not started because approval was denied.";

      const result = await options.orchestrator.runWorkflow(target, {
        inputData: (input ?? {}) as never,
        onEvent: options.onEvent as never,
      });
      return formatWorkflowResult(result);
    },
  });

  const listWorkflows = tool({
    description: "List the repeatable sequences that can be run by name, with what each one does.",
    inputSchema: z.object({}),
    execute: async () => {
      const { failed } = await loadWorkspaceWorkflows({ cwd: options.cwd, registry: options.registry });
      const list = formatWorkflowList(options.registry);
      if (failed.length === 0) return list;
      const broken = failed.map(({ file, error }) => `${WORKSPACE_WORKFLOW_DIR}/${basename(file)}: ${error}`).join("\n");
      return `${list}\n\nA workflow file will not load:\n${broken}`;
    },
  });

  return { run_workflow: runWorkflow, list_workflows: listWorkflows };
};
