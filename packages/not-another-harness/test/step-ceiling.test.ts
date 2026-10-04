import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as nodePath from "node:path";
import type { LanguageModelV4StreamPart } from "@ai-sdk/provider";
import { simulateReadableStream, tool } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { runAgent } from "../src/agent.js";
import { createNodeEnvironment } from "../src/node.js";
import type { HarnessEvent } from "../src/types.js";
import { finishReason, v4Usage } from "./helpers/ai.js";

/** A tool that changes nothing, so a run built from it counts as non-mutating. */
const readTool = () => ({
	read: tool({
		inputSchema: z.object({ path: z.string() }),
		execute: async () => "contents",
	}),
});

/** A read-only tool that returns the same bytes for every call. */
const fixedOutputTool = () => ({
	read: tool({
		inputSchema: z.object({ path: z.string() }),
		execute: async () => "contents",
	}),
});

/** A read-only tool that returns something the run has not seen for each path. */
const novelOutputTool = () => ({
	read: tool({
		inputSchema: z.object({ path: z.string() }),
		execute: async ({ path }) => `contents of ${path}`,
	}),
});

/** A tool the harness counts as progress. */
const editTool = () => ({
	edit: tool({
		inputSchema: z.object({ path: z.string() }),
		execute: async () => "Replaced 1 occurrence",
	}),
});

const toolStep = (toolName: string, input: unknown, id: string) =>
	simulateReadableStream<LanguageModelV4StreamPart>({
		chunkDelayInMs: 0,
		chunks: [
			{
				type: "tool-call",
				toolCallId: id,
				toolName,
				input: JSON.stringify(input),
			},
			{
				type: "finish",
				finishReason: finishReason("tool-calls"),
				usage: v4Usage({ input: 100, output: 10 }),
			},
		],
	});

const textStep = () =>
	simulateReadableStream<LanguageModelV4StreamPart>({
		chunkDelayInMs: 0,
		chunks: [
			{ type: "text-start", id: "t" },
			{ type: "text-delta", id: "t", delta: "done" },
			{ type: "text-end", id: "t" },
			{
				type: "finish",
				finishReason: finishReason("stop"),
				usage: v4Usage({ input: 100, output: 10 }),
			},
		],
	});

/** A model that walks a script of steps, repeating the last entry forever. */
const scripted = (steps: Array<() => ReturnType<typeof textStep>>) => {
	let call = 0;
	return new MockLanguageModelV4({
		doStream: async () => {
			const make = steps[Math.min(call, steps.length - 1)];
			call += 1;
			if (!make) throw new Error("empty script");
			return { stream: make() };
		},
	});
};

const drain = async (events: AsyncIterable<HarnessEvent>) => {
	const out: HarnessEvent[] = [];
	for await (const e of events) out.push(e);
	return out;
};

describe("there is no default step ceiling", () => {
	let dir: string;

	beforeEach(async () => {
		dir = await mkdtemp(nodePath.join(tmpdir(), "nah-steps-"));
	});

	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	const runIt = async (
		steps: Array<() => ReturnType<typeof textStep>>,
		tools: Record<string, unknown>,
	) => {
		const run = runAgent({
			model: scripted(steps),
			system: "s",
			prompt: "go",
			tools,
		});
		const eventsPromise = drain(run.events);
		const result = await run.result;
		return { result, events: await eventsPromise };
	};

	it("runs a productive task past the old cap of 32", async () => {
		// The merge resolution that motivated removing it: 40 steps of real work,
		// every one of them changing something. A cap of 32 cut this one before any
		// of its verification and handed off mid-procedure.
		const steps: Array<() => ReturnType<typeof textStep>> = [];
		for (let i = 0; i < 40; i += 1) {
			steps.push(() =>
				toolStep(
					"edit",
					{ path: `file-${Math.random()}` },
					`c${Math.random()}`,
				),
			);
		}
		steps.push(textStep);

		const { result } = await runIt(steps, editTool());
		expect(result.reason).toBe("completed");
		expect(result.steps).toBe(41);
	});

	it("reports an unbounded step budget as null rather than a number", async () => {
		// A display showing "∞" implies a knob somebody chose; there isn't one.
		const { events } = await runIt([textStep], readTool());
		const start = events.find((e) => e.type === "run-start");
		expect(start).toEqual({
			type: "run-start",
			stepBudget: null,
			tokenBudget: 0,
		});
	});

	it("still honours an explicit ceiling", async () => {
		// Opt-in, not removed — the audience for it is unattended and batch callers
		// who will read the stop reason.
		const run = runAgent({
			model: scripted([
				() =>
					toolStep("edit", { path: `f${Math.random()}` }, `c${Math.random()}`),
			]),
			system: "s",
			prompt: "go",
			tools: editTool(),
			maxSteps: 4,
			wrapUpOnLimit: false,
		});
		await drain(run.events);
		const result = await run.result;
		expect(result.reason).toBe("max-steps");
		expect(result.steps).toBe(4);
	});
});

