import { describe, expect, it } from "vitest";
import { tool } from "ai";
import type { ModelMessage } from "ai";
import type { LanguageModelV4StreamPart } from "@ai-sdk/provider";
import { z } from "zod";

import { runAgent } from "../src/agent.js";
import { memorySink, traceRun } from "../src/telemetry.js";
import { appendApprovalResponses, type HarnessEvent } from "../src/types.js";
import {
	finishReason,
	scriptedModel,
	textChunks,
	toolCallChunks,
	v4Usage,
} from "./helpers/ai.js";

/**
 * Approval: a tool that does not run until someone says so.
 *
 * ## Why this file exists
 *
 * `runAgent` used to have no concept of approval at all. It forwarded no
 * `toolApproval` to the SDK and mapped five stream parts — `text-delta`,
 * `tool-call`, `tool-result`, `tool-error`, `error` — none of which is an approval
 * one. So a tool gated behind a decision produced a `tool-call` event and then
 * nothing at all: no result, no error, no indication that a person was being asked.
 *
 * In the client this is not a missing feature but a missing gate. Eighteen of the
 * tools there are destructive and marked `requireApproval` — `deleteFile`,
 * `deleteProject`, `deleteTicket`, `removeTeamMember` — and every one of them would
 * have run unattended under this harness, with no test able to fail, because a
 * `deleteFile` that succeeds is indistinguishable from one that was approved.
 *
 * ## The protocol, verified rather than assumed
 *
 * Established against the mock provider, because the SDK's behaviour here is not
 * guessable from its types and three of the details are load-bearing:
 *
 *  - `toolApproval: { tool: "user-approval" }` emits a `tool-approval-request` part
 *    and **no result part at all**. The tool has not run.
 *  - Continuing anyway does not merely misbehave: the next request carries a
 *    `tool-call` with no matching result and the SDK throws
 *    `MissingToolResultsError`. Suspending is the only valid move, not a policy
 *    preference, which is why this harness ends the run rather than looping.
 *  - The decision travels as a `tool-approval-response` **part in a `tool` message**,
 *    matched by `approvalId` — not by `toolCallId`, and not through a callback. So
 *    approval is a round-trip through the transcript, and a harness that wanted it
 *    in-flight would be designing against the wrong shape.
 *  - Resuming with `toolApproval` still configured does **not** re-ask. A call that
 *    already has a decision in the transcript is executed directly.
 */

const USAGE = v4Usage({ input: 10, output: 5 });

type Call = { path: string };

/** A destructive tool, which is the entire reason approval exists. */
const destroyer = (ran: string[]) =>
	tool({
		description: "Deletes a file.",
		inputSchema: z.object({ path: z.string() }),
		execute: async (input: Call) => {
			ran.push(input.path);
			return `deleted ${input.path}`;
		},
	});

/** An ungated tool, so a step can pass without touching an approval. */
const readOnly = (ran: string[]) =>
	tool({
		description: "Reads a file.",
		inputSchema: z.object({ path: z.string() }),
		execute: async (input: Call) => {
			ran.push(input.path);
			return "contents";
		},
	});

const drive = async (options: Parameters<typeof runAgent>[0]) => {
	const handle = runAgent({ system: "s", maxSteps: 4, ...options });
	const events: HarnessEvent[] = [];
	for await (const event of handle.events) events.push(event);
	return { events, result: await handle.result };
};

const of = <T extends HarnessEvent["type"]>(
	events: HarnessEvent[],
	type: T,
): Extract<HarnessEvent, { type: T }>[] =>
	events.filter((e): e is Extract<HarnessEvent, { type: T }> => e.type === type);

/**
 * The transcript a denial leaves behind.
 *
 * Both parts, because that is what the SDK writes: an approval response *and* the
 * `execution-denied` result. Building only the response makes the SDK synthesise the
 * missing result on the next request and re-announce the denial, which is a real
 * behaviour — but a fixture that omits it is testing the SDK's repair path rather
 * than the round-trip this harness owns.
 */
