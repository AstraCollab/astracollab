import { tool, type Tool } from "ai";
import { z } from "zod";
import {
	createCodingTools,
	createGitWorktreeIsolation,
	formatSubtaskReport,
	Orchestrator,
	OrchestratorBusyError,
	sharedWorkspaceIsolation,
	type HarnessRunResult,
	type OrchestratorEvent,
	type SubtaskIsolation,
} from "not-another-harness";
import { createNodeEnvironment } from "not-another-harness/node";
import type { ResolvedModel } from "./model.js";

const MAX_CONCURRENT_DELEGATES = 3;

/** Enough for a plan's worth of independent work; beyond this the wave starts queueing visibly. */
const MAX_BATCH_DELEGATES = 8;

/**
 * The tools an exploring child gets: everything that reads, plus a shell, and
 * nothing that writes.
 *
 * Named rather than derived from `createCodingTools`, so that adding a new
 * reading tool to the parent does not silently widen what a child that promised
 * to change nothing can do.
 */
const EXPLORE_TOOLS = ["read", "list", "grep", "outline", "glob", "bash"] as const;

/**
 * A child's tool set when it is only looking for an answer.
 *
 * `bash` is in and the editors are out, which is the split Claude Code draws for
 * its own Explore subagent: read-only means Write and Edit are denied, not that
 * the shell is withheld.
 *
 * Withholding the shell was the original design here, on the reasoning that a
 * shell is an escape hatch around the restriction — a read-only child with a
 * shell can `sed -i`. That reasoning is sound and it did not matter: measured
 * against a live model, dropping the shell cost nothing in parent tokens and
 * bought nothing in delegation. A model explaining a claim wants to reproduce
 * it, and a child with no shell cannot, so the parent ran the same commands
 * itself to check — spending exactly the context the delegation was meant to
 * save. The restriction that earned its keep was the one on the editors.
 *
 * So this is not a promise that nothing changes on disk. `bash` can still write,
 * and the explore child shares the parent's workspace rather than taking a
 * worktree, because there is nothing to isolate a question in. Two things narrow
 * it: the shell is created with the same `approveToolCall` gate the parent's own
 * goes through, so every command is shown to the user before it runs, and the
 * harness's inline-script guard still applies on top.
 */
const createExploreTools =
	(cwd: string, approve: (toolName: string, input: unknown) => Promise<boolean>): Record<string, unknown> => {
		const all = createCodingTools(createNodeEnvironment(cwd), { approveToolCall: approve });
		return Object.fromEntries(EXPLORE_TOOLS.filter((name) => all[name]).map((name) => [name, all[name]]));
	};

/**
 * How many steps a child may take before it owes an answer.
 *
 * Claude Code has its parent pass a thoroughness level to Explore for the same
 * reason. Most "where does X do Y" questions are one grep, and spending a child's
 * whole step budget to answer one is how a cheap delegation becomes an expensive
 * one. Making it an explicit field rather than something inferred from how the
 * question is worded puts the call where it belongs — with the parent, which is
 * the only party that knows whether the answer has to survive scrutiny.
 */
const EXPLORE_STEPS = { quick: 8, thorough: 20 } as const;

type ExploreDepth = keyof typeof EXPLORE_STEPS;

/** Enough questions to make a fan-out worthwhile without turning one call into a session. */
const MAX_BATCH_EXPLORES = 6;

type OrchestratorOptions = {
	cwd: string;
	system: string;
	getModel: () => ResolvedModel["model"];
	approve: (toolName: string, input: unknown) => Promise<boolean>;
	onChildUsage: (usage: HarnessRunResult["usage"]) => void;
	/**
	 * Where a child's changes land. Defaults to a git worktree per child, which is
	 * what a session editing a repository wants and what a read-only host has no
	 * use for.
	 */
	isolation?: SubtaskIsolation;
	/**
	 * A child's progress, as it happens.
	 *
	 * Without this every child runs in silence: the first sign one existed is its
	 * finished diff, by which point it is over. A child can spend minutes reading
	 * and editing, and a parent showing nothing across that window reads as a hang
	 * rather than as work.
	 */
	onChildEvent?: ChildEventHandler;
};

/** A delegated child's progress, as the orchestrator reports it. */
export type ChildEventHandler = (event: OrchestratorEvent) => void;

