import type { LanguageModelV4StreamPart } from "@ai-sdk/provider";
import { simulateReadableStream, tool } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as nodePath from "node:path";

import {
	type IsolationHandle,
	Orchestrator,
	OrchestratorBusyError,
	type SubtaskIsolation,
	type WorkflowStepDelegate,
	createGitWorktreeIsolation,
	formatSubtaskReport,
	orchestratorPrompt,
} from "../src/orchestrator.js";
import { StepSuspend, createStep, createWorkflow } from "../src/workflow.js";
import { finishReason, v4Usage } from "./helpers/ai.js";

vi.mock("../src/agent.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/agent.js")>();
	return {
		...actual,
		runAgent: vi.fn(actual.runAgent),
	};
});

import { runAgent } from "../src/agent.js";

const mockedRunAgent = vi.mocked(runAgent);

beforeEach(() => {
	mockedRunAgent.mockClear();
});

const tempDirs: string[] = [];
afterEach(async () => {
	for (const dir of tempDirs) await rm(dir, { recursive: true, force: true }).catch(() => {});
	tempDirs.length = 0;
});

const tempDir = async (): Promise<string> => {
	const dir = await mkdtemp(nodePath.join(tmpdir(), "nah-refs-test-"));
	tempDirs.push(dir);
	return dir;
};

const tools = () => ({
	read: tool({
		inputSchema: z.object({ path: z.string() }),
		execute: async () => "contents",
	}),
});

/** One step that calls a tool, then one that answers. */
const scriptedModel = () => {
	let call = 0;
	return new MockLanguageModelV4({
		doStream: async () => {
			const call0 = call++;
			if (call0 === 0) {
				return {
					stream: simulateReadableStream<LanguageModelV4StreamPart>({
						chunkDelayInMs: 0,
						chunks: [
							{
								type: "tool-call",
								toolCallId: "c1",
								toolName: "read",
								input: JSON.stringify({ path: "a.ts" }),
							},
							{
								type: "finish",
								finishReason: finishReason("tool-calls"),
								usage: v4Usage({ input: 100, output: 10 }),
							},
						],
					}),
				};
			}
			return {
				stream: simulateReadableStream<LanguageModelV4StreamPart>({
					chunkDelayInMs: 0,
					chunks: [
						{ type: "text-start", id: "t" },
						{ type: "text-delta", id: "t", delta: "child done" },
						{ type: "text-end", id: "t" },
						{
							type: "finish",
							finishReason: finishReason("stop"),
							usage: v4Usage({ input: 50, output: 5 }),
						},
					],
				}),
			};
		},
	});
};

/** A model that only ever answers in prose. */
const proseModel = () =>
	new MockLanguageModelV4({
		doStream: async () => ({
			stream: simulateReadableStream<LanguageModelV4StreamPart>({
				chunkDelayInMs: 0,
				chunks: [
					{ type: "text-start", id: "t" },
					{ type: "text-delta", id: "t", delta: "nothing to do" },
					{ type: "text-end", id: "t" },
					{
						type: "finish",
						finishReason: finishReason("stop"),
						usage: v4Usage({ input: 10, output: 2 }),
					},
				],
			}),
		}),
	});

/** Isolation that records what it was asked to do instead of touching Git. */
const recordingIsolation = (
	log: string[],
	opts: { diff?: string } = {},
): SubtaskIsolation => ({
	description: "recording",
	prepare: async ({ title }): Promise<IsolationHandle> => {
		log.push(`prepare:${title}`);
		return {
			cwd: `/tmp/${title}`,
			boundaryNotes: ["- isolated"],
			collect: async () => {
				log.push(`collect:${title}`);
				return {
					baseRevision: "abc123",
					changedPaths: ["a.ts"],
					diff: opts.diff ?? "diff --git a/a.ts",
				};
			},
			cleanup: async ({ retain }) => {
				log.push(`cleanup:${title}:${retain}`);
			},
		};
	},
});