const denied = (approvalId: string, toolCallId = "t1", reason?: string): ModelMessage => ({
	role: "tool",
	content: [
		{ type: "tool-approval-response", approvalId, approved: false, ...(reason ? { reason } : {}) } as never,
		{
			type: "tool-result",
			toolCallId,
			toolName: "nuke",
			output: { type: "execution-denied", ...(reason ? { reason } : {}) },
		} as never,
	],
});

/**
 * One step in which the model asks for two gated calls.
 *
 * Assembled by hand because `toolCallChunks` ends each script with a `finish`, and a
 * model does not finish between two calls in the same step — it emits both and then
 * finishes once.
 */
const twoToolCallsInOneStep = () =>
	[
		{ type: "tool-input-start", id: "t1", toolName: "nuke" },
		{ type: "tool-input-delta", id: "t1", delta: JSON.stringify({ path: "a.ts" }) },
		{ type: "tool-input-end", id: "t1" },
		{ type: "tool-call", toolCallId: "t1", toolName: "nuke", input: JSON.stringify({ path: "a.ts" }) },
		{ type: "tool-input-start", id: "t2", toolName: "nuke" },
		{ type: "tool-input-delta", id: "t2", delta: JSON.stringify({ path: "b.ts" }) },
		{ type: "tool-input-end", id: "t2" },
		{ type: "tool-call", toolCallId: "t2", toolName: "nuke", input: JSON.stringify({ path: "b.ts" }) },
		{ type: "finish", finishReason: finishReason("tool-calls"), usage: USAGE },
	] as unknown as LanguageModelV4StreamPart[];

const askToDelete = (approvalId: string, path: string, toolCallId = "t1"): ModelMessage[] => [
	{
		role: "assistant",
		content: [
			{ type: "tool-call", toolCallId, toolName: "nuke", input: { path } },
			{
				type: "tool-approval-request",
				approvalId,
				toolCallId,
			} as unknown as ModelMessage["content"][number],
		],
	},
];

