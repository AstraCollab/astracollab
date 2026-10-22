import { describe, expect, it } from "vitest";
import { tool } from "ai";
import { z } from "zod";

import { createNahRuntime } from "../../src/js/runtime.js";
import { createMemorySessionStore } from "../../src/js/session.js";
import type { NahFrame } from "../../src/js/types.js";
import { scriptedModel, textChunks, toolCallChunks } from "./helpers/ai.js";

const collect = async (
	source: AsyncGenerator<NahFrame>,
): Promise<NahFrame[]> => {
	const frames: NahFrame[] = [];
	for await (const frame of source) frames.push(frame);
	return frames;
};

const ofType = <T extends NahFrame["type"]>(
	frames: NahFrame[],
	type: T,
): Array<Extract<NahFrame, { type: T }>> =>
	frames.filter((frame): frame is Extract<NahFrame, { type: T }> => {
		return frame.type === type;
	});

describe("the runtime", () => {
	it("streams a turn and keeps the transcript", async () => {
		const session = createMemorySessionStore();
		const runtime = createNahRuntime({
			agent: () => ({
				model: scriptedModel(textChunks("hello")),
				system: "s",
				tools: {},
			}),
			session,
		});

		const frames = await collect(
			runtime.frames({ sessionId: "s1", input: "hi" }),
		);

		expect(ofType(frames, "turn-start")).toHaveLength(1);
		expect(ofType(frames, "text-delta")[0]?.text).toBe("hello");

		const finish = ofType(frames, "finish")[0];
		expect(finish?.reason).toBe("completed");
		expect(finish?.pendingApprovals).toEqual([]);

		const stored = await session.load("s1");
		expect(stored.length).toBeGreaterThan(0);
	});

	it("gives every frame the same session and a rising sequence", async () => {
		const runtime = createNahRuntime({
			agent: () => ({
				model: scriptedModel(textChunks("a")),
				system: "s",
				tools: {},
			}),
		});

		const frames = await collect(
			runtime.frames({ sessionId: "s1", input: "hi" }),
		);

		expect(new Set(frames.map((f) => f.sessionId))).toEqual(new Set(["s1"]));
		expect(new Set(frames.map((f) => f.runId)).size).toBe(1);

		const seqs = frames.map((f) => f.seq);
		expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
		expect(new Set(seqs).size).toBe(seqs.length);
	});

	it("refuses a decision and a new message in one request", async () => {
		const runtime = createNahRuntime({
			agent: () => ({
				model: scriptedModel(textChunks("a")),
				system: "s",
				tools: {},
			}),
		});

		const frames = await collect(
			runtime.frames({
				sessionId: "s1",
				input: "also do this",
				approvals: { "approval-1": { approved: true } },
			}),
		);

		const error = ofType(frames, "error")[0];
		expect(error?.error.name).toBe("ConflictingRequest");
		expect(ofType(frames, "finish")[0]?.reason).toBe("error");
	});

	it("refuses a decision that matches nothing", async () => {
		const runtime = createNahRuntime({
			agent: () => ({
				model: scriptedModel(textChunks("a")),
				system: "s",
				tools: {},
			}),
		});

		const frames = await collect(
			runtime.frames({
				sessionId: "s1",
				approvals: { "nothing-pending": { approved: true } },
			}),
		);

		expect(ofType(frames, "error")[0]?.error.name).toBe("StaleApproval");
	});

	it("refuses a turn with neither a message nor a decision", async () => {
		const runtime = createNahRuntime({
			agent: () => ({
				model: scriptedModel(textChunks("a")),
				system: "s",
				tools: {},
			}),
		});

		const frames = await collect(runtime.frames({ sessionId: "s1" }));
		expect(ofType(frames, "error")[0]?.error.name).toBe("EmptyTurn");
	});

	it("runs the bookkeeping inline when the handover is out of scope", async () => {
		const finished: string[] = [];
		const runtime = createNahRuntime({
			agent: () => ({
				model: scriptedModel(textChunks("a")),
				system: "s",
				tools: {},
			}),
			// Next.js's `after` throws when it is called outside the request
			// scope, which a turn that ends after the response was written
			// can provoke.
			after: () => {
				throw new Error("`after` was called outside a request scope.");
			},
			onTurnFinish: (summary) => finished.push(summary.reason),
		});

		const frames = await collect(
			runtime.frames({ sessionId: "s1", input: "hi" }),
		);

		// The turn is the thing that matters: a handover that could not be
		// made must not cost the run its ending, and the bookkeeping that
		// was lost must still happen.
		expect(ofType(frames, "finish")[0]?.reason).toBe("completed");
		expect(finished).toEqual(["completed"]);
	});
});