describe("Orchestrator", () => {
	it("runs a child in its own transcript and returns its work", async () => {
		const log: string[] = [];
		const orchestrator = new Orchestrator({
			model: scriptedModel(),
			system: "parent system",
			createTools: tools,
			isolation: recordingIsolation(log),
		});

		const result = await orchestrator.run({
			title: "extract helper",
			task: "Move the helper out of the file.",
		});

		expect(result.status).toBe("completed");
		expect(result.steps).toBe(2);
		expect(result.toolCalls).toBe(1);
		expect(result.text).toContain("child done");
		expect(result.artifact?.changedPaths).toEqual(["a.ts"]);
		expect(log).toEqual([
			"prepare:extract helper",
			"collect:extract helper",
			"cleanup:extract helper:false",
		]);
	});

	it("hands the child tool factory the isolated root, not the parent's", async () => {
		const roots: string[] = [];
		const orchestrator = new Orchestrator({
			model: proseModel(),
			system: "parent system",
			createTools: (cwd) => {
				roots.push(cwd);
				return tools();
			},
			isolation: {
				description: "test",
				prepare: async () => ({
					cwd: "/tmp/child",
					boundaryNotes: ["- parent has uncommitted work"],
					cleanup: async () => {},
				}),
			},
		});

		await orchestrator.run({ title: "probe", task: "Look around." });

		expect(roots).toEqual(["/tmp/child"]);
	});

	it("sums usage across children", async () => {
		const seen: number[] = [];
		const orchestrator = new Orchestrator({
			model: proseModel(),
			system: "s",
			createTools: tools,
			onUsage: (usage) => seen.push(usage.totalTokens),
		});

		await orchestrator.runAll([
			{ title: "one", task: "First independent task." },
			{ title: "two", task: "Second independent task." },
		]);

		expect(seen).toEqual([12, 12]);
		expect(orchestrator.totalUsage.totalTokens).toBe(24);
		expect(orchestrator.active).toBe(0);
	});

	it("runs a plan larger than the cap in waves rather than refusing it", async () => {
		let inFlight = 0;
		let peak = 0;
		// Slow enough that overlap is observable, so the cap is measured and not asserted.
		const slowModel = new MockLanguageModelV4({
			doStream: async () => {
				inFlight += 1;
				peak = Math.max(peak, inFlight);
				await new Promise((resolve) => setTimeout(resolve, 5));
				inFlight -= 1;
				return {
					stream: simulateReadableStream<LanguageModelV4StreamPart>({
						chunkDelayInMs: 0,
						chunks: [
							{ type: "text-start", id: "t" },
							{ type: "text-delta", id: "t", delta: "ok" },
							{ type: "text-end", id: "t" },
							{
								type: "finish",
								finishReason: finishReason("stop"),
								usage: v4Usage({ input: 10, output: 1 }),
							},
						],
					}),
				};
			},
		});
		const orchestrator = new Orchestrator({
			model: slowModel,
			system: "s",
			createTools: tools,
			maxConcurrency: 2,
		});

		const results = await orchestrator.runAll([
			{ title: "one", task: "First independent task." },
			{ title: "two", task: "Second independent task." },
			{ title: "three", task: "Third independent task." },
			{ title: "four", task: "Fourth independent task." },
			{ title: "five", task: "Fifth independent task." },
		]);

		expect(results.map((r) => r.title)).toEqual([
			"one",
			"two",
			"three",
			"four",
			"five",
		]);
		expect(peak).toBe(2);
	});

	it("refuses a task above the concurrency cap rather than queueing it", async () => {
		const orchestrator = new Orchestrator({
			model: proseModel(),
			system: "s",
			createTools: tools,
			maxConcurrency: 1,
		});

		const first = orchestrator.run({
			title: "one",
			task: "First independent task.",
		});
		await expect(
			orchestrator.run({ title: "two", task: "Second independent task." }),
		).rejects.toBeInstanceOf(OrchestratorBusyError);
		await first;
	});

	it("retains the workspace when the diff is too big to inline", async () => {
		const orchestrator = new Orchestrator({
			model: proseModel(),
			system: "s",
			createTools: tools,
			isolation: recordingIsolation([], { diff: "x".repeat(5_000) }),
			maxDiffChars: 1_000,
		});

		const result = await orchestrator.run({
			title: "big",
			task: "Change a lot of files.",
		});

		expect(result.workspace).toBe("/tmp/big");
		expect(result.artifact?.diff).toContain(
			"diff truncated at 1000 characters",
		);
	});

	it("cleans up and reports the failure when the run throws", async () => {
		const log: string[] = [];
		const orchestrator = new Orchestrator({
			model: new MockLanguageModelV4({
				doStream: async () => {
					throw new Error("provider is down");
				},
			}),
			system: "s",
			createTools: tools,
			isolation: recordingIsolation(log),
		});

		const result = await orchestrator.run({
			title: "broken",
			task: "This should fail.",
		});

		expect(result.status).toBe("error");
		expect(result.error).toContain("provider is down");
		// A failed child's workspace is retained for inspection, not cleaned up.
		expect(log).toContain("cleanup:broken:true");
	});
});