describe("a tool held for approval", () => {
	it("does not run, and says so", async () => {
		const ran: string[] = [];
		const { events, result } = await drive({
			model: scriptedModel(
				toolCallChunks("nuke", { path: "a.ts" }, "t1", USAGE),
				textChunks("never reached", USAGE),
			),
			prompt: "delete a.ts",
			tools: { nuke: destroyer(ran) },
			toolApproval: { nuke: "user-approval" },
		});

		// The gate held.
		expect(ran).toEqual([]);

		// And it is visible, which is the part that used to be missing: a consumer
		// rendering only `tool-call` and `tool-result` saw a call that hangs forever.
		expect(of(events, "tool-approval-request")).toMatchObject([
			{
				step: 1,
				toolCallId: "t1",
				toolName: "nuke",
				input: { path: "a.ts" },
				isAutomatic: false,
			},
		]);
		expect(result.pendingApprovals).toMatchObject([
			{ toolCallId: "t1", toolName: "nuke", input: { path: "a.ts" } },
		]);
		expect(result.reason).toBe("awaiting-approval");
	});

	it("stops instead of continuing into an invalid request", async () => {
		// Not a style choice. The SDK emits no result part for a blocked call, so a
		// second step would send a `tool-call` with no matching result and be rejected
		// outright with MissingToolResultsError — a crash that reads like a provider
		// fault and says nothing about the approval that caused it.
		const { events, result } = await drive({
			model: scriptedModel(
				toolCallChunks("nuke", { path: "a.ts" }, "t1", USAGE),
				toolCallChunks("nuke", { path: "b.ts" }, "t2", USAGE),
			),
			prompt: "delete both",
			tools: { nuke: destroyer([]) },
			toolApproval: { nuke: "user-approval" },
		});

		// One step only, and no error event — it stopped, it did not break.
		expect(of(events, "step-start").map((e) => e.step)).toEqual([1]);
		expect(of(events, "error")).toHaveLength(0);
		expect(result.steps).toBe(1);
	});

	it("keeps the step's cost, since the request was paid for", async () => {
		// The user may never answer. Reporting the suspended run as free would make
		// "awaiting approval" look like the cheapest way to run an agent.
		const { result } = await drive({
			model: scriptedModel(toolCallChunks("nuke", { path: "a.ts" }, "t1", USAGE)),
			prompt: "delete a.ts",
			tools: { nuke: destroyer([]) },
			toolApproval: { nuke: "user-approval" },
		});

		expect(result.usage.inputTokens).toBe(10);
		expect(result.usage.outputTokens).toBe(5);
	});

	it("does not spend a wrap-up step talking about work that is not happening", async () => {
		// Every other hard stop winds down with one final step. This one must not: the
		// tool is sitting unapproved, so the wrap-up would spend a request asking the
		// model to summarise and append a user message to a transcript whose
		// unanswered call makes the next request invalid.
		const { events, result } = await drive({
			model: scriptedModel(toolCallChunks("nuke", { path: "a.ts" }, "t1", USAGE)),
			prompt: "delete a.ts",
			tools: { nuke: destroyer([]) },
			toolApproval: { nuke: "user-approval" },
			wrapUpOnLimit: true,
			maxSteps: 1,
		});

		expect(of(events, "wrap-up")).toHaveLength(0);
		expect(result.wrappedUp).toBe(false);
		expect(result.reason).toBe("awaiting-approval");
	});

	it("reports a caller's own stop instead, when it applies", async () => {
		// Ordering matters both ways: a run the caller ended should not be reported as
		// waiting on a person, because the person is never going to be asked. Step 2 is
		// where both conditions are true — `shouldStop` is skipped on step 1 by design,
		// so a gated call there cannot demonstrate the ordering.
		const { result } = await drive({
			model: scriptedModel(
				toolCallChunks("read", { path: "a.ts" }, "t1", USAGE),
				toolCallChunks("nuke", { path: "b.ts" }, "t2", USAGE),
			),
			prompt: "read then delete",
			tools: { read: readOnly([]), nuke: destroyer([]) },
			toolApproval: { nuke: "user-approval" },
			shouldStop: ({ stepNumber }) => stepNumber >= 2,
		});

		expect(result.reason).toBe("stopped-by-caller");
	});

	it("holds every gated call in a step, not just the first", async () => {
		// A model that asks to delete two files gets one prompt per file. Collapsing
		// them would either run the second unapproved or block the first.
		const { result } = await drive({
			model: scriptedModel(twoToolCallsInOneStep() as LanguageModelV4StreamPart[]),
			prompt: "delete both",
			tools: { nuke: destroyer([]) },
			toolApproval: { nuke: "user-approval" },
		});

		expect(result.pendingApprovals.map((p) => p.input)).toEqual([
			{ path: "a.ts" },
			{ path: "b.ts" },
		]);
	});
});

