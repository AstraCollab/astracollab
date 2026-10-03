import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import { createStep, createWorkflow, createWorkflowRegistry, type WorkflowRegistry, type WorkflowStepDelegate } from "not-another-harness";
const execFileAsync = promisify(execFile);

/** Git here is fact-gathering, not judgement, so it runs inline with a ceiling. */
const GIT_TIMEOUT_MS = 15_000;

/** How many files one reviewing child is given; past this it summarises instead of reviewing. */
const FILES_PER_REVIEW = 8;

/** Longest a package script gets before it is reported as unfinished rather than waited on forever. */
const SCRIPT_TIMEOUT_MS = 5 * 60_000;

const MAX_REVIEW_CHARS = 4_000;

const truncate = (text: string, limit = MAX_REVIEW_CHARS): string =>
  text.length > limit ? `${text.slice(0, limit)}\n[truncated at ${limit} characters]` : text;

const run = async (cwd: string, command: string, args: string[], timeoutMs = GIT_TIMEOUT_MS): Promise<string> => {
  const { stdout } = await execFileAsync(command, args, { cwd, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, encoding: "utf8" });
  return stdout;
};

/** Git's "not a repository" is a fact about the workspace, not a failed step. */
const notARepository = (error: unknown): boolean => (error as { code?: number })?.code === 128;

const lines = (output: string): string[] => output.split("\n").map((line) => line.trim()).filter(Boolean);

/** A reviewer's verdict, with the file list it covers so the merge needs no bookkeeping. */
const reviewSchema = z.object({ files: z.array(z.string()), report: z.string() });

export type NahWorkflowOptions = { cwd: string };

/**
 * The sequences nah runs the same way every time.
 *
 * Each one is here because the order is knowable in advance and the only thing that
 * varies is the repository. A review that collects the changed files, groups them,
 * sends each group at a fresh child, and merges the answers was being redone —
 * slightly differently — on every request. As a workflow it runs identically every
 * time, and the model's job shrinks from "remember what reviewing involves" to
 * "review this".
 *
 * The gathering steps run Git and read `package.json` themselves rather than
 * delegating. Asking a child agent to run `git diff --name-only` spends a model call
 * to obtain a string the shell already knows, and can get it wrong in a way that
 * only surfaces as a mysteriously empty review.
 */