describe("orchestratorPrompt", () => {
	it("states the two constraints a parent cannot discover", () => {
		const prompt = orchestratorPrompt({
			concurrency: 3,
			isolation: "temporary Git worktree",
		});
		expect(prompt).toContain("snapshot of your working state");
		expect(prompt).toContain("never merged automatically");
		expect(prompt).toContain("At most 3 children");
	});
});

describe("formatSubtaskReport", () => {
	it("renders identity, metrics, paths and diff in a fixed order", () => {
		const report = formatSubtaskReport(
			{
				id: "1",
				title: "extract helper",
				status: "completed",
				steps: 4,
				toolCalls: 2,
				usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 },
				text: "moved the helper",
				durationMs: 1234,
				artifact: {
					baseRevision: "abc123",
					changedPaths: ["a.ts"],
					diff: "diff --git a/a.ts",
				},
			},
			{ maxReportChars: 20 },
		);
		expect(report).toContain("Delegated task: extract helper");
		expect(report).toContain("Base revision: abc123");
		expect(report).toContain("tokens: 100 in / 20 out / 120 total");
		expect(report).toContain("Changed paths: a.ts");
		expect(report).toContain("Review this diff before applying any of it:");
		expect(report).toContain("moved the helper");
	});
});

describe("createGitWorktreeIsolation", () => {
	it("names its strategy", () => {
		expect(createGitWorktreeIsolation({ cwd: "." }).description).toBe(
			"temporary Git worktree",
		);
	});
});