describe("answering an approval", () => {
	it("runs the tool once approved", async () => {
		const ran: string[] = [];
		const { events, result } = await drive({
			model: scriptedModel(textChunks("deleted it", USAGE)),
			prompt: "",
			// The transcript a previous suspended run left behind.
			messages: [
				{ role: "user", content: "delete a.ts" },
				...askToDelete("ap-1", "a.ts"),
				{
					role: "tool",
					content: [
						{ type: "tool-approval-response", approvalId: "ap-1", approved: true } as never,
					],
				},
			],
			tools: { nuke: destroyer(ran) },
			// Still gated, exactly as a resumed run would pass it. The SDK does not
			// re-ask: a call with a decision in the transcript runs directly.
			toolApproval: { nuke: "user-approval" },
		});

		expect(ran).toEqual(["a.ts"]);
		expect(result.reason).toBe("completed");
		expect(result.pendingApprovals).toEqual([]);
	});

	it("does not run the tool when denied, and the model is told", async () => {
		const ran: string[] = [];
		const { events, result } = await drive({
			model: scriptedModel(textChunks("ok, leaving it", USAGE)),
			prompt: "",
			messages: [
				{ role: "user", content: "delete a.ts" },
				...askToDelete("ap-1", "a.ts"),
				denied("ap-1", "t1", "user said no"),
			],
			tools: { nuke: destroyer(ran) },
			toolApproval: { nuke: "user-approval" },
		});

		expect(ran).toEqual([]);
		// A denied call is the one case where the SDK emits no `tool-result`, so
		// without mapping `tool-output-denied` it would be the single call in the run
		// with no result at all — the pairing every consumer relies on, broken for
		// exactly the call a user just refused.
		expect(of(events, "tool-result")).toMatchObject([
			{ toolCallId: "t1", toolName: "nuke", isError: true },
		]);
		expect(result.reason).toBe("completed");
	});

	it("does not prompt again for a decision the transcript already carries", async () => {
		// The failure this guards: a caller that persists a decision and then resumes
		// re-asks the same question, so a user clicks approve twice and the tool runs
		// twice.
		const { events, result } = await drive({
			model: scriptedModel(toolCallChunks("nuke", { path: "b.ts" }, "t2", USAGE)),
			prompt: "",
			messages: [
				{ role: "user", content: "delete a.ts" },
				...askToDelete("ap-1", "a.ts"),
				{
					role: "tool",
					content: [
						{ type: "tool-approval-response", approvalId: "ap-1", approved: true } as never,
					],
				},
			],
			tools: { nuke: destroyer([]) },
			toolApproval: { nuke: "user-approval" },
		});

		// One request for the *new* call only. The answered one is not re-asked.
		expect(of(events, "tool-approval-request").map((e) => e.toolCallId)).toEqual(["t2"]);
		expect(result.pendingApprovals.map((p) => p.toolCallId)).toEqual(["t2"]);
	});
});

describe("a gate that decides for itself", () => {
	it("runs the tool in the same step and reports the decision", async () => {
		const ran: string[] = [];
		const { events, result } = await drive({
			model: scriptedModel(
				toolCallChunks("nuke", { path: "a.ts" }, "t1", USAGE),
				textChunks("deleted", USAGE),
			),
			prompt: "delete a.ts",
			tools: { nuke: destroyer(ran) },
			toolApproval: { nuke: async () => "approved" },
		});

		expect(ran).toEqual(["a.ts"]);
		// Marked automatic so a UI does not prompt on a decision nobody needs to make.
		// The event still fires: a decision nobody made is worth logging, and the
		// request/response pairing is what makes an audit trail readable.
		expect(of(events, "tool-approval-request")[0]?.isAutomatic).toBe(true);
		expect(of(events, "tool-approval-response")[0]).toMatchObject({ approved: true });
		// Nothing to wait for, so nothing is pending and the run continues.
		expect(result.pendingApprovals).toEqual([]);
		expect(result.reason).toBe("completed");
	});

	it("denies without ever asking, and the call still gets a result", async () => {
		const ran: string[] = [];
		const { events, result } = await drive({
			model: scriptedModel(
				toolCallChunks("nuke", { path: "a.ts" }, "t1", USAGE),
				textChunks("i cannot delete that", USAGE),
			),
			prompt: "delete a.ts",
			tools: { nuke: destroyer(ran) },
			toolApproval: { nuke: "denied" },
		});

		expect(ran).toEqual([]);
		expect(of(events, "tool-approval-response")[0]).toMatchObject({ approved: false });
		expect(of(events, "tool-result")).toMatchObject([
			{ toolCallId: "t1", toolName: "nuke", isError: true },
		]);
		expect(result.pendingApprovals).toEqual([]);
	});

	it("decides from the call's arguments", async () => {
		// The shape a real gate uses: `deleteFile` under a temp dir is fine, one under
		// a user's repo is not. A gate that cannot see the arguments can only be
		// all-or-nothing.
		const seen: unknown[] = [];
		const ran: string[] = [];
		await drive({
			model: scriptedModel(
				toolCallChunks("nuke", { path: "tmp/scratch" }, "t1", USAGE),
				toolCallChunks("nuke", { path: "src/index.ts" }, "t2", USAGE),
			),
			prompt: "delete two",
			tools: { nuke: destroyer(ran) },
			toolApproval: {
				nuke: (input: Call) => {
					seen.push(input);
					return input.path.startsWith("tmp/") ? "approved" : "user-approval";
				},
			},
		});

		expect(seen).toEqual([{ path: "tmp/scratch" }, { path: "src/index.ts" }]);
		// The safe one ran; the dangerous one is waiting, and the run stopped there.
		expect(ran).toEqual(["tmp/scratch"]);
	});
});