/**
 * The session's one orchestrator, shared by every child.
 *
 * Shared on purpose. An orchestrator owns a concurrency pool and a spend counter,
 * and two of them in one session would mean a workflow fanning out to three
 * children and a `delegate_task` could run six — twice the child budget the
 * session told the user it had, and with no way to see the second pool in
 * `totalUsage`.
 */
export const createSessionOrchestrator = (options: OrchestratorOptions): Orchestrator =>
	new Orchestrator({
		model: options.getModel,
		system: options.system,
		isolation: options.isolation ?? createGitWorktreeIsolation({ cwd: options.cwd }),
		createTools: (cwd) => createCodingTools(createNodeEnvironment(cwd), { approveToolCall: options.approve }),
		maxConcurrency: MAX_CONCURRENT_DELEGATES,
		maxSteps: 20,
		maxTokens: 120_000,
		onUsage: options.onChildUsage,
		onEvent: options.onChildEvent,
	});

type DelegateToolOptions = { orchestrator: Orchestrator; approve: (toolName: string, input: unknown) => Promise<boolean> };

const subtaskSchema = z.object({
	title: z.string().trim().min(3).max(120).describe("Short label for this independent subtask."),
	task: z.string().trim().min(30).max(4000).describe("Specific implementation request, boundaries, and acceptance criteria."),
});

const exploreSchema = z.object({
	title: z.string().trim().min(3).max(120).describe("Short label for this search."),
	question: z
		.string()
		.trim()
		.min(20)
		.max(2000)
		.describe("What the child must find out, and what would make its answer useful to you."),
	depth: z
		.enum(["quick", "thorough"])
		.default("thorough")
		.describe("`quick` when one search would answer it; `thorough` when the answer is spread out and you want it checked."),
});

const WORKTREE_NOTE = "temporary Git worktree";

/**
 * Delegation as a thin shell over the harness orchestrator.
 *
 * The workflow itself — isolated worktree, fresh child transcript, budgeted run,
 * reviewable diff, cleanup — lives in `not-another-harness` now. What stays here
 * is what is specific to the CLI: the tool schemas and the approval gate.
 *
 * Two tools on one orchestrator, because the two situations are different. A plan
 * that decomposes into several independent pieces should be handed over in one
 * call — `delegate_tasks` — so the fan-out is visible as one decision rather than
 * N sequential tool calls that each wait for the last. A single task still gets
 * `delegate_task`, which stays cheap for the common case.
 */