describe("approval", () => {
	const build = () => {
		const ran: string[] = [];
		const session = createMemorySessionStore();
		/**
		 * One model for both turns.
		 *
		 * The factory runs once per turn, so a model built inside it would be a
		 * *new* model each time — and a new model starts its script at the
		 * beginning. The resume would ask for the tool again instead of
		 * answering it, and the run would pause a second time.
		 */
		const model = scriptedModel(
			toolCallChunks("nuke", { path: "/tmp/x" }),
			textChunks("deleted"),
		);
		const runtime = createNahRuntime({
			agent: () => ({
				model,
				system: "s",
				tools: {
					nuke: tool({
						description: "Deletes a file.",
						inputSchema: z.object({ path: z.string() }),
						execute: async (input: { path: string }) => {
							ran.push(input.path);
							return `deleted ${input.path}`;
						},
					}),
				},
				toolApproval: { nuke: "user-approval" },
			}),
			session,
		});
		return { ran, runtime, session };
	};

	it("pauses the run and says what it is waiting on", async () => {
		const { ran, runtime } = build();

		const frames = await collect(
			runtime.frames({ sessionId: "s1", input: "delete /tmp/x" }),
		);

		expect(ran).toEqual([]);

		const finish = ofType(frames, "finish")[0];
		expect(finish?.reason).toBe("awaiting-approval");
		expect(finish?.pendingApprovals).toHaveLength(1);
		expect(finish?.pendingApprovals[0]?.toolName).toBe("nuke");

		const request = ofType(frames, "tool-approval-request")[0];
		expect(request?.approvalId).toBe(finish?.pendingApprovals[0]?.approvalId);
	});

	it("runs the tool once the decision comes back", async () => {
		const { ran, runtime } = build();

		const first = await collect(
			runtime.frames({ sessionId: "s1", input: "delete /tmp/x" }),
		);
		const approvalId = ofType(first, "finish")[0]?.pendingApprovals[0]
			?.approvalId;
		expect(approvalId).toBeDefined();

		const second = await collect(
			runtime.frames({
				sessionId: "s1",
				approvals: { [approvalId as string]: { approved: true } },
			}),
		);

		expect(ran).toEqual(["/tmp/x"]);
		expect(ofType(second, "finish")[0]?.reason).toBe("completed");
	});

	it("keeps the decision in the transcript", async () => {
		const { ran, runtime, session } = build();

		const first = await collect(
			runtime.frames({ sessionId: "s1", input: "delete /tmp/x" }),
		);
		const approvalId = ofType(first, "finish")[0]?.pendingApprovals[0]
			?.approvalId;

		await collect(
			runtime.frames({
				sessionId: "s1",
				approvals: { [approvalId as string]: { approved: true } },
			}),
		);

		const stored = await session.load("s1");
		const answered = stored.some(
			(message) =>
				message.role === "tool" &&
				Array.isArray(message.content) &&
				message.content.some(
					(part) =>
						(part as { type?: string }).type === "tool-approval-response",
				),
		);
		expect(answered).toBe(true);
	});
});

describe("following a session", () => {
	it("replays what a client missed", async () => {
		const runtime = createNahRuntime({
			agent: () => ({
				model: scriptedModel(textChunks("a")),
				system: "s",
				tools: {},
			}),
		});

		const first = await collect(
			runtime.frames({ sessionId: "s1", input: "hi" }),
		);
		const lastSeq = first[first.length - 1]?.seq ?? 0;

		const request = new Request(
			"http://localhost/api/nah?sessionId=s1&after=0",
		);
		const response = runtime.follow(request);
		const body = await response.text();

		expect(body).toContain("event: turn-start");
		expect(body).toContain(`id: ${lastSeq}`);
	});
});
