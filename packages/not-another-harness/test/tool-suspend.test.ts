import { describe, expect, it } from "vitest";

import { parkedSuspensionIds, runAgent } from "../src/agent.js";
import {
	createAskUserTool,
	createSubmitPlanTool,
	suspensionResumeMessage,
	type SubmitPlanResult,
} from "../src/interactive-tools.js";
import type { ModelMessage } from "ai";

import type { HarnessEvent, HarnessRunResult, PendingSuspension } from "../src/types.js";
import { scriptedModel, textChunks, toolCallChunks, v4Usage } from "./helpers/ai.js";

/**
 * Tool suspension: a tool that stops to ask, and picks up where it left off.
 *
 * ## Why this is tested at all
 *
 * The AI SDK has no suspension primitive — `grep` for `suspend` in its types returns
 * nothing — so this is a mechanism the harness owns outright, and an untested one is a
 * mechanism that either silently drops questions or waits forever.
 *
 * ## The properties that matter, in order
 *
 *  1. **A suspended tool does not run to completion.** It runs, reaches `suspend`, and
 *     the run stops. Everything else is downstream of that.
 *  2. **The run stops rather than continuing.** A parked call has no result, so the
 *     next request would carry a `tool-call` with nothing after it — the same hard
 *     constraint that governs a held approval.
 *  3. **The question survives.** On a resume the tool must see the answer, matched by
 *     `toolCallId` and not by tool name, because a model can ask twice in one step.
 *  4. **A suspension is not a failure.** Reported as `tool-error` — which is how the
 *     SDK transports anything thrown from `execute` — but surfaced as
 *     `tool-suspended`, because a tool told it failed stops asking and starts guessing.
 */

const USAGE = v4Usage({ input: 10, output: 5 });

const drive = async (options: Parameters<typeof runAgent>[0]) => {
	const handle = runAgent({ system: "s", maxSteps: 4, ...options });
	const events: HarnessEvent[] = [];
	for await (const event of handle.events) events.push(event);
	return { events, result: await handle.result };
};

/**
 * The transcript a suspended run leaves behind, built the way the harness builds it.
 *
 * Assembled here rather than by running a first turn so each test states its own
 * premise, and built through the same `suspension-` id the harness writes — which is
 * the whole point: a resume assembled from a *persisted* transcript has no other way
 * to know the id, which is why it is derived from the `toolCallId` rather than
 * generated.
 */
const suspendedTranscript = (
	calls: ReadonlyArray<{ toolCallId: string; toolName: string; input: unknown }>,
) => [
	{ role: "user" as const, content: "go" },
	{
		role: "assistant" as const,
		content: calls.flatMap((call) => [
			{ type: "tool-call" as const, toolCallId: call.toolCallId, toolName: call.toolName, input: call.input },
			{
				type: "tool-approval-request" as const,
				approvalId: `suspension-${call.toolCallId}`,
				toolCallId: call.toolCallId,
			},
		]),
	},
];

/**
 * The output a resumed tool produced, read from the transcript.
 *
 * Not from a `tool-result` event: a call answered through a suspension is executed
 * while the SDK converts the prompt, so its result lands on the stream *before* the
 * step starts and the event carries no output. Reading the event therefore asserts
 * nothing — it passes against an empty string, which is how the "always says approved"
 * break went unnoticed.
 */
const resumedOutput = (result: HarnessRunResult): string =>
	JSON.stringify(
		result.messages.filter((message) => message.role === "tool"),
	);

const of = <T extends HarnessEvent["type"]>(
	events: HarnessEvent[],
	type: T,
): Extract<HarnessEvent, { type: T }>[] =>
	events.filter((e): e is Extract<HarnessEvent, { type: T }> => e.type === type);

