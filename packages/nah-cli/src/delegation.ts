import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import { tool } from "ai";
import { z } from "zod";
import { createCodingTools, runAgent, type HarnessRunResult } from "@astracollab/not-another-harness";
import { createNodeEnvironment } from "@astracollab/not-another-harness/node";
import type { ResolvedModel } from "./model.js";

const execFileAsync = promisify(execFile);
const MAX_CONCURRENT_DELEGATES = 3;
const MAX_PATCH_CHARS = 30_000;

type DelegateToolOptions = {
  cwd: string;
  system: string;
  getModel: () => ResolvedModel["model"];
  approve: (toolName: string, input: unknown) => Promise<boolean>;
  onChildUsage: (usage: HarnessRunResult["usage"]) => void;
};

const runGit = async (cwd: string, args: string[]) => {
  const result = await execFileAsync("git", args, { cwd, maxBuffer: 8 * 1024 * 1024, encoding: "utf8" });
  return { stdout: result.stdout, stderr: result.stderr };
};

export const createDelegationTool = (options: DelegateToolOptions) => {
  let activeDelegates = 0;
  return tool({
    description: [
      "Delegate one independent, bounded coding task to a child agent in a temporary, detached Git worktree.",
      "The child starts from committed HEAD and cannot see uncommitted parent work. Delegate only if the task is independent of those changes. Its changes are never merged automatically.",
      "The result includes the child status, token/step metrics, changed paths, and diff for the parent to review and integrate.",
      "Use only for separable subtasks; do not delegate the whole user request or depend on another child’s unfinished changes.",
    ].join(" "),
    inputSchema: z.object({
      title: z.string().trim().min(3).max(120).describe("Short label for this independent subtask."),
      task: z.string().trim().min(30).max(4000).describe("Specific implementation request, boundaries, and acceptance criteria."),
    }),
    execute: async ({ title, task }) => {
      if (activeDelegates >= MAX_CONCURRENT_DELEGATES) return `Error: at most ${MAX_CONCURRENT_DELEGATES} delegated tasks can run at once.`;
      activeDelegates += 1;
      const worktree = path.join(tmpdir(), `nah-delegate-${randomUUID()}`);
      let repositoryRoot: string | undefined;
      let worktreeCreated = false;
      let retainWorktree = false;
      try {
        const approved = await options.approve("delegate_task", { title, task, isolation: "temporary Git worktree" });
        if (!approved) return "Delegation was not started because approval was denied.";

        repositoryRoot = (await runGit(options.cwd, ["rev-parse", "--show-toplevel"])).stdout.trim();
        const parentStatus = (await runGit(repositoryRoot, ["status", "--porcelain=v1", "-z", "--untracked-files=all"])).stdout;
        const parentChangedPaths = parentStatus.split("\0").filter(Boolean).map((entry) => entry.slice(3));
        const baseRevision = (await runGit(repositoryRoot, ["rev-parse", "HEAD"])).stdout.trim();
        await runGit(repositoryRoot, ["worktree", "add", "--detach", worktree, baseRevision]);
        worktreeCreated = true;

        const childSystem = [
          options.system,
          "\nDelegated subtask boundaries:",
          `- Assignment: ${title}`,
          "- Work only on the assigned subtask and its acceptance criteria.",
          ...(parentChangedPaths.length ? [`- The parent has uncommitted changes in: ${parentChangedPaths.join(", ")}. They are not present here; do not depend on them.`] : []),
          "- This is an isolated worktree. Do not attempt to access or modify the parent worktree.",
          "- Do not commit changes. Inspect and validate your changes when practical, then report what changed and any check results.",
          "- The parent agent will review your diff and decide whether to integrate it.",
        ].join("\n");
        const childTools = createCodingTools(createNodeEnvironment(worktree), { approveToolCall: options.approve });
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(new DOMException("Delegated task timed out", "TimeoutError")), 15 * 60_000);
        const startedAt = Date.now();
        let result: HarnessRunResult | undefined;
        let childFailure: string | undefined;
        let toolCalls = 0;
        try {
          const childRun = runAgent({
            model: options.getModel(),
            system: childSystem,
            prompt: task,
            tools: childTools,
            maxSteps: 20,
            maxTokens: 120_000,
            compactKeepRecent: 6,
            abortSignal: controller.signal,
          });
          const consumeEvents = async () => {
            for await (const event of childRun.events) if (event.type === "tool-call") toolCalls += 1;
          };
          const settled = await Promise.allSettled([childRun.result, consumeEvents()]);
          const runResult = settled[0];
          if (runResult?.status === "fulfilled") {
            result = runResult.value;
            options.onChildUsage(result.usage);
          } else if (runResult?.status === "rejected") {
            childFailure = runResult.reason instanceof Error ? runResult.reason.message : String(runResult.reason);
          }
          const eventResult = settled[1];
          if (eventResult?.status === "rejected") childFailure ??= eventResult.reason instanceof Error ? eventResult.reason.message : String(eventResult.reason);
        } finally {
          clearTimeout(timeout);
        }

        const statusOutput = (await runGit(worktree, ["status", "--porcelain=v1", "--untracked-files=all"])).stdout;
        if (statusOutput.trim()) await runGit(worktree, ["add", "--intent-to-add", "--", "."]);
        const changedPaths = (await runGit(worktree, ["diff", "--name-only", "-z", baseRevision, "--"])).stdout.split("\0").filter(Boolean);
        const diff = (await runGit(worktree, ["diff", "--no-ext-diff", "--no-color", "--no-renames", baseRevision, "--"])).stdout;
        const metrics = result
          ? `status: ${result.reason}; steps: ${result.steps}; tool calls: ${toolCalls}; tokens: ${result.usage.inputTokens} in / ${result.usage.outputTokens} out / ${result.usage.totalTokens} total; estimated usage: ${result.usage.estimated === true}; elapsed: ${Date.now() - startedAt}ms`
          : `status: error; steps: unknown; tool calls: ${toolCalls}; elapsed: ${Date.now() - startedAt}ms; error: ${childFailure ?? "child task failed"}`;
        const patch = diff.length > MAX_PATCH_CHARS
          ? `${diff.slice(0, MAX_PATCH_CHARS)}\n[diff truncated at ${MAX_PATCH_CHARS} characters; full diff remains in ${worktree}. Review it there and remove the worktree when finished.]`
          : diff || "(no changes produced)";
        retainWorktree = diff.length > MAX_PATCH_CHARS;
        return [
          `Delegated task: ${title}`,
          `Base revision: ${baseRevision}`,
          `Parent uncommitted paths: ${parentChangedPaths.length ? parentChangedPaths.join(", ") : "none"}`,
          metrics,
          `Changed paths: ${changedPaths.length ? changedPaths.join(", ") : "none"}`,
          "Review this diff before applying any of it:",
          patch,
          childFailure ? `Child error: ${childFailure}` : "",
          result?.text ? `Child report:\n${result.text.slice(0, 4000)}` : "",
        ].filter(Boolean).join("\n\n");
      } catch (error) {
        return `Delegation failed: ${error instanceof Error ? error.message : String(error)}`;
      } finally {
        if (repositoryRoot && worktreeCreated && !retainWorktree) {
          try { await runGit(repositoryRoot, ["worktree", "remove", "--force", worktree]); }
          catch { /* The primary result includes all available work; cleanup can be retried with git worktree prune. */ }
        }
        activeDelegates -= 1;
      }
    },
  });
};