describe("Orchestrator workflows", () => {
	const orchestrator = (model = proseModel()) =>
		new Orchestrator({
			model,
			system: "parent system",
			createTools: tools,
			isolation: recordingIsolation([]),
		});

	it("gives every step a delegate, and keeps the order it was written in", async () => {
		const log: string[] = [];
		const parent = orchestrator();
		const review = createWorkflow({
			id: "review",
			inputSchema: z.object({ paths: z.array(z.string()) }),
		})
			.then(
				createStep({
					id: "fan-out",
					execute: async ({ inputData, context }) => {
						const { delegateAll } = context as unknown as WorkflowStepDelegate;
						const results = await delegateAll(
							(inputData as { paths: string[] }).paths.map((path) => ({
								title: `review ${path}`,
								task: `Look at ${path}.`,
							})),
						);
						log.push(`reviewed:${results.length}`);
						return { findings: results.map((result) => result.text) };
					},
				}),
			)
			.then(
				createStep({
					id: "summarise",
					execute: ({ inputData, context }) => {
						log.push("summarised");
						// The step that needs judgement delegates; the step after it is code.
						expect(
							typeof (context as unknown as WorkflowStepDelegate).delegate,
						).toBe("function");
						return `${(inputData as { findings: string[] }).findings.length} findings`;
					},
				}),
			)
			.commit();

		const result = await parent.runWorkflow(review, {
			inputData: { paths: ["a.ts", "b.ts"] },
		});

		expect(result.status).toBe("success");
		expect(result.result).toBe("2 findings");
		expect(log).toEqual(["reviewed:2", "summarised"]);
		expect(Object.keys(result.steps)).toEqual(["fan-out", "summarise"]);
		// The children's usage lands on the orchestrator, not on the workflow, so a
		// caller spending against one ceiling sees both halves.
		expect(parent.totalUsage.totalTokens).toBeGreaterThan(0);
	});

	it("reports a child that fails as a failed run rather than a throw", async () => {
		const parent = new Orchestrator({
			model: proseModel(),
			system: "parent system",
			createTools: tools,
			isolation: {
				description: "failing",
				prepare: async () => {
					throw new Error("no workspace");
				},
			},
		});
		const workflow = createWorkflow({ id: "w" })
			.then(
				createStep({
					id: "needs-a-child",
					execute: async ({ context }) => {
						await (context as unknown as WorkflowStepDelegate).delegate({
							title: "t",
							task: "do it",
						});
						return "unreachable";
					},
				}),
			)
			.commit();

		const result = await parent.runWorkflow(workflow);

		// The child failing is data the step can branch on, not an exception that
		// takes the whole sequence down past the step that could have handled it.
		expect(result.status).toBe("success");
		expect(result.result).toBe("unreachable");
	});

	it("keeps a suspended workflow findable and resumable by run id", async () => {
		const parent = orchestrator();
		const workflow = createWorkflow({ id: "gated" })
			.then(
				createStep({
					id: "ask",
					execute: () => {
						throw new StepSuspend({ question: "ship it?" });
					},
				}),
			)
			.then(createStep({ id: "after", execute: () => "shipped" }))
			.commit();

		const first = await parent.runWorkflow(workflow);

		expect(first.status).toBe("suspended");
		expect(parent.pendingWorkflows()).toEqual([
			expect.objectContaining({
				workflowId: "gated",
				suspended: ["ask"],
				suspendPayload: { question: "ship it?" },
			}),
		]);

		const [pending] = parent.pendingWorkflows();
		const resumed = await parent.resumeWorkflow(pending?.runId, "yes");

		// The suspended step throws unconditionally in this workflow, so a resume
		// suspends again — which is the honest outcome, and must not lose the run.
		expect(resumed.status).toBe("suspended");
		expect(parent.pendingWorkflows()).toHaveLength(1);
	});

	it("rejects a resume for a run id it does not hold", async () => {
		await expect(orchestrator().resumeWorkflow("nope")).rejects.toThrow(
			/no suspended workflow/,
		);
	});

	it("streams a run's progress without running it twice", async () => {
		const parent = orchestrator();
		const workflow = createWorkflow({ id: "streamed" })
			.then(
				createStep({
					id: "one",
					execute: async ({ writer }) => {
						writer("half ");
						return "done";
					},
				}),
			)
			.commit();

		const { events, result } = parent.streamWorkflow(workflow);
		const seen: string[] = [];
		for await (const event of events) seen.push(event.type);

		const final = await result;
		expect(seen).toEqual([
			"workflow-start",
			"step-start",
			"step-delta",
			"step-finish",
			"workflow-finish",
		]);
		expect(final.status).toBe("success");
		expect(Object.keys(final.steps)).toEqual(["one"]);
	});

	it("stops a run whose signal is already aborted", async () => {
		const parent = orchestrator();
		const controller = new AbortController();
		controller.abort();
		const workflow = createWorkflow({ id: "cancelled" })
			.then(createStep({ id: "never", execute: () => "ran anyway" }))
			.commit();

		const result = await parent.runWorkflow(workflow, {
			signal: controller.signal,
		});

		expect(result.status).toBe("failed");
		expect(result.status === "failed" && result.error.name).toBe("AbortError");
	});
});