describe("a tool that asks a question", () => {
	it("parks, and the run stops asking", async () => {
		const { events, result } = await drive({
			model: scriptedModel(toolCallChunks("ask_user", { question: "Which environment?" }, "t1", USAGE)),
			prompt: "deploy it",
			tools: { ask_user: createAskUserTool() },
		});

		expect(result.reason).toBe("suspended");
		expect(result.pendingSuspensions).toMatchObject([
			{ toolCallId: "t1", toolName: "ask_user", payload: { question: "Which environment?" } },
		]);
		// Not an error, and not a result: the tool ran and chose to wait.
		expect(of(events, "tool-error")).toHaveLength(0);
		expect(of(events, "tool-result")).toHaveLength(0);
		expect(of(events, "tool-suspended")).toMatchObject([
			{ toolCallId: "t1", toolName: "ask_user", payload: { question: "Which environment?" } },
		]);
	});

	it("asks once, not once per step", async () => {
		// A run that continued would re-ask on every step, because the model still sees
		// a call it has no answer to. That is the failure the stop prevents.
		const { events } = await drive({
			model: scriptedModel(
				toolCallChunks("ask_user", { question: "Which environment?" }, "t1", USAGE),
				textChunks("never reached", USAGE),
			),
			prompt: "deploy it",
			tools: { ask_user: createAskUserTool() },
		});

		expect(of(events, "step-start")).toHaveLength(1);
		expect(of(events, "tool-suspended")).toHaveLength(1);
	});

	it("resumes with the answer, and the tool finishes", async () => {
		const { result } = await drive({
			model: scriptedModel(textChunks("Deploying to staging.", USAGE)),
			messages: [
				...suspendedTranscript([
					{ toolCallId: "t1", toolName: "ask_user", input: { question: "Which environment?" } },
				]),
				suspensionResumeMessage(
					[{ toolCallId: "t1", toolName: "ask_user" }],
					{ t1: "staging" },
				),
			],
			prompt: "",
			toolResumeData: { t1: "staging" },
			tools: { ask_user: createAskUserTool() },
		});

		expect(result.reason).toBe("completed");
		// The answer reached the model as an ordinary tool result.
		expect(resumedOutput(result)).toContain("User answered: staging");
		expect(result.text).toContain("staging");
	});

	it("matches the answer by tool call, so two questions stay independent", async () => {
		// A model asking two questions in one step is legal. Matching by tool *name*
		// would answer both with the same value, which is the kind of bug that looks
		// correct in every single-question test.
		const { result } = await drive({
			model: scriptedModel(textChunks("done", USAGE)),
			messages: [
				...suspendedTranscript([
					{ toolCallId: "q1", toolName: "ask_user", input: { question: "Which env?" } },
					{ toolCallId: "q2", toolName: "ask_user", input: { question: "Which region?" } },
				]),
				suspensionResumeMessage(
					[
						{ toolCallId: "q1", toolName: "ask_user" },
						{ toolCallId: "q2", toolName: "ask_user" },
					],
					{ q1: "staging", q2: "eu-west-1" },
				),
			],
			prompt: "",
			toolResumeData: { q1: "staging", q2: "eu-west-1" },
			tools: { ask_user: createAskUserTool() },
		});

		const outputs = [resumedOutput(result)];
		expect(outputs[0]).toContain("staging");
		expect(outputs[0]).toContain("eu-west-1");
	});

	it("joins a multi-select answer the way Mastra does", async () => {
		const { result } = await drive({
			model: scriptedModel(textChunks("done", USAGE)),
			messages: [
				...suspendedTranscript([
					{
						toolCallId: "q1",
						toolName: "ask_user",
						input: { question: "Which?", options: [{ label: "tests" }, { label: "docs" }], selectionMode: "multi_select" },
					},
				]),
				suspensionResumeMessage([{ toolCallId: "q1", toolName: "ask_user" }], {
					q1: ["Add tests", "Update docs"],
				}),
			],
			prompt: "",
			toolResumeData: { q1: ["Add tests", "Update docs"] },
			tools: { ask_user: createAskUserTool() },
		});

		expect(resumedOutput(result)).toContain("User answered: Add tests, Update docs");
	});

	it("re-suspends rather than answering when no value was supplied", async () => {
		// The stale-resume case, and the reason the message and the option are separate:
		// a caller can resume with no value at all — a UI double-click, or a user who
		// dismissed the question. That must re-suspend rather than be read as "resumed
		// with nothing", which is why the wrapper omits the key rather than setting it
		// to undefined.
		//
		// No `toolResumeData` here on purpose — that is the premise.
		const { result } = await drive({
			model: scriptedModel(textChunks("never reached", USAGE)),
			messages: [
				...suspendedTranscript([
					{ toolCallId: "t1", toolName: "ask_user", input: { question: "Which?" } },
				]),
				suspensionResumeMessage([{ toolCallId: "t1", toolName: "ask_user" }], {}),
			],
			prompt: "",
			tools: { ask_user: createAskUserTool() },
		});

		expect(result.reason).toBe("suspended");
	});
});

