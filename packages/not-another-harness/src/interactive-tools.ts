import { tool, type ModelMessage, type Tool } from "ai";
import { z } from "zod";

import type { ToolCallScope } from "./types.js";

/**
 * The two interactive built-ins: `ask_user` and `submit_plan`.
 *
 * ## These are framework built-ins, not client policy
 *
 * Mastra injects six of them into an `AgentController` automatically. Only two are
 * reproduced here, because only two are the agent's own conversation with a person:
 * the other four (`task_write`, `task_update`, `task_complete`, `task_check`) are a
 * todo-list mechanism that belongs to a different product — a coding harness, not
 * this one. Reproducing all six would put one customer's task model in a published
 * package.
 *
 * ## The contract both tools share
 *
 * Suspend by throwing; re-run stateless on resume. A suspended tool:
 *
 * 1. returns the answer if {@link ToolCallScope.resumeData} is present;
 * 2. otherwise calls `suspend(payload)` and never returns;
 * 3. does **no work before suspending**, because that work runs twice.
 *
 * That third point is the whole discipline of the pattern and the easiest thing to get
 * wrong. A tool that writes a file and *then* asks a question writes it on every
 * resume.
 *
 * ## Why the contracts are copied rather than reinvented
 *
 * The input schemas, the resume shapes, and the three `submit_plan` return strings
 * are Mastra's, verbatim where it matters. A client migrating off Mastra has a UI and
 * a resume path written against them; a "cleaner" contract would be a second migration
 * with no benefit. Where Mastra's own code has a wart worth avoiding, it is noted.
 */

const optionSchema = z.object({
	label: z.string(),
	description: z.string().optional(),
});

export type AskUserOption = z.infer<typeof optionSchema>;
export type AskUserSelectionMode = "single_select" | "multi_select";
export type AskUserAnswer = string | string[];

export type AskUserInput = {
	question: string;
	options?: AskUserOption[];
	selectionMode?: AskUserSelectionMode;
};

const formatAnswer = (answer: AskUserAnswer): string =>
	Array.isArray(answer) ? answer.join(", ") : answer;

/**
 * Ask the user a question and wait for their answer.
 *
 * Three prompt shapes, matching Mastra: no `options` is free text; `options` without
 * a `selectionMode` is single-select; `selectionMode: "multi_select"` resumes with an
 * array of labels.
 *
 * The `selectionMode` without `options` case is rejected rather than ignored, because
 * a host asked to multi-select from nothing has to render something, and silently
 * falling back to free text would answer a different question than the model asked.
 */
export const createAskUserTool = (): Tool<AskUserInput, string> =>
	tool({
		description:
			"Ask the user a question and wait for their answer. Use when the request is ambiguous, a required choice is missing, or proceeding on a guess would waste real work. Prefer acting on a reasonable assumption when one is cheap to reverse.",
		inputSchema: z.object({
			question: z.string().min(1),
			options: z.array(optionSchema).optional(),
			selectionMode: z.enum(["single_select", "multi_select"]).optional(),
		}),
		execute: async (input, ctx) => {
			const scope = ctx as unknown as ToolCallScope;
			const { question, options, selectionMode } = input;

			if (selectionMode && !options?.length) {
				return "Failed to ask user: selectionMode requires options.";
			}
			const resolvedMode = options?.length ? (selectionMode ?? "single_select") : undefined;

			// Resume. Checked before anything else so a re-run cannot re-suspend.
			const { resumeData } = scope;
			if (resumeData !== undefined) {
				return `User answered: ${formatAnswer(resumeData as AskUserAnswer)}`;
			}

			// No agent context at all — a direct call outside a run. Surface the question
			// as readable text rather than throwing, so a caller gets the question out
			// of a tool it invoked by hand.
			if (!scope.suspend) {
				const choices = options?.length
					? `\nOptions: ${options.map((o) => o.label).join(", ")}`
					: "";
				const mode = resolvedMode ? `\nSelection mode: ${resolvedMode}` : "";
				return `[Question for user]: ${question}${choices}${mode}`;
			}

			scope.suspend({
				question,
				...(options ? { options } : {}),
				...(resolvedMode ? { selectionMode: resolvedMode } : {}),
			});
			// Unreachable: `suspend` is typed `never`. Present so the contract is explicit
			// rather than inferred.
			return "";
		},
	}) as Tool<AskUserInput, string>;

export type SubmitPlanInput = { path: string };
export type SubmitPlanResumeData = {
	action: "approved" | "rejected";
	feedback?: string;
};