describe("appendApprovalResponses", () => {
	const suspended = (): ModelMessage[] => [
		{ role: "user", content: "delete a.ts" },
		...askToDelete("ap-1", "a.ts"),
		...askToDelete("ap-2", "b.ts", "t2").map((m) =>
			m.role === "assistant"
				? {
						...m,
						content: [
							...(m.content as unknown[]),
							{ type: "tool-approval-request", approvalId: "ap-2", toolCallId: "t2" },
						],
					}
				: m,
		),
	];

	it("answers exactly the calls still open", () => {
		const messages = appendApprovalResponses(suspended(), { "ap-1": { approved: true } });

		expect(messages).toHaveLength(4);
		const [decision] = (messages[3] as { content: Array<Record<string, unknown>> }).content;
		expect(decision).toEqual({
			type: "tool-approval-response",
			approvalId: "ap-1",
			approved: true,
		});
	});

	it("ignores a decision for a call that is not pending", () => {
		// Rejected outright it would be a crash on stale state; silently appended it
		// would be a response the SDK cannot match, which is the same as asking again.
		const before = suspended();
		const messages = appendApprovalResponses(before, { "ap-nope": { approved: true } });
		expect(messages).toEqual(before);
	});

	it("does not re-answer a decision already in the transcript", () => {
		const answered = appendApprovalResponses(suspended(), { "ap-1": { approved: true } });
		const again = appendApprovalResponses(answered, { "ap-1": { approved: false } });

		// The already-answered id is no longer open, so nothing is appended — the
		// caller cannot flip a decision the SDK has already acted on.
		expect(again).toHaveLength(4);
	});

	it("carries the reason a person gave", () => {
		const messages = appendApprovalResponses(suspended(), {
			"ap-1": { approved: false, reason: "that is a production file" },
		});
		const [decision] = (messages[3] as { content: Array<Record<string, unknown>> }).content;
		expect(decision).toMatchObject({
			approved: false,
			reason: "that is a production file",
		});
	});

	it("leaves the input untouched", () => {
		const before = suspended();
		appendApprovalResponses(before, { "ap-1": { approved: true } });
		expect(before).toHaveLength(3);
	});
});