describe("the whole round trip, from one run's output to the next", () => {
	it("resumes from the transcript the suspended run actually produced", async () => {
		// Every other resume test hand-builds its transcript, which means none of them
		// prove the harness writes the resume marker itself. This one takes
		// `first.messages` — the real thing a caller would persist — and resumes from it,
		// so the approval request the harness appended is exercised rather than
		// assumed. Without that write the resume below matches nothing and the tool
		// re-suspends forever, which is the failure mode that looks like a hung request.
		const first = await drive({
			model: scriptedModel(
				toolCallChunks("ask_user", { question: "Which environment?" }, "t1", USAGE),
			),
			prompt: "deploy it",
			tools: { ask_user: createAskUserTool() },
		});
		expect(first.result.reason).toBe("suspended");

		// The marker is in the transcript, not just in the result.
		const assistant = first.result.messages.find((m) => m.role === "assistant");
		expect(
			(assistant?.content as Array<Record<string, unknown>> | undefined)?.some(
				(part) =>
					part.type === "tool-approval-request" &&
					part.approvalId === "suspension-t1",
			),
		).toBe(true);

		const second = await drive({
			model: scriptedModel(textChunks("Deploying to staging.", USAGE)),
			messages: [
				...first.result.messages,
				suspensionResumeMessage(
					first.result.pendingSuspensions.map((s) => ({
						toolCallId: s.toolCallId,
						toolName: s.toolName,
					})),
					{ t1: "staging" },
				),
			],
			prompt: "",
			toolResumeData: { t1: "staging" },
			tools: { ask_user: createAskUserTool() },
		});

		expect(second.result.reason).toBe("completed");
		expect(resumedOutput(second.result)).toContain("staging");
	});

	it("keeps the answer in the transcript, not just in the stream", async () => {
		// The SDK sends a resumed call's result to the model but omits it from
		// `response.messages`, so a caller persisting the run's transcript loses every
		// answer a suspended tool produced. The stored history then shows a question
		// with no reply, and the next turn's model has no idea it was answered — so it
		// asks again. Silent, and it looks like the user ignoring the answer.
		const first = await drive({
			model: scriptedModel(toolCallChunks("ask_user", { question: "Which env?" }, "t1", USAGE)),
			prompt: "deploy it",
			tools: { ask_user: createAskUserTool() },
		});
		const second = await drive({
			model: scriptedModel(textChunks("Deploying to staging.", USAGE)),
			messages: [
				...first.result.messages,
				suspensionResumeMessage(
					first.result.pendingSuspensions.map((s) => ({ toolCallId: s.toolCallId, toolName: s.toolName })),
					{ t1: "staging" },
				),
			],
			prompt: "",
			toolResumeData: { t1: "staging" },
			tools: { ask_user: createAskUserTool() },
		});

		const toolMessages = second.result.messages.filter((m) => m.role === "tool");
		expect(JSON.stringify(toolMessages)).toContain("User answered: staging");
	});

	it("reports a resumed call, so 'answered' is explicit rather than inferred", async () => {
		// Inferred from tool output it is wrong under delegation, where the output is the
		// delegate's result rather than the answer. A dedicated event is the honest signal.
		const { events, result } = await drive({
			model: scriptedModel(textChunks("done", USAGE)),
			messages: [
				...suspendedTranscript([
					{ toolCallId: "t1", toolName: "ask_user", input: { question: "Which?" } },
				]),
				suspensionResumeMessage([{ toolCallId: "t1", toolName: "ask_user" }], { t1: "staging" }),
			],
			prompt: "",
			toolResumeData: { t1: "staging" },
			tools: { ask_user: createAskUserTool() },
		});

		expect(of(events, "tool-resumed")).toMatchObject([
			{ toolCallId: "t1", toolName: "ask_user" },
		]);
		expect(result.reason).toBe("completed");
	});

	it("records a resumed result once, and an in-step result not at all", async () => {
		// The two arrive in opposite places: the SDK resolves resumed calls while
		// converting the prompt, so their results land on the stream *before* the first
		// `start-step`, while this step's own results land after it. Getting that
		// boundary wrong double-records every in-step result — the transcript would gain
		// a duplicate tool message per call, and the model would see each answer twice.
		const prior = suspendedTranscript([
			{ toolCallId: "t1", toolName: "ask_user", input: { question: "Which?" } },
		]);
		const resume = suspensionResumeMessage(
			[{ toolCallId: "t1", toolName: "ask_user" }],
			{ t1: "staging" },
		);
		const before = prior.length + 1;

		const { events, result } = await drive({
			// A *second, different* call id: reusing t1 would collide with the resumed
			// call's own result, and the assertion would be measuring the fixture.
			model: scriptedModel(
				toolCallChunks("ask_user", { question: "Which?" }, "t2", USAGE),
				textChunks("Deploying to staging.", USAGE),
			),
			messages: [...prior, resume],
			prompt: "",
			toolResumeData: { t1: "staging" },
			tools: { ask_user: createAskUserTool() },
		});

		// The invariant is **one recorded result per call id**, not one tool message.
		// Two messages are correct here — the resumed result, then the model's
		// follow-up call — so a count of messages would be wrong in both directions.
		// Counting occurrences of the answer text is worse still: the model's next
		// request quotes it back, so a double-recorded result and a normal run look
		// identical.
		const resultsFor = (id: string) =>
			result.messages
				.slice(before)
				.flatMap((message) =>
					message.role === "tool" && Array.isArray(message.content)
						? (message.content as Array<Record<string, unknown>>).filter(
								(part) => part.type === "tool-result" && part.toolCallId === id,
							)
						: [],
				);

		expect(resultsFor("t1")).toHaveLength(1);
		expect(JSON.stringify(resultsFor("t1"))).toContain("User answered: staging");
		expect(of(events, "tool-resumed")).toHaveLength(1);
	});

	it("annotates a parked call only once, however many steps survive it", async () => {
		// A duplicate request in the message would make the resume ambiguous. A run that
		// stops immediately cannot expose this, so the count is asserted on the shape
		// the SDK reads rather than on a run that happens to keep going.
		const first = await drive({
			model: scriptedModel(toolCallChunks("ask_user", { question: "Which?" }, "t1", USAGE)),
			prompt: "go",
			tools: { ask_user: createAskUserTool() },
		});
		const markers = (first.result.messages as ModelMessage[]).flatMap((message) =>
			message.role === "assistant" && Array.isArray(message.content)
				? (message.content as Array<Record<string, unknown>>).filter(
						(part) => part.type === "tool-approval-request",
					)
				: [],
		);
		expect(markers).toHaveLength(1);
	});
});