/**
 * Submit an implementation plan for review, and wait for a verdict.
 *
 * Takes the plan's **path**, never its body, and that is not a simplification:
 * several plans can exist over a session, and a host that renders from a path can
 * re-read the current file. It also means this tool works identically whether the
 * plan is on disk or written by the host — the tool does not care.
 *
 * The host is responsible for reading the file and rendering it. Mastra's tool is
 * explicit that it "does not know about any UI", and duplicating that here would put
 * a rendering decision inside a published package.
 *
 * Three outcomes, copied from Mastra because the *wording* is load-bearing: the third
 * is the one that stops an agent from revising a plan the user has not commented on,
 * by telling it to wait for the user's next message instead of inventing revisions.
 */
/** The verdict a plan call returns, carried back so a UI can render the outcome. */
export type SubmitPlanResult = {
	content: string;
	isError: boolean;
	/** Present on every branch, so a host never has to infer what happened. */
	submittedPlan: { path: string; action: "approved" | "rejected"; feedback?: string };
};

export const createSubmitPlanTool = (): Tool<SubmitPlanInput, SubmitPlanResult> =>
	tool({
		description:
			"Submit a written plan for the user to review before any implementation begins. Write the plan to a file and pass its path. Call this only when the work is substantial enough to be worth reviewing first.",
		inputSchema: z.object({
			path: z.string(),
		}),
		execute: async (input, ctx) => {
			const scope = ctx as unknown as ToolCallScope;
			const { path } = input;

			const { resumeData } = scope;
			if (resumeData !== undefined) {
				const verdict = resumeData as SubmitPlanResumeData;
				if (verdict.action === "approved") {
					return {
						content:
							"Plan approved. Proceed with implementation following the approved plan.",
						isError: false,
						submittedPlan: { path, action: "approved" },
					};
				}
				if (verdict.feedback) {
					return {
						content: `Plan was not approved. The user wants revisions.\n\nUser feedback: ${verdict.feedback}\n\nPlease revise the plan based on the feedback and submit again with submit_plan.`,
						isError: false,
						submittedPlan: { path, action: "rejected", feedback: verdict.feedback },
					};
				}
				return {
					content:
						"Plan was not approved. The user will send revision instructions in their next message. Stop now and wait for the user to provide feedback before revising the plan.",
					isError: false,
					submittedPlan: { path, action: "rejected" },
				};
			}

			if (!scope.suspend) {
				return `Plan submitted for review: ${path}`;
			}

			scope.suspend({ path });
			return "";
		},
	}) as Tool<SubmitPlanInput, SubmitPlanResult>;

/**
 * Both built-ins, as one tool set.
 *
 * Returned as a plain object rather than registered on the harness: a caller decides
 * whether an agent can ask a question, the same way Mastra's
 * `disableBuiltinTools` does. Enabling them is a product decision, so it stays one.
 */
export const createInteractiveTools = (): Record<string, Tool> => ({
	ask_user: createAskUserTool(),
	submit_plan: createSubmitPlanTool(),
});

/**
 * The `tool` message that resumes every parked call in `suspensions`.
 *
 * ## Why this is an approval-response and not a tool-result
 *
 * Two SDK rules decide this, and both were found by trying the obvious thing:
 *
 *  - **A `tool-result` marks the call finished.** Any result for a `toolCallId`
 *    removes it from the set of calls needing a result, so the tool is never
 *    re-executed and the resume silently does nothing. It looks successful: the run
 *    completes, the model gets a result, and nothing ever saw the answer.
 *  - **A `tool-approval-response` releases the call.** It names an approval id, and the
 *    SDK re-runs the tool with `resumeData` from `toolResumeData`.
 *
 * So a suspended call is recorded as a `tool-approval-request` when it parks (the
 * harness does that, keyed `suspension-<toolCallId>`), and answered here with the
 * matching response. The value itself travels separately, in
 * `HarnessRunOptions.toolResumeData`, because the approval response carries only a
 * yes/no and this is not a permission question.
 *
 * Assembling either half by hand is where a resume goes wrong: a mismatched id is
 * dropped silently, and a **missing** one leaves the tool waiting forever for an answer
 * the caller believes it sent. Hence this helper.
 */
export const suspensionResumeMessage = (
	suspensions: ReadonlyArray<{ toolCallId: string; toolName: string }>,
	resumeData: Readonly<Record<string, unknown>>,
): ModelMessage => ({
	role: "tool",
	content: suspensions.map((s) => ({
		type: "tool-approval-response" as const,
		approvalId: `suspension-${s.toolCallId}`,
		// Always true: reaching here *is* the decision to proceed. A suspended tool
		// that should not proceed is resumed with no value at all, and re-suspends —
		// which is a stalling caller, not a denied tool.
		approved: true,
		...(resumeData[s.toolCallId] === undefined
			? {}
			: { reason: JSON.stringify(resumeData[s.toolCallId]) }),
	})),
});