export const createNahWorkflows = (options: NahWorkflowOptions): WorkflowRegistry => {
  const { cwd } = options;

  const collectChanges = createStep({
    id: "collect-changes",
    description: "List the files that differ from a base, plus the untracked ones.",
    outputSchema: z.object({ base: z.string(), files: z.array(z.string()), untracked: z.array(z.string()) }),
    execute: async ({ inputData }) => {
      const base = (inputData as { base?: string }).base ?? "HEAD";
      try {
        const committed = lines(await run(cwd, "git", ["diff", "--name-only", `${base}...HEAD`]));
        const staged = lines(await run(cwd, "git", ["diff", "--name-only", "--cached"]));
        const status = await run(cwd, "git", ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
        const untracked = status.split("\0").filter(Boolean).filter((entry) => entry.startsWith("??")).map((entry) => entry.slice(3));
        return { base, files: [...new Set([...committed, ...staged])], untracked };
      } catch (error) {
        if (notARepository(error)) return { base, files: [], untracked: [] };
        throw error;
      }
    },
  });

  const planReview = createStep({
    id: "plan-review",
    description: "Group the files into batches small enough for one child to actually read.",
    outputSchema: z.object({ batches: z.array(z.array(z.string())), skipped: z.array(z.string()) }),
    execute: async ({ inputData, context }) => {
      const { files, untracked } = inputData as { files: string[]; untracked: string[] };
      const requested = (context as { reviewPaths?: string[] }).reviewPaths;
      const wanted = requested?.length ? files.filter((file) => requested.some((path) => file.includes(path))) : files;
      const skipped = files.filter((file) => !wanted.includes(file));
      const batches: string[][] = [];
      // Untracked files are reviewed too, but never displace a tracked change: a
      // repository full of new untracked files should not hide the edit in review.
      for (const file of [...wanted, ...untracked]) {
        const last = batches.at(-1);
        if (last && last.length < FILES_PER_REVIEW) last.push(file);
        else batches.push([file]);
      }
      return { batches, skipped };
    },
  });

  const reviewBatch = createStep({
    id: "review-batch",
    description: "One child reviews one group of files and reports findings. Edits nothing.",
    inputSchema: z.array(z.string()),
    outputSchema: reviewSchema,
    execute: async ({ inputData, context, signal }) => {
      const files = inputData as string[];
      const { delegate } = context as unknown as WorkflowStepDelegate;
      const result = await delegate({
        title: `review ${files.length} file${files.length === 1 ? "" : "s"}`,
        task: [
          `Review these changed files for correctness bugs, broken assumptions, and missing tests: ${files.join(", ")}.`,
          "Read each one and its immediate callers before judging it. Do not edit anything and do not fix what you find.",
          "Report findings as a short list, most severe first, each with the file and the reason. If the code is sound, say so plainly rather than inventing something to report.",
        ].join(" "),
        signal,
      });
      return { files, report: truncate(result.text.trim() || "(the reviewer returned no report)") };
    },
  });

  const mergeReviews = createStep({
    id: "merge-reviews",
    description: "Combine the per-batch reports into one review, keeping the file each came from.",
    outputSchema: z.object({ reviewed: z.number(), files: z.number(), report: z.string() }),
    execute: async ({ inputData }) => {
      const { reviews, skipped } = inputData as { reviews: Array<{ files: string[]; report: string }>; skipped: string[] };
      const sections = reviews.map(({ files, report }) => `### ${files.join(", ")}\n\n${report}`);
      if (skipped.length > 0) sections.push(`### not reviewed\n\n${skipped.join("\n")}`);
      return {
        reviewed: reviews.length,
        files: reviews.reduce((total, review) => total + review.files.length, 0),
        report: sections.join("\n\n") || "There is nothing to review: no files differ from the base and nothing is untracked.",
      };
    },
  });

  const reviewChanges = createWorkflow({
    id: "review-changes",
    description: "Review what changed since a base, one child per group of files, then merge the findings.",
    inputSchema: z.object({
      base: z.string().optional().describe("Git ref to review against. Defaults to HEAD, which reviews staged and uncommitted work."),
      reviewPaths: z.array(z.string()).optional().describe("Only review files whose path contains one of these."),
    }),
    outputSchema: z.object({ reviewed: z.number(), files: z.number(), report: z.string() }),
  })
    .then(collectChanges)
    .then(planReview)
    .map({ inputKey: "batches", outputKey: "reviews", mapper: (files: string[]) => reviewBatch })
    .then(mergeReviews)
    .commit();

  const collectChecks = createStep({
    id: "collect-checks",
    description: "Find the workspace's own verification scripts, so the workflow runs what the project runs.",
    outputSchema: z.object({ packageManager: z.string(), scripts: z.array(z.string()) }),
    execute: async () => {
      const defined = async (file: string): Promise<boolean> => {
        try {
          await run(cwd, "git", ["ls-files", "--error-unmatch", file]);
          return true;
        } catch {
          return false;
        }
      };
      const packageManager = (await defined("pnpm-lock.yaml")) ? "pnpm" : (await defined("yarn.lock")) ? "yarn" : (await defined("package-lock.json")) ? "npm" : "npm";
      // Only run scripts the workspace actually defines. A workflow that invoked a
      // missing script would report a failure the project never claimed to have.
      let scripts: string[] = [];
      try {
        const manifest = JSON.parse(await readFile(join(cwd, "package.json"), "utf8")) as { scripts?: Record<string, string> };
        scripts = ["typecheck", "lint", "test", "build"].filter((script) => manifest.scripts?.[script]);
      } catch {
        scripts = [];
      }
      return { packageManager, scripts };
    },
  });

  const runCheck = (script: string) =>
    createStep({
      id: `run-${script}`,
      description: `Run the workspace's ${script} script.`,
      inputSchema: z.object({ packageManager: z.string(), scripts: z.array(z.string()) }),
      outputSchema: z.object({ script: z.string(), ran: z.boolean(), ok: z.boolean(), summary: z.string() }),
      execute: async ({ inputData, signal }) => {
        const { packageManager, scripts } = inputData as { packageManager: string; scripts: string[] };
        if (!scripts.includes(script)) return { script, ran: false, ok: true, summary: "not defined in this workspace" };
        try {
          const output = await run(cwd, packageManager, ["run", script], SCRIPT_TIMEOUT_MS);
          const tail = lines(output).slice(-5).join("\n");
          return { script, ran: true, ok: true, summary: truncate(tail, 500) || "passed" };
        } catch (error) {
          // A killed script timed out; that is a failure of the check, but the
          // abort is the caller's and must still win over our own report.
          signal?.throwIfAborted();
          const failure = error as { stdout?: string; stderr?: string; message?: string };
          const output = `${failure.stdout ?? ""}\n${failure.stderr ?? ""}`.trim();
          return { script, ran: true, ok: false, summary: truncate(output || failure.message || "failed", 800) };
        }
      },
    });

  const verdict = createStep({
    id: "verdict",
    description: "State which checks failed and what the output was.",
    outputSchema: z.object({ clean: z.boolean(), failed: z.array(z.string()), skipped: z.array(z.string()), report: z.string() }),
    execute: async ({ inputData }) => {
      const checks = inputData as Array<{ script: string; ran: boolean; ok: boolean; summary: string }>;
      const failed = checks.filter((check) => check.ran && !check.ok).map((check) => check.script);
      const skipped = checks.filter((check) => !check.ran).map((check) => check.script);
      // A check that never ran is not a pass. Reporting it as one is how a
      // workspace with no tests ends up looking verified.
      const report = checks
        .map((check) => `${check.ran ? (check.ok ? "pass" : "FAIL") : "skip"}  ${check.script}${check.ran && check.summary ? `\n${check.summary}` : ""}`)
        .join("\n\n");
      return {
        clean: failed.length === 0,
        failed,
        skipped,
        report: report || "this workspace defines no verification scripts",
      };
    },
  });

  const shipCheck = createWorkflow({
    id: "ship-check",
    description: "Run the workspace's own typecheck, lint, test and build scripts in parallel and report what failed.",
    // Defaulted rather than required: this sequence genuinely takes no input, and
    // `/workflow ship-check` should not have to invent a `{}` to get one run.
    inputSchema: z.object({}).default({}).describe("Takes no input; pass {} if you like."),
    outputSchema: z.object({ clean: z.boolean(), failed: z.array(z.string()), skipped: z.array(z.string()), report: z.string() }),
  })
    .then(collectChecks)
    .parallel([[runCheck("typecheck")], [runCheck("lint")], [runCheck("test")]])
    .then(verdict)
    .commit();

  return createWorkflowRegistry({ "review-changes": reviewChanges, "ship-check": shipCheck });
};