describe("ask_user without an agent", () => {
	it("returns the question as text rather than throwing", async () => {
		// A tool invoked by hand — a script, a test — has no run to park in. Surfacing
		// the question as readable text is what makes the tool usable there.
		const ask = createAskUserTool();
		const output = await (ask.execute as (i: unknown, c: unknown) => Promise<string>)(
			{ question: "Which environment?", options: [{ label: "staging" }, { label: "prod" }] },
			{ toolCallId: "t1" },
		);

		expect(output).toContain("[Question for user]: Which environment?");
		expect(output).toContain("staging, prod");
	});

	it("refuses a selection mode with no options, rather than silently degrading", async () => {
		const ask = createAskUserTool();
		const output = await (ask.execute as (i: unknown, c: unknown) => Promise<string>)(
			{ question: "Which?", selectionMode: "multi_select" },
			{ toolCallId: "t1" },
		);
		expect(output).toContain("selectionMode requires options");
	});
});

describe("submit_plan", () => {
	const planCall = (path: string, toolCallId = "p1") =>
		toolCallChunks("submit_plan", { path }, toolCallId, USAGE);

	it("parks with the path, and never the plan body", async () => {
		// The path is the whole contract: the host reads the file. A body in the tool
		// would mean the model wrote the plan into a tool call, which is exactly what
		// makes several plans over a session ambiguous.
		const { result } = await drive({
			model: scriptedModel(planCall(".mastracode/plans/add-dark-mode.md")),
			prompt: "add dark mode",
			tools: { submit_plan: createSubmitPlanTool() },
		});

		expect(result.reason).toBe("suspended");
		expect(result.pendingSuspensions[0]?.payload).toEqual({
			path: ".mastracode/plans/add-dark-mode.md",
		});
	});

	it("tells the model to proceed when approved", async () => {
		const { result } = await drive({
			model: scriptedModel(textChunks("starting", USAGE)),
			messages: [
				...suspendedTranscript([
					{ toolCallId: "p1", toolName: "submit_plan", input: { path: "plan.md" } },
				]),
				suspensionResumeMessage([{ toolCallId: "p1", toolName: "submit_plan" }], {
					p1: { action: "approved" },
				}),
			],
			prompt: "",
			toolResumeData: { p1: { action: "approved" } },
			tools: { submit_plan: createSubmitPlanTool() },
		});

		const output = resumedOutput(result);
		expect(output).toContain("Plan approved");
		expect(output).not.toContain("Stop now and wait");
		expect(output).not.toContain("submit again");
	});

	it("passes rejection feedback back for a revision", async () => {
		const { result } = await drive({
			model: scriptedModel(textChunks("revising", USAGE)),
			messages: [
				...suspendedTranscript([
					{ toolCallId: "p1", toolName: "submit_plan", input: { path: "plan.md" } },
				]),
				suspensionResumeMessage([{ toolCallId: "p1", toolName: "submit_plan" }], {
					p1: { action: "rejected", feedback: "split the migration out" },
				}),
			],
			prompt: "",
			toolResumeData: { p1: { action: "rejected", feedback: "split the migration out" } },
			tools: { submit_plan: createSubmitPlanTool() },
		});

		const output = resumedOutput(result);
		// Distinct from both other branches: the wording is what tells the model it may
		// revise now, rather than wait.
		expect(output).toContain("split the migration out");
		expect(output).toContain("submit again");
		expect(output).not.toContain("Stop now and wait");
		expect(output).not.toContain("Plan approved.");
	});

	it("tells the model to WAIT when a rejection carries no feedback", async () => {
		// The third branch, and the one that stops an agent inventing revisions to a
		// plan the user has not commented on. Its wording is load-bearing.
		const { result } = await drive({
			model: scriptedModel(textChunks("waiting", USAGE)),
			messages: [
				...suspendedTranscript([
					{ toolCallId: "p1", toolName: "submit_plan", input: { path: "plan.md" } },
				]),
				suspensionResumeMessage([{ toolCallId: "p1", toolName: "submit_plan" }], {
				}),
			],
			prompt: "",
			toolResumeData: { p1: { action: "rejected" } },
			tools: { submit_plan: createSubmitPlanTool() },
		});

		const output = resumedOutput(result);
		expect(output).toContain("Stop now and wait");
		// The no-feedback branch must not invite a revision the user did not ask for.
		expect(output).not.toContain("submit again");
		expect(output).not.toContain("Plan approved.");
	});
});