describe("what a suspended run leaves behind", () => {
	it("keeps the approval request in the transcript, so a resume can find it", async () => {
		// The whole round-trip rests on this: the request is the only record of which
		// `approvalId` the caller has to answer, and it lives in the assistant message.
		const { result } = await drive({
			model: scriptedModel(toolCallChunks("nuke", { path: "a.ts" }, "t1", USAGE)),
			prompt: "delete a.ts",
			tools: { nuke: destroyer([]) },
			toolApproval: { nuke: "user-approval" },
		});

		const parts = result.messages.flatMap((message) =>
			message.role === "assistant" && Array.isArray(message.content) ? message.content : [],
		) as Array<Record<string, unknown>>;
		const request = parts.find((p) => p.type === "tool-approval-request");

		expect(request).toMatchObject({ toolCallId: "t1" });
		// The id the caller must answer with is the one `pendingApprovals` reported.
		expect(request?.approvalId).toBe(result.pendingApprovals[0]?.approvalId);
	});

	it("leaves no tool result for the held call", async () => {
		// Which is why the run must stop: this transcript is mid-round-trip, and the
		// SDK refuses to send it as-is.
		const { result } = await drive({
			model: scriptedModel(toolCallChunks("nuke", { path: "a.ts" }, "t1", USAGE)),
			prompt: "delete a.ts",
			tools: { nuke: destroyer([]) },
			toolApproval: { nuke: "user-approval" },
		});

		expect(result.messages.some((m) => m.role === "tool")).toBe(false);
	});

	it("resumes to completion when the answer arrives", async () => {
		// The two halves, end to end: suspend, persist, answer, resume, finish. Run as
		// one test because the interesting failures are in the seam — a resumed run
		// that re-asks, or that runs the tool twice, passes both halves separately.
		const ran: string[] = [];
		const first = await drive({
			model: scriptedModel(
				toolCallChunks("nuke", { path: "a.ts" }, "t1", USAGE),
				textChunks("unreached", USAGE),
			),
			prompt: "delete a.ts",
			tools: { nuke: destroyer(ran) },
			toolApproval: { nuke: "user-approval" },
		});
		expect(first.result.reason).toBe("awaiting-approval");

		const resumed = await drive({
			model: scriptedModel(textChunks("deleted a.ts", USAGE)),
			prompt: "",
			tools: { nuke: destroyer(ran) },
			toolApproval: { nuke: "user-approval" },
			messages: appendApprovalResponses(first.result.messages, {
				[first.result.pendingApprovals[0]!.approvalId]: { approved: true },
			}),
		});

		expect(ran).toEqual(["a.ts"]);
		expect(resumed.result.reason).toBe("completed");
		expect(resumed.result.pendingApprovals).toEqual([]);
		expect(resumed.result.text).toBe("deleted a.ts");
	});
});

describe("without a gate", () => {
	it("runs every tool, as before", async () => {
		// The default is unchanged, and it has to be: a harness cannot know which of
		// its tools are destructive, so `toolApproval` absent means "no gate
		// configured", not "approved by default".
		const ran: string[] = [];
		const { result } = await drive({
			model: scriptedModel(
				toolCallChunks("nuke", { path: "a.ts" }, "t1", USAGE),
				textChunks("done", USAGE),
			),
			prompt: "delete a.ts",
			tools: { nuke: destroyer(ran) },
		});

		expect(ran).toEqual(["a.ts"]);
		expect(result.reason).toBe("completed");
		expect(result.pendingApprovals).toEqual([]);
	});
});

type _UnusedApprovalResult = HarnessRunResult;
describe("a held call in a trace", () => {
	it("closes the tool span as waiting, not as failed or hung", async () => {
		// A trace that renders a held call as still-running sends whoever is debugging
		// it to look for a hang; one that renders it as failed sends them to look for a
		// crash. Neither is what happened: the tool did not run, and is waiting.
		const sink = memorySink();
		const handle = runAgent({
			model: scriptedModel(toolCallChunks("nuke", { path: "a.ts" }, "t1", USAGE)),
			prompt: "delete a.ts",
			tools: { nuke: destroyer([]) },
			toolApproval: { nuke: "user-approval" },
			system: "s",
			maxSteps: 2,
		});
		await traceRun({ sink }, handle.events);
		await handle.result;

		const tool = sink.spans.find((s) => s.name === "tool: nuke");
		expect(tool?.attributes["nah.tool.awaiting_approval"]).toBe(true);
		// Not an error: nothing failed.
		expect(tool?.status).not.toBe("error");
		// And closed, so a waterfall does not show it still running.
		expect(tool?.endTime).not.toBeNull();
	});

	it("records the run's stop reason", async () => {
		const sink = memorySink();
		const handle = runAgent({
			model: scriptedModel(toolCallChunks("nuke", { path: "a.ts" }, "t1", USAGE)),
			prompt: "delete a.ts",
			tools: { nuke: destroyer([]) },
			toolApproval: { nuke: "user-approval" },
			system: "s",
			maxSteps: 2,
		});
		await traceRun({ sink }, handle.events);
		await handle.result;

		const root = sink.spans.find((s) => s.kind === "agent");
		expect(root?.attributes["nah.stop_reason"]).toBe("awaiting-approval");
	});
});
