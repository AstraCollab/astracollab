import { tool, type Tool } from "ai";
import { z } from "zod";
import {
  createCodingTools,
  createGitWorktreeIsolation,
  formatSubtaskReport,
  Orchestrator,
  OrchestratorBusyError,
  type HarnessRunResult,
} from "not-another-harness";
import { createNodeEnvironment } from "not-another-harness/node";
import type { ResolvedModel } from "./model.js";

const MAX_CONCURRENT_DELEGATES = 3;

/** Enough for a plan's worth of independent work; beyond this the wave starts queueing visibly. */
const MAX_BATCH_DELEGATES = 8;

type DelegateToolOptions = {
  cwd: string;
  system: string;
  getModel: () => ResolvedModel["model"];
  approve: (toolName: string, input: unknown) => Promise<boolean>;
  onChildUsage: (usage: HarnessRunResult["usage"]) => void;
};

const subtaskSchema = z.object({
  title: z.string().trim().min(3).max(120).describe("Short label for this independent subtask."),
  task: z.string().trim().min(30).max(4000).describe("Specific implementation request, boundaries, and acceptance criteria."),
});

const WORKTREE_NOTE = "temporary Git worktree";

/**
 * Delegation as a thin shell over the harness orchestrator.
 *
 * The workflow itself — isolated worktree, fresh child transcript, budgeted run,
 * reviewable diff, cleanup — lives in `not-another-harness` now. What stays here
 * is what is specific to the CLI: the tool schemas, the approval gate, and rolling
 * child spend into the session total.
 *
 * Two tools on one orchestrator, because the two situations are different. A plan
 * that decomposes into several independent pieces should be handed over in one
 * call — `delegate_tasks` — so the fan-out is visible as one decision rather than
 * N sequential tool calls that each wait for the last. A single task still gets
 * `delegate_task`, which stays cheap for the common case.
 */
export const createDelegationTools = (options: DelegateToolOptions): Record<string, Tool> => {
  const orchestrator = new Orchestrator({
    model: options.getModel,
    system: options.system,
    isolation: createGitWorktreeIsolation({ cwd: options.cwd }),
    createTools: (cwd) => createCodingTools(createNodeEnvironment(cwd), { approveToolCall: options.approve }),
    maxConcurrency: MAX_CONCURRENT_DELEGATES,
    maxSteps: 20,
    maxTokens: 120_000,
    onUsage: options.onChildUsage,
  });

  /** One child's block verbatim; several get a count line so the parent can see what it fanned out. */
  const report = (results: Awaited<ReturnType<typeof orchestrator.runAll>>): string =>
    [
      results.length > 1 ? `${results.length} delegated subtasks completed. Review each diff before integrating any of them.` : "",
      ...results.map((result) => formatSubtaskReport(result)),
    ]
      .filter(Boolean)
      .join("\n\n");

  const delegateTask = tool({
    description: [
      "Delegate one independent, bounded coding task to a child agent in a temporary, detached Git worktree.",
      "The child starts from committed HEAD and cannot see uncommitted parent work. Delegate only if the task is independent of those changes. Its changes are never merged automatically.",
      "The result includes the child status, token/step metrics, changed paths, and diff for the parent to review and integrate.",
      "Use only for separable subtasks; do not delegate the whole user request or depend on another child’s unfinished changes.",
    ].join(" "),
    inputSchema: subtaskSchema,
    execute: async ({ title, task }) => {
      const approved = await options.approve("delegate_task", { title, task, isolation: WORKTREE_NOTE });
      if (!approved) return "Delegation was not started because approval was denied.";
      try {
        return report([await orchestrator.run({ title, task })]);
      } catch (error) {
        if (error instanceof OrchestratorBusyError) return `Error: ${error.message}.`;
        return `Delegation failed: ${error instanceof Error ? error.message : String(error)}`;
      }
    },
  });

  const delegateTasks = tool({
    description: [
      "Delegate a whole plan at once: pass every independent, bounded subtask of it and they run concurrently as separate child agents, each in its own temporary, detached Git worktree.",
      "Use this the moment you have a plan whose parts do not depend on each other, rather than delegating them one call at a time and waiting for each to return. Children share no history and cannot see uncommitted parent work, so each task must stand on its own.",
      `At most ${MAX_CONCURRENT_DELEGATES} children run at once; longer lists are run in waves. Every child's diff comes back for you to review and integrate — nothing is merged automatically.`,
    ].join(" "),
    inputSchema: z.object({
      tasks: z.array(subtaskSchema).min(2).max(MAX_BATCH_DELEGATES).describe("The independent subtasks of your plan, each self-contained."),
    }),
    execute: async ({ tasks }) => {
      const approved = await options.approve("delegate_tasks", {
        isolation: WORKTREE_NOTE,
        count: tasks.length,
        titles: tasks.map(({ title }) => title),
      });
      if (!approved) return "Delegation was not started because approval was denied.";
      return report(await orchestrator.runAll(tasks));
    },
  });

  return { delegate_task: delegateTask, delegate_tasks: delegateTasks };
};