describe("the no-progress guard replaces the ceiling", () => {
	let dir: string;

	beforeEach(async () => {
		dir = await mkdtemp(nodePath.join(tmpdir(), "nah-noprogress-"));
	});

	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	it("stops a run that has stopped changing anything", async () => {
		const { result } = await (async () => {
			const run = runAgent({
				model: scripted([
					() => toolStep("read", { path: "same.ts" }, `c${Math.random()}`),
				]),
				system: "s",
				prompt: "go",
				tools: readTool(),
			});
			const eventsPromise = drain(run.events);
			const r = await run.result;
			return { result: r, events: await eventsPromise };
		})();
		expect(result.reason).toBe("no-progress");
	});

	it("does not stop a long run of read-only steps that are each doing new work", { timeout: 30_000 }, async () => {
		// The regression this guards. Forty reads of forty *different* files is a
		// healthy investigation, not a stall — and it is precisely the shape a
		// `delegate_explore` child always has, since those are read-only by
		// construction. Counting non-mutating steps ended these at a fixed depth,
		// which is a length limit dressed as a progress check.
		//
		// The contrast with the test above is the point: that one gets the same bytes
		// back every step and this one does not, and the only thing that should
		// separate them is whether the run is still learning anything.
		const steps: Array<() => ReturnType<typeof textStep>> = [];
		for (let i = 0; i < 40; i += 1) {
			steps.push(() => toolStep("read", { path: `file-${i}.ts` }, `c${Math.random()}`));
		}
		steps.push(textStep);

		const run = runAgent({
			model: scripted(steps),
			system: "s",
			prompt: "go",
			// Each read returns text the run has not seen, which is what makes this
			// a sweep rather than a spin.
			tools: novelOutputTool(),
		});
		await drain(run.events);
		const result = await run.result;

		// "completed", not "no-progress": it was allowed to finish on its own terms.
		expect(result.reason).toBe("completed");
		expect(result.steps).toBeGreaterThan(15);
	});

	it("stops a run that varies its calls but keeps getting the same result back", { timeout: 30_000 }, async () => {
		// The case the call-comparison detectors cannot see, and the one the removed
		// read-only step count caught only by accident. Every step calls a
		// *different* path, so no two calls are identical and the doom-loop
		// detector stays quiet; every call comes back with the same bytes, so the
		// run has learned nothing for as long as it has been going.
		//
		// `git log -3`, `git log -5`, `git log -10` against a history that is not
		// changing is this shape in the wild.
		const steps: Array<() => ReturnType<typeof textStep>> = [];
		for (let i = 0; i < 40; i += 1) {
			steps.push(() => toolStep("read", { path: `probe-${i}.ts` }, `c${Math.random()}`));
		}
		steps.push(textStep);

		const run = runAgent({
			model: scripted(steps),
			system: "s",
			prompt: "go",
			tools: fixedOutputTool(),
		});
		await drain(run.events);
		const result = await run.result;

		expect(result.reason).toBe("no-progress");
		// Warned before stopped: the run is told what it is doing and given room
		// to change approach, which is the whole value of the gap between the two.
		expect(
			result.messages.some((m) => typeof m.content === "string" && m.content.includes("adds nothing to what you know")),
		).toBe(true);
	});

	// The run here is long by design — it must outlast every bound the harness has,
	// including the "you have learned nothing" stop — so the default 5s budget is
	// what is wrong, not the test. Under load it was the first thing in the suite
	// to time out.
	it("does not fire on a run that keeps editing, however long it runs", { timeout: 30_000 }, async () => {
		// The distinction a step counter cannot make. Same number of steps, opposite
		// outcomes, and the only difference is whether anything is being changed.
		const steps: Array<() => ReturnType<typeof textStep>> = [];
		for (let i = 0; i < 60; i += 1) {
			steps.push(() =>
				toolStep("edit", { path: `f${Math.random()}` }, `c${Math.random()}`),
			);
		}
		steps.push(textStep);

		const run = runAgent({
			model: scripted(steps),
			system: "s",
			prompt: "go",
			tools: editTool(),
		});
		await drain(run.events);
		const result = await run.result;
		expect(result.reason).toBe("completed");
		expect(result.steps).toBe(61);
	});

	it("resets the streak after every mutation, so reading after an edit is fine", async () => {
		// Several read-only steps are normal inside a real task — check the output of
		// the last edit, read a file before editing it — which is why the threshold is
		// a margin rather than a hair trigger.
		const steps: Array<() => ReturnType<typeof textStep>> = [];
		for (let i = 0; i < 12; i += 1) {
			steps.push(() => toolStep("read", { path: `r${i}` }, `r${i}`));
			steps.push(() => toolStep("edit", { path: `f${i}` }, `e${i}`));
		}
		steps.push(textStep);

		const run = runAgent({
			model: scripted(steps),
			system: "s",
			prompt: "go",
			tools: { ...readTool(), ...editTool() },
		});
		await drain(run.events);
		const result = await run.result;
		expect(result.reason).toBe("completed");
	});

	it("never fires on a run that decided it was finished", async () => {
		// Placed after the "did the model answer?" check, so a stale streak from
		// earlier in the turn cannot override a model that has stopped.
		const steps: Array<() => ReturnType<typeof textStep>> = [];
		for (let i = 0; i < 8; i += 1) {
			steps.push(() => toolStep("read", { path: `r${i}` }, `r${i}`));
		}
		steps.push(textStep);

		const run = runAgent({
			model: scripted(steps),
			system: "s",
			prompt: "go",
			tools: readTool(),
		});
		await drain(run.events);
		const result = await run.result;
		expect(result.reason).toBe("completed");
	});

	it("hands off rather than cutting off, and says why", async () => {
		const { result, events } = await (async () => {
			const run = runAgent({
				model: scripted([
					() => toolStep("read", { path: "same.ts" }, `c${Math.random()}`),
				]),
				system: "s",
				prompt: "go",
				tools: readTool(),
			});
			const eventsPromise = drain(run.events);
			const r = await run.result;
			return { result: r, events: await eventsPromise };
		})();
		expect(result.wrappedUp).toBe(true);
		expect(
			events.some((e) => e.type === "wrap-up" && e.reason === "no-progress"),
		).toBe(true);
		// Names the real reason. It used to say "out of budget" for every stop, which
		// sent readers looking for a spend problem that no longer exists.
		const texts = result.messages.map((m) =>
			typeof m.content === "string" ? m.content : "",
		);
		const handoff = texts.find((t) => t.includes("Hand off cleanly"));
		expect(handoff).toBeDefined();
		expect(handoff).not.toContain("out of budget");
	});
});