describe("Weak model routing", () => {
	const weakModel = () =>
		new MockLanguageModelV4({
			doStream: async () => ({
				stream: simulateReadableStream<LanguageModelV4StreamPart>({
					chunkDelayInMs: 0,
					chunks: [
						{ type: "text-start", id: "t" },
						{ type: "text-delta", id: "t", delta: "child done" },
						{ type: "text-end", id: "t" },
						{
							type: "finish",
							finishReason: finishReason("stop"),
							usage: v4Usage({ input: 10, output: 2 }),
						},
					],
				}),
			}),
		});

	const captureIsolation = (): SubtaskIsolation => ({
		description: "capture",
		prepare: async () => ({
			cwd: "/tmp/captured",
			boundaryNotes: ["- captured"],
			cleanup: async () => {},
		}),
	});

	it("caps maxSteps at 8 for a weak model", async () => {
		const orchestrator = new Orchestrator({
			model: weakModel(),
			modelSpec: "llama-3.1-8b",
			system: "parent system",
			createTools: () => tools(),
			isolation: captureIsolation(),
		});

		await orchestrator.run({ title: "weak child", task: "Do something." });

		expect(mockedRunAgent).toHaveBeenCalledTimes(1);
		const call = mockedRunAgent.mock.calls[0][0];
		expect(call.maxSteps).toBe(8);
	});

	it("restricts mutating tools for a weak model", async () => {
		const orchestrator = new Orchestrator({
			model: weakModel(),
			modelSpec: "llama-3.1-8b",
			system: "parent system",
			createTools: () => ({ ...tools(), edit: tool({}), write: tool({}), bash: tool({}) }),
			isolation: captureIsolation(),
		});

		await orchestrator.run({ title: "weak child", task: "Do something." });

		expect(mockedRunAgent).toHaveBeenCalledTimes(1);
		const call = mockedRunAgent.mock.calls[0][0];
		expect(call.tools).not.toHaveProperty("edit");
		expect(call.tools).not.toHaveProperty("write");
		expect(call.tools).not.toHaveProperty("bash");
	});

	it("caps maxSpendUsd at $2 for a weak model", async () => {
		const orchestrator = new Orchestrator({
			model: weakModel(),
			modelSpec: "llama-3.1-8b",
			system: "parent system",
			createTools: () => tools(),
			isolation: captureIsolation(),
			maxSpendUsd: 100,
		});

		await orchestrator.run({ title: "weak child", task: "Do something." });

		expect(mockedRunAgent).toHaveBeenCalledTimes(1);
		const call = mockedRunAgent.mock.calls[0][0];
		expect(call.maxSpendUsd).toBe(2);
	});

	it("does not restrict a strong model", async () => {
		const orchestrator = new Orchestrator({
			model: weakModel(),
			modelSpec: "claude-sonnet-4",
			system: "parent system",
			createTools: () => ({ ...tools(), edit: tool({}), write: tool({}), bash: tool({}) }),
			isolation: captureIsolation(),
		});

		await orchestrator.run({ title: "strong child", task: "Do something." });

		expect(mockedRunAgent).toHaveBeenCalledTimes(1);
		const call = mockedRunAgent.mock.calls[0][0];
		expect(call.maxSteps).toBeUndefined();
		expect(call.tools).toHaveProperty("edit");
		expect(call.tools).toHaveProperty("write");
		expect(call.tools).toHaveProperty("bash");
		expect(call.maxSpendUsd).toBeUndefined();
	});

	it("passes weak-model guidance in the system prompt", async () => {
		const orchestrator = new Orchestrator({
			model: weakModel(),
			modelSpec: "llama-3.1-8b",
			system: "parent system",
			createTools: () => tools(),
			isolation: captureIsolation(),
		});

		await orchestrator.run({ title: "weak child", task: "Do something." });

		expect(mockedRunAgent).toHaveBeenCalledTimes(1);
		const call = mockedRunAgent.mock.calls[0][0];
		expect(call.system).toContain("weaker/open-weight model");
		expect(call.system).toContain("tiny, verifiable steps");
	});

	describe("Cross-project references", () => {
		const weakModel = () =>
			new MockLanguageModelV4({
				doStream: async () => ({
					stream: simulateReadableStream<LanguageModelV4StreamPart>({
						chunkDelayInMs: 0,
						chunks: [
							{ type: "text-start", id: "t" },
							{ type: "text-delta", id: "t", delta: "child done" },
							{ type: "text-end", id: "t" },
							{
								type: "finish",
								finishReason: finishReason("stop"),
								usage: v4Usage({ input: 10, output: 2 }),
							},
						],
					}),
				}),
			});

		const isolationWithCwd = (cwd: string): SubtaskIsolation => ({
			description: "real dir",
			prepare: async () => ({
				cwd,
				boundaryNotes: [],
				cleanup: async () => {},
			}),
		});

		it("copies reference projects into the child workspace as read-only context", async () => {
			const refDir = await tempDir();
			await writeFile(nodePath.join(refDir, "lib.ts"), "export const answer = 42;\n");
			const childDir = await tempDir();

			const orchestrator = new Orchestrator({
				model: weakModel(),
				modelSpec: "llama-3.1-8b",
				system: "parent system",
				createTools: () => tools(),
				isolation: isolationWithCwd(childDir),
				referenceProjects: [{ name: "ref-proj", path: refDir }],
			});

			await orchestrator.run({ title: "weak child", task: "Do something." });

			const copied = await readFile(
				nodePath.join(childDir, "references", "ref-proj", "lib.ts"),
				"utf8",
			);
			expect(copied).toBe("export const answer = 42;\n");
		});

		it("passes reference projects into the child's system prompt", async () => {
			const refDir = await tempDir();
			await writeFile(nodePath.join(refDir, "lib.ts"), "export const answer = 42;\n");
			const childDir = await tempDir();

			const orchestrator = new Orchestrator({
				model: weakModel(),
				modelSpec: "llama-3.1-8b",
				system: "parent system",
				createTools: () => tools(),
				isolation: isolationWithCwd(childDir),
				referenceProjects: [{ name: "ref-proj", path: refDir }],
			});

			await orchestrator.run({ title: "weak child", task: "Do something." });

			expect(mockedRunAgent).toHaveBeenCalledTimes(1);
			const call = mockedRunAgent.mock.calls[0][0];
			expect(call.system).toContain("Reference projects (read-only context)");
			expect(call.system).toContain("references/ref-proj/");
			expect(call.system).toContain("excluded from your diff");
		});

		it("excludes references from changed paths and the reported diff", async () => {
			const refDir = await tempDir();
			await writeFile(nodePath.join(refDir, "lib.ts"), "export const answer = 42;\n");
			const childDir = await tempDir();

			const isolation: SubtaskIsolation = {
				description: "real dir",
				prepare: async () => ({
					cwd: childDir,
					boundaryNotes: [],
					cleanup: async () => {},
					collect: async (): Promise<SubtaskArtifact> => ({
						baseRevision: "abc",
						changedPaths: ["references/ref-proj/lib.ts", "real-file.ts"],
						diff:
							"diff --git a/references/ref-proj/lib.ts b/references/ref-proj/lib.ts\nnew file mode 100644\n--- /dev/null\n+++ b/references/ref-proj/lib.ts\n@@ -0,0 +1 @@\n+export const answer = 42;\ndiff --git a/real-file.ts b/real-file.ts\nnew file mode 100644\n--- /dev/null\n+++ b/real-file.ts\n@@ -0,0 +1 @@\n+real change\n",
						workspace: childDir,
					}),
				}),
			};

			const orchestrator = new Orchestrator({
				model: weakModel(),
				modelSpec: "llama-3.1-8b",
				system: "parent system",
				createTools: () => tools(),
				isolation,
				referenceProjects: [{ name: "ref-proj", path: refDir }],
			});

			const result = await orchestrator.run({ title: "weak child", task: "Do something." });

			expect(result.artifact?.changedPaths).toEqual(["real-file.ts"]);
			expect(result.artifact?.diff).not.toContain("references/");
			expect(result.artifact?.diff).toContain("real-file.ts");
			expect(result.overlap).toBeUndefined();
		});

		it("does not create a references directory when none are configured", async () => {
			const childDir = await tempDir();

			const orchestrator = new Orchestrator({
				model: weakModel(),
				modelSpec: "llama-3.1-8b",
				system: "parent system",
				createTools: () => tools(),
				isolation: isolationWithCwd(childDir),
			});

			await orchestrator.run({ title: "child", task: "Do something." });

			await expect(
				access(nodePath.join(childDir, "references")),
			).rejects.toMatchObject({ code: "ENOENT" });
		});
	});
});