describe("suspension and approval in the same run", () => {
	it("reports the suspension, because a throw ends the step", async () => {
		// A step cannot actually produce both, which is worth knowing rather than
		// assuming: the SDK executes tool calls in order, a suspension throws, and the
		// step ends there. A gated call after it in the same step never runs, so there
		// is nothing to report an approval for.
		//
		// The consequence for a caller is the important part: **a question asked early
		// in a step defers everything after it.** A model that asks a clarifying question
		// and then calls a gated tool gets the question answered first and the tool on
		// the next step. That is correct, but a host showing one prompt should not
		// expect the other.
		const { events, result } = await drive({
			model: scriptedModel(
				toolCallChunks("ask_user", { question: "Which?" }, "q1", USAGE),
				toolCallChunks("deleteFile", { path: "a.ts" }, "d1", USAGE),
			),
			prompt: "do the thing",
			tools: { ask_user: createAskUserTool(), deleteFile: { requireApproval: true } as never },
			toolApproval: { deleteFile: "user-approval" },
		});

		expect(result.reason).toBe("suspended");
		expect(result.pendingSuspensions.map((s) => s.toolCallId)).toEqual(["q1"]);
		// The gated call was never reached, so nothing is waiting on a permission.
		expect(result.pendingApprovals).toEqual([]);
		expect(of(events, "tool-approval-request")).toHaveLength(0);
	});

	it("reports an approval when the gated call comes first", async () => {
		// The mirror image, and the one that matters for ordering: an approval asked
		// first also ends the step, so a suspension after it is deferred rather than
		// lost. The run reports what actually blocked it.
		const { result } = await drive({
			model: scriptedModel(
				toolCallChunks("deleteFile", { path: "a.ts" }, "d1", USAGE),
				toolCallChunks("ask_user", { question: "Which?" }, "q1", USAGE),
			),
			prompt: "do the thing",
			tools: { ask_user: createAskUserTool(), deleteFile: { requireApproval: true } as never },
			toolApproval: { deleteFile: "user-approval" },
		});

		expect(result.reason).toBe("awaiting-approval");
		expect(result.pendingApprovals.map((a) => a.toolCallId)).toEqual(["d1"]);
		expect(result.pendingSuspensions).toEqual([]);
	});
});