describe("the repeat detector", () => {
	let dir: string;

	beforeEach(async () => {
		dir = await mkdtemp(nodePath.join(tmpdir(), "nah-repeat-"));
	});

	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	const runAndCollect = async (
		steps: Array<() => ReturnType<typeof textStep>>,
		tools: Record<string, unknown>,
	) => {
		const run = runAgent({
			model: scripted(steps),
			system: "s",
			prompt: "go",
			tools,
		});
		await drain(run.events);
		const result = await run.result;
		const texts = result.messages.map((m) =>
			typeof m.content === "string" ? m.content : "",
		);
		return { result, texts };
	};

	it("warns after the same call three steps running", async () => {
		// opencode's DOOM_LOOP_THRESHOLD. A progress signal misses this case, because
		// a loop can perfectly well rewrite the same file on every pass.
		const { texts } = await runAndCollect(
			[
				() => toolStep("read", { path: "a.ts" }, "c1"),
				() => toolStep("read", { path: "a.ts" }, "c2"),
				() => toolStep("read", { path: "a.ts" }, "c3"),
				textStep,
			],
			readTool(),
		);
		const warning = texts.find((t) => t.includes("three steps running"));
		expect(warning).toBeDefined();
		expect(warning).toContain("read");
	});

	it("ends the run when the same call persists past the warning", async () => {
		// Load-bearing, not advisory. `bash` counts as progress because the harness
		// cannot see whether a command changed anything, so a shell-driven loop never
		// trips the no-progress guard however long it runs. If this only warned, that
		// class of loop would be the one failure nothing bounded — and with the step
		// ceiling gone there would be nothing left to catch it.
		const { result, texts } = await (async () => {
			const run = runAgent({
				model: scripted([
					() =>
						toolStep("bash", { command: "git status" }, `c${Math.random()}`),
				]),
				system: "s",
				prompt: "go",
				tools: {
					bash: tool({
						inputSchema: z.object({ command: z.string() }),
						execute: async () => "ok",
					}),
				},
			});
			await drain(run.events);
			const r = await run.result;
			return {
				result: r,
				texts: r.messages.map((m) =>
					typeof m.content === "string" ? m.content : "",
				),
			};
		})();

		// Warned first, so the model had a chance to change approach, then stopped.
		expect(texts.some((t) => t.includes("three steps running"))).toBe(true);
		expect(result.reason).toBe("no-progress");
	});

	it("stays quiet on two repeats", async () => {
		// Run a test, read the failure, run it again is deliberation, not a loop.
		const { texts } = await runAndCollect(
			[
				() => toolStep("bash", { command: "npm test" }, "c1"),
				() => toolStep("bash", { command: "npm test" }, "c2"),
				textStep,
			],
			{
				bash: tool({
					inputSchema: z.object({ command: z.string() }),
					execute: async () => "ok",
				}),
			},
		);
		expect(texts.some((t) => t.includes("three steps running"))).toBe(false);
	});

	it("does not fire on a step that also did something else", async () => {
		// Comparing only the first call would warn on "read the file, then grep for
		// it", which is ordinary work. The signature is the step's whole call set.
		const twoCallStep = (n: number) =>
			simulateReadableStream<LanguageModelV4StreamPart>({
				chunkDelayInMs: 0,
				chunks: [
					{
						type: "tool-call",
						toolCallId: `a${n}`,
						toolName: "read",
						input: JSON.stringify({ path: "a.ts" }),
					},
					{
						type: "tool-call",
						toolCallId: `b${n}`,
						toolName: "grep",
						input: JSON.stringify({ pattern: "x" }),
					},
					{
						type: "finish",
						finishReason: finishReason("tool-calls"),
						usage: v4Usage({ input: 100, output: 10 }),
					},
				],
			});
		const steps = [
			() => twoCallStep(1),
			() => twoCallStep(2),
			() => twoCallStep(3),
			textStep,
		];
		const { texts } = await runAndCollect(steps, {
			...readTool(),
			grep: tool({
				inputSchema: z.object({ pattern: z.string() }),
				execute: async () => "ok",
			}),
		});
		expect(texts.some((t) => t.includes("three steps running"))).toBe(false);
	});

	it("ignores argument order when deciding two calls are identical", async () => {
		// A detector that misses a loop because the model reordered its arguments is
		// worse than none: it stays quiet on the case it was written for.
		const call = (n: number, path: string, pattern: string) =>
			simulateReadableStream<LanguageModelV4StreamPart>({
				chunkDelayInMs: 0,
				chunks: [
					{
						type: "tool-call",
						toolCallId: `x${n}`,
						toolName: "grep",
						input: JSON.stringify(
							n % 2 === 0 ? { pattern, path } : { path, pattern },
						),
					},
					{
						type: "finish",
						finishReason: finishReason("tool-calls"),
						usage: v4Usage({ input: 100, output: 10 }),
					},
				],
			});
		const steps = [
			() => call(1, "a.ts", "x"),
			() => call(2, "a.ts", "x"),
			() => call(3, "a.ts", "x"),
			textStep,
		];
		const { texts } = await runAndCollect(steps, {
			grep: tool({
				inputSchema: z.object({ pattern: z.string(), path: z.string() }),
				execute: async () => "ok",
			}),
		});
		expect(texts.some((t) => t.includes("three steps running"))).toBe(true);
	});
});
describe("the case that motivated it", () => {
	let dir: string;

	beforeEach(async () => {
		dir = await mkdtemp(nodePath.join(tmpdir(), "nah-merge-"));
	});

	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	/**
	 * 40 steps of a git merge resolution, all of them shell.
	 *
	 * The real turn that got cut was 27 bash calls and 10 ledger updates doing
	 * merge-base archaeology, a safety branch, a commit, the merge, `checkout
	 * --ours` across the conflicts, an install and a `git rm` — and it stopped at
	 * 32 having done none of the verification, handing off with "I ran out of
	 * budget before verification, so I stopped rather than push an unverified
	 * merge". Its context was 32k at a 99% cache hit rate. Nothing was under
	 * pressure.
	 *
	 * Nearly all of it is `bash`, which is the shape a step cap tuned for
	 * edit-heavy work handles worst.
	 */
	it("completes a 40-step shell-driven merge that used to be cut at 32", async () => {
		const merge: Array<() => ReturnType<typeof textStep>> = [];
		for (let i = 0; i < 40; i += 1) {
			merge.push(() =>
				toolStep("bash", { command: `git step ${i} --progress` }, `c${i}`),
			);
		}
		merge.push(textStep);

		const run = runAgent({
			model: scripted(merge),
			system: "s",
			prompt: "resolve the merge and push it",
			tools: {
				bash: tool({
					inputSchema: z.object({ command: z.string() }),
					execute: async () => "ok",
				}),
			},
		});
		await drain(run.events);
		const result = await run.result;

		expect(result.reason).toBe("completed");
		expect(result.steps).toBe(41);
		expect(result.wrappedUp).toBe(false);
	});

	it("still stops that same task once it stops making progress", async () => {
		// The guard is not the cap loosened into nothing. Once the bash calls stop
		// changing anything, the run still ends — which is the failure the cap was
		// ever for, and the only one it was ever good at catching.
		const stalled: Array<() => ReturnType<typeof textStep>> = [];
		for (let i = 0; i < 20; i += 1) {
			stalled.push(() => toolStep("bash", { command: "git status" }, `s${i}`));
		}
		const run = runAgent({
			model: scripted(stalled),
			system: "s",
			prompt: "resolve the merge and push it",
			tools: {
				bash: tool({
					inputSchema: z.object({ command: z.string() }),
					execute: async () => "ok",
				}),
			},
		});
		await drain(run.events);
		const result = await run.result;
		expect(result.reason).toBe("no-progress");
	});
});