export const createDelegationTools = (options: DelegateToolOptions): Record<string, Tool> => {
	const { orchestrator } = options;

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
			"The child starts from a snapshot of your current working state — including uncommitted and untracked files — so it can build on the work you have already done. It cannot see anything you change after it starts, so delegate only work that does not depend on a later edit. Its changes are never merged automatically.",
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
			"Use this the moment you have a plan whose parts do not depend on each other, rather than delegating them one call at a time and waiting for each to return. Each child starts from the same snapshot of your working state, so no child sees what another changes — every task must stand on its own.",
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

	/**
	 * The read-only half of delegation, and the one that should be reached for
	 * first.
	 *
	 * Claude Code's most-used subagent is `Explore`, and the reason is not that it
	 * is cleverer than the parent — it is that its transcript never enters the
	 * parent's context. Every file a search touches, every page of a log it reads,
	 * every candidate it rules out is spent from a window the parent does not
	 * carry, and the parent gets back the answer. That makes it the cheapest tool
	 * here by a wide margin, and it is cheap for the case that comes up most:
	 * "where does X do Y" before any code is written.
	 *
	 * It also cannot take a worktree, which is why it must be a separate tool
	 * rather than an option on `delegate_task` — there is nothing to isolate a
	 * question in.
	 */

	/**
	 * The child's brief.
	 *
	 * `depth` reaches the child as an instruction rather than only as a step cap,
	 * because a cap alone just truncates a child mid-search: told it may take 8
	 * steps with no idea whether thoroughness was wanted, the useful outcome is
	 * one more truncated report.
	 */
	const exploreTask = (question: string, depth: ExploreDepth): string =>
		[
			question,
			"",
			"You have no edit or write tool, so report what you found rather than trying to change anything.",
			depth === "quick"
				? "This is a targeted lookup: answer from the first place the answer shows up, and do not keep searching for corroboration."
				: "This needs a careful answer: follow the call path, rule out the plausible alternative reading, and verify what you can by running something.",
			"Answer in prose, with file paths and line references for every claim so the reader can check it.",
			"If the answer is that the thing you were asked about does not exist, say that plainly — that is a useful answer, and a confident wrong one is worse than either.",
		].join("\n");

	const exploreSpec = ({ title, question, depth }: z.infer<typeof exploreSchema>) => ({
		title,
		task: exploreTask(question, depth),
		isolation: sharedWorkspaceIsolation(),
		createTools: (cwd: string) => createExploreTools(cwd, options.approve),
		maxSteps: EXPLORE_STEPS[depth],
	});

	const delegateExplore = tool({
		description: [
			"Send a child to answer one question about the codebase, and get back only its answer.",
			"Use this before you start editing anything, and whenever the next step is a search rather than a change: finding where something happens, tracing a call path, checking how a pattern is used elsewhere, listing what a module exposes.",
			"The child reads, searches, and runs commands in your workspace, then returns a summary. None of that work enters your context, so it is far cheaper than doing the same reads yourself, and you can hand it several questions at once with `delegate_explores`.",
			"It has no edit or write tool, so it has no way to change a file on purpose. It does have a shell — it can run tests, scripts, and git to check its own answer — and that shell goes through the same approval prompt as yours, so you see every command before it runs.",
			"Pass depth `quick` when one search would answer it and `thorough` when the answer is spread across files and you want it verified. That is the one knob worth thinking about: a quick child that answers immediately is much cheaper than a thorough one that keeps going.",
			"Prefer this over `delegate_task` whenever the work is finding something out. Reach for `delegate_task` only when the child must actually change files.",
		].join(" "),
		inputSchema: exploreSchema,
		execute: async ({ title, question, depth }) => {
			const approved = await options.approve("delegate_explore", { title, question, depth });
			if (!approved) return "Exploration was not started because approval was denied.";
			try {
				return report([await orchestrator.run(exploreSpec({ title, question, depth }))]);
			} catch (error) {
				if (error instanceof OrchestratorBusyError) return `Error: ${error.message}.`;
				return `Exploration failed: ${error instanceof Error ? error.message : String(error)}`;
			}
		},
	});

	/**
	 * The fan-out `delegate_explore`'s own description used to promise and never
	 * delivered. It told the model it could hand over several questions at once
	 * while offering no way to do it, so the claim read as an instruction to make
	 * N sequential calls — each one waiting for the last, which is the exact shape
	 * delegation exists to avoid, and strictly worse than searching inline.
	 *
	 * Several independent questions are also the case a child is uniquely good at.
	 * One at a time, the child is a subprocess the parent had to remember to use;
	 * three at once, it is a fan-out the parent cannot run as cheaply itself.
	 */
	const delegateExplores = tool({
		description: [
			"Send several independent questions about the codebase to separate children in one call, running concurrently, and get back one answer per question.",
			"Use this the moment a question splits into parts that do not depend on each other — tracing three call paths at once, or checking how a pattern is used in several directories — instead of asking for them one call at a time and waiting for each to return.",
			"Each child reads, searches, and runs commands in your workspace, and none of that work enters your context. Set each question's depth independently: a `quick` child for the part you expect to be one grep, `thorough` for the part you need checked.",
			`Pass at least two questions and at most ${MAX_BATCH_EXPLORES}; at most ${MAX_CONCURRENT_DELEGATES} run at once and longer lists are queued in waves.`,
			"Prefer this over `delegate_explore` when the questions are genuinely independent; a question whose answer depends on another's belongs in a single child.",
		].join(" "),
		inputSchema: z.object({
			questions: z.array(exploreSchema).min(2).max(MAX_BATCH_EXPLORES).describe("The independent questions to answer, each self-contained."),
		}),
		execute: async ({ questions }) => {
			const approved = await options.approve("delegate_explores", {
				count: questions.length,
				depths: questions.map(({ depth }) => depth),
				titles: questions.map(({ title }) => title),
			});
			if (!approved) return "Exploration was not started because approval was denied.";
			return report(await orchestrator.runAll(questions.map(exploreSpec)));
		},
	});

	return {
		delegate_task: delegateTask,
		delegate_tasks: delegateTasks,
		delegate_explore: delegateExplore,
		delegate_explores: delegateExplores,
	};
};