describe("what the run reports", () => {
	it("distinguishes the two reasons, because they are answered differently", async () => {
		const suspended = await drive({
			model: scriptedModel(toolCallChunks("ask_user", { question: "Which?" }, "q1", USAGE)),
			prompt: "go",
			tools: { ask_user: createAskUserTool() },
		});
		const held = await drive({
			model: scriptedModel(toolCallChunks("deleteFile", { path: "a" }, "d1", USAGE)),
			prompt: "go",
			tools: { deleteFile: { requireApproval: true } as never },
			toolApproval: { deleteFile: "user-approval" },
		});

		expect(suspended.result.reason).toBe("suspended");
		expect(held.result.reason).toBe("awaiting-approval");
		// Each list is empty for the other's reason, so a caller cannot mistake them.
		expect((suspended.result as HarnessRunResult).pendingApprovals).toEqual([]);
		expect((held.result as HarnessRunResult).pendingSuspensions as PendingSuspension[]).toEqual([]);
	});

	it("pins the caller's thread and resource onto the suspension", async () => {
		// A session can switch threads while a call is parked, so a resume that looks
		// up "the current thread" can answer a question into a different conversation.
		const { result } = await drive({
			model: scriptedModel(toolCallChunks("ask_user", { question: "Which?" }, "q1", USAGE)),
			prompt: "go",
			tools: { ask_user: createAskUserTool() },
			suspensionScope: { threadId: "chat-1", resourceId: "org-1" },
		});

		expect(result.pendingSuspensions[0]).toMatchObject({
			threadId: "chat-1",
			resourceId: "org-1",
		});
	});
});
describe("autoResumeSuspensions", () => {
	const parked = (calls: ReadonlyArray<{ toolCallId: string; question: string }>) => [
		{ role: "user" as const, content: "deploy it" },
		{
			role: "assistant" as const,
			content: calls.flatMap((call) => [
				{ type: "tool-call" as const, toolCallId: call.toolCallId, toolName: "ask_user", input: { question: call.question } },
				{
					type: "tool-approval-request" as const,
					approvalId: `suspension-${call.toolCallId}`,
					toolCallId: call.toolCallId,
				},
			]),
		},
	];

	it("continues the run on the user's reply, with no click", async () => {
		const { events, result } = await drive({
			model: scriptedModel(textChunks("Deploying to staging.", USAGE)),
			messages: parked([{ toolCallId: "t1", question: "Which environment?" }]),
			prompt: "staging",
			autoResumeSuspensions: true,
			tools: { ask_user: createAskUserTool() },
		});

		expect(result.reason).toBe("completed");
		expect(resumedOutput(result)).toContain("User answered: staging");
		expect(of(events, "tool-resumed")).toHaveLength(1);
	});

	it("refuses rather than resuming, so no tool runs on an unrecognised reply", async () => {
		// Not "leaves it parked": a transcript with a parked call and no answer is
		// *invalid*, and appending a user message to one throws `MissingToolResultsError`
		// from the SDK. So the two settings are not a choice — off means the run is
		// refused, loudly, because the alternative is executing a tool against a value
		// nobody chose.
		const handle = runAgent({
			model: scriptedModel(textChunks("never reached", USAGE)),
			system: "s", prompt: "staging", maxSteps: 2,
			messages: parked([{ toolCallId: "t1", question: "Which environment?" }]),
			tools: { ask_user: createAskUserTool() },
		});
		const events: HarnessEvent[] = [];
		for await (const event of handle.events) events.push(event);

		const error = of(events, "error")[0];
		expect(String((error as { error?: Error })?.error?.message ?? "")).toContain(
			"waiting on an answer to a suspended tool call",
		);
		// And the stream ends, rather than leaving a caller draining forever.
		expect(of(events, "finish")).toHaveLength(1);
		await expect(handle.result).rejects.toThrow(/waiting on an answer/);
	});

	it("answers every parked call, since the SDK reads the last message only", async () => {
		// One message covering all of them: a message per call would leave all but the
		// last unanswered, and the run would re-suspend on the rest.
		const { result } = await drive({
			model: scriptedModel(textChunks("done", USAGE)),
			messages: parked([
				{ toolCallId: "q1", question: "Which env?" },
				{ toolCallId: "q2", question: "Which region?" },
			]),
			prompt: "staging",
			autoResumeSuspensions: true,
			tools: { ask_user: createAskUserTool() },
		});

		expect(result.reason).toBe("completed");
		expect(result.pendingSuspensions).toEqual([]);
	});

	it("does not re-answer a call that was already answered", async () => {
		// The failure a naive "any marker present" check produces: the marker stays in
		// the transcript forever, so a later message would answer it again — and
		// re-running an approved `deleteFile` is the worst possible repeat.
		//
		// Asserted as the auto-resume *decision*, not as a run outcome: a transcript
		// ending in a parked call is invalid to send, so there is no run in which "t1
		// stays parked" can be observed. A refusal here would be about t2, not t1.
		const { events } = await drive({
			model: scriptedModel(textChunks("done", USAGE)),
			system: "s",
			messages: [
				...parked([{ toolCallId: "t1", question: "Which environment?" }]),
				suspensionResumeMessage([{ toolCallId: "t1", toolName: "ask_user" }], { t1: "staging" }),
			],
			prompt: "and now something else",
			autoResumeSuspensions: true,
			tools: { ask_user: createAskUserTool() },
		});

		// Nothing left to resume, so the message is taken as ordinary input and the run
		// proceeds — rather than re-answering t1 and re-running whatever it asked.
		expect(of(events, "tool-resumed")).toHaveLength(0);
		expect(of(events, "error")).toHaveLength(0);

		// The distinction that makes this bite: with the prompt treated as an answer, the
		// call is released and `tool-resumed` fires; treated as input, it is not. A
		// broken "already answered" filter would show one where zero is expected.
		const reoffered = await drive({
			model: scriptedModel(textChunks("done", USAGE)),
			system: "s",
			messages: [...parked([{ toolCallId: "t9", question: "Already answered?" }])],
			prompt: "something else",
			autoResumeSuspensions: true,
			tools: { ask_user: createAskUserTool() },
		});
		expect(of(reoffered.events, "tool-resumed")).toHaveLength(1);
		expect(resumedOutput(reoffered.result)).toContain("something else");
	});

	it("keeps the reply in the transcript, so the model sees the exchange", async () => {
		// The prompt is consumed as the answer, not appended as a user message — so it
		// would otherwise vanish. The model would see a tool result with no question
		// attached to it, which is not a conversation it can reason about.
		const seen: string[] = [];
		const { result } = await drive({
			model: scriptedModel(textChunks("ok", USAGE)),
			system: "s",
			messages: parked([{ toolCallId: "t1", question: "Which environment?" }]),
			prompt: "staging",
			autoResumeSuspensions: true,
			tools: { ask_user: createAskUserTool() },
		});

		// The reply survives inside the answer the tool returns to the model.
		expect(resumedOutput(result)).toContain("staging");
		expect(result.messages.some((m) => JSON.stringify(m).includes("staging"))).toBe(true);
		void seen;
	});
});

describe("parkedSuspensionIds", () => {
	/**
	 * Asserted directly rather than through a run, because no run can observe it.
	 *
	 * The end-to-end route short-circuits: `endsWithApprovalResponse` sees the answer
	 * message and the auto-resume path is never reached. So the property that matters
	 * — a call already answered is not offered again — has no run that fails without
	 * it. Exporting the filter makes it testable, and the export is the fix rather than
	 * a test-only hook: a caller resuming from a persisted transcript needs the same
	 * question answered.
	 */
	const marker = (toolCallId: string) => ({
		role: "assistant" as const,
		content: [
			{ type: "tool-call" as const, toolCallId, toolName: "ask_user", input: { question: "Which?" } },
			{ type: "tool-approval-request" as const, approvalId: `suspension-${toolCallId}`, toolCallId },
		],
	});

	it("finds a call still waiting", () => {
		expect(parkedSuspensionIds([marker("t1")])).toEqual(["t1"]);
	});

	it("ignores a call already answered", () => {
		const answered: ModelMessage[] = [
			marker("t1"),
			{ role: "tool", content: [{ type: "tool-approval-response", approvalId: "suspension-t1", approved: true }] },
		];
		// The property: re-offering this would re-run an approved `deleteFile`.
		expect(parkedSuspensionIds(answered)).toEqual([]);
	});

	it("still finds a call answered after it", () => {
		// Order is why the test above passes: an answer only counts for a marker that
		// came before it. A new question asked in the same turn must survive.
		const mixed: ModelMessage[] = [
			marker("t1"),
			{ role: "tool", content: [{ type: "tool-approval-response", approvalId: "suspension-t1", approved: true }] },
			marker("t2"),
		];
		expect(parkedSuspensionIds(mixed)).toEqual(["t2"]);
	});

	it("ignores an approval that is not a suspension", () => {
		// A real approval's id has no `suspension-` prefix. Treating it as one would
		// auto-answer a permission question with a chat message.
		const approval: ModelMessage[] = [
			{
				role: "assistant",
				content: [
					{ type: "tool-call", toolCallId: "d1", toolName: "deleteFile", input: { path: "a" } },
					{ type: "tool-approval-request", approvalId: "aitxt-abc", toolCallId: "d1" },
				],
			},
		];
		expect(parkedSuspensionIds(approval)).toEqual([]);
	});

	it("finds several parked calls at once", () => {
		// The SDK reads answers from the final message only, so all of them must be
		// answered together or the rest re-suspend.
		expect(parkedSuspensionIds([marker("q1"), marker("q2")])).toEqual(["q1", "q2"]);
	});
});
