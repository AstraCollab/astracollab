/**
 * Does the model actually delegate now?
 *
 * The 72-session log showed zero `delegate_task` calls. The wiring was never the
 * problem — children were registered and the prompt mandated delegation — so the
 * search for a cause ended on the isolation contract: children branched from
 * `HEAD`, so a parent's in-flight work was invisible to them, and the prompt
 * told the model to delegate only work that did not depend on its uncommitted
 * changes. In a live session that excludes nearly everything, and the model was
 * following the rule rather than ignoring it.
 *
 * This suite measures that claim instead of asserting it. Each scenario runs the
 * same task twice — once with the snapshot, once with the old `HEAD` branching —
 * and reports the delegation rate for each arm. The two arms differ in exactly
 * one variable, so a difference in the rate is evidence for the claim rather
 * than a coincidence of two different tasks.
 *
 * What it deliberately does NOT do is assert that the model must delegate.
 * Delegation is a judgement call, and a suite that fails whenever the model
 * declines would punish it for making a reasonable choice and would train us to
 * ignore the signal. It fails only on infrastructure — a provider that never
 * answered, a repo that would not build. The rate is the output; read it.
 *
 * Opt in, since this spends live model calls:
 *   NAH_DELEGATION_EVAL=1 pnpm vitest run test/delegation-eval.test.ts
 */
import { execFile } from "node:child_process";
import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, describe, expect, it } from "vitest";

import { createCodingTools, createGitWorktreeIsolation, runAgent } from "not-another-harness";
import { createNodeEnvironment } from "not-another-harness/node";

import { createDelegationTools, createSessionOrchestrator } from "../src/delegation.js";
import { resolveModel } from "../src/model.js";
import { type SessionState, composeTurnRequest } from "../src/session.js";

const execFileAsync = promisify(execFile);

const enabled = process.env.NAH_DELEGATION_EVAL === "1";
// Free tier, and the same model the other evals default to. Overridable so this
// can be pointed at a stronger model once there is a budget for it.
const modelSpec =
	process.env.NAH_EVAL_MODEL ?? "openrouter:stealth/space-bunny-alpha";
const repeatCount = Number(process.env.NAH_EVAL_REPEATS ?? 3);
const maxSteps = Number(process.env.NAH_EVAL_MAX_STEPS ?? 20);

const resultsPath = path.resolve(
	process.env.NAH_DELEGATION_RESULTS ??
		fileURLToPath(
			new URL("../../not-another-harness/evals/delegation-results.jsonl", import.meta.url),
		),
);

/**
 * The task, and the part that matters.
 *
 * `shared/util.mjs` gains `slugify` as an *uncommitted parent edit* — it does
 * not exist at `HEAD`. Both subtasks call it. That is what makes this a real
 * test of the fix rather than of delegation in the abstract: with `HEAD`
 * branching the child genuinely cannot do the work, so declining to delegate is
 * the correct call, and any delegation it does attempt should fail. With the
 * snapshot the work is doable, and delegation becomes the right call. If the
 * snapshot fix works, the snapshot arm should delegate more often and succeed
 * where the control cannot.
 */
const SEED = {
	"shared/util.mjs": [
		"export const upper = (s) => String(s).toUpperCase();",
		"",
	].join("\n"),
	"alpha.mjs": "import { slugify } from './shared/util.mjs';\nexport const alpha = [];\n",
	"beta.mjs": "import { slugify } from './shared/util.mjs';\nexport const beta = [];\n",
};

/** Applied after the initial commit, so it exists only in the working tree. */
const PARENT_EDIT = [
	"export const upper = (s) => String(s).toUpperCase();",
	"export const slugify = (s) => String(s).trim().toLowerCase().replace(/\\s+/g, '-');",
	"",
].join("\n");

const PROMPT =
	"alpha.mjs and beta.mjs both need a label helper exported from each file. Each takes a title and returns slugify(title) uppercased. Work through both files.";

/** Arms. The only difference is the one under test. */
const arms = [
	{ id: "snapshot", snapshotParentChanges: true },
	{ id: "head-only", snapshotParentChanges: false },
] as const;

const git = async (cwd: string, args: string[]) =>
	(await execFileAsync("git", args, { cwd })).stdout.trim();

/** Names of tools the parent called, from its own transcript. */
const toolNamesCalled = (messages: Array<{ content: unknown }>): string[] => {
	const names: string[] = [];
	for (const message of messages) {
		if (!Array.isArray(message.content)) continue;
		for (const part of message.content) {
			if (
				part &&
				typeof part === "object" &&
				"type" in part &&
				part.type === "tool-call" &&
				"toolName" in part &&
				typeof part.toolName === "string"
			) {
				names.push(part.toolName);
			}
		}
	}
	return names;
};

describe.skipIf(!enabled)("does the agent delegate over a dirty parent?", () => {
	const runId = `${new Date().toISOString()}-${process.pid}`;
	const records: Array<Record<string, unknown>> = [];

	afterAll(async () => {
		if (!enabled || records.length === 0) return;
		const summary = arms.map((arm) => {
			const own = records.filter((record) => record.arm === arm.id);
			const delegated = own.filter((record) => record.delegated === true).length;
			return {
				arm: arm.id,
				attempts: own.length,
				delegated,
				delegationRate: own.length ? delegated / own.length : null,
				childrenSucceeded: own.filter((record) => record.childrenSucceeded === true)
					.length,
				infraErrors: own.filter((record) => record.infra === true).length,
			};
		});
		const line = JSON.stringify({ runId, model: modelSpec, summary });
		process.stdout.write(`[nah-delegation-eval-summary] ${line}\n`);
		await mkdir(path.dirname(resultsPath), { recursive: true });
		await appendFile(
			resultsPath,
			`${JSON.stringify({ schemaVersion: 1, recordType: "delegation_summary", runId, model: modelSpec, recordedAt: new Date().toISOString(), summary })}\n`,
			"utf8",
		);
	});

	it.each(
		arms.flatMap((arm) =>
			Array.from({ length: repeatCount }, (_, index) => ({ arm, repetition: index + 1 })),
		),
	)("arm $arm.id repetition $repetition", async ({ arm, repetition }) => {
		const workspace = await mkdtemp(path.join(tmpdir(), "nah-delegation-eval-"));
		const record: Record<string, unknown> = {
			schemaVersion: 1,
			runId,
			recordedAt: new Date().toISOString(),
			model: modelSpec,
			arm: arm.id,
			snapshotParentChanges: arm.snapshotParentChanges,
			repetition,
			delegated: false,
			delegateCalls: 0,
			childrenStarted: 0,
			childrenSucceeded: false,
			infra: false,
			steps: 0,
			totalTokens: 0,
			elapsedMs: 0,
		};
		const startedAt = Date.now();
		try {
			for (const [file, contents] of Object.entries(SEED)) {
				await mkdir(path.dirname(path.join(workspace, file)), { recursive: true });
				await writeFile(path.join(workspace, file), contents);
			}
			await git(workspace, ["init", "--initial-branch=main"]);
			await git(workspace, ["config", "user.email", "eval@example.com"]);
			await git(workspace, ["config", "user.name", "Eval"]);
			await git(workspace, ["add", "-A"]);
			await git(workspace, ["commit", "-m", "seed"]);
			// The parent's in-flight edit, deliberately uncommitted.
			await writeFile(path.join(workspace, "shared/util.mjs"), PARENT_EDIT);
			record.headBefore = await git(workspace, ["rev-parse", "HEAD"]);

			const resolved = await resolveModel(modelSpec);
			// Auto-approve: nah defaults to `yolo`, and this measures willingness to
			// delegate, not friction at an approval prompt.
			const approve = async () => true;
			const children: string[] = [];
			const orchestrator = createSessionOrchestrator({
				cwd: workspace,
				system: "You are a coding agent working in this repository.",
				getModel: () => resolved.model,
				approve,
				isolation: createGitWorktreeIsolation({
					cwd: workspace,
					snapshotParentChanges: arm.snapshotParentChanges,
				}),
				onChildEvent: (event) => {
					if (event.type === "subtask-start") children.push(event.title);
				},
			});
			const delegator = createDelegationTools({ orchestrator, approve });
			const { delegate_task, delegate_tasks } = delegator;

			const { system } = composeTurnRequest(
				{
					system: "You are a coding agent working in this repository.",
					tools: { delegate_task, delegate_tasks } as unknown as SessionState["tools"],
					taskLedger: undefined,
				},
				PROMPT,
				"",
			);

			const run = runAgent({
				model: resolved.model,
				system,
				prompt: PROMPT,
				tools: {
					...createCodingTools(createNodeEnvironment(workspace)),
					delegate_task,
					delegate_tasks,
				},
				maxSteps,
				compaction: "off",
			});
			const result = await run.result;
			const called = toolNamesCalled(result.messages);
			const delegateCalls = called.filter(
				(name) => name === "delegate_task" || name === "delegate_tasks",
			).length;

			record.steps = result.steps;
			record.totalTokens = result.usage.totalTokens;
			record.reason = result.reason;
			record.toolNames = [...new Set(called)].sort();
			record.delegateCalls = delegateCalls;
			record.delegated = delegateCalls > 0;
			record.childrenStarted = children.length;
			record.childrenTitles = children;
			// A child that reported a completed status without a crash is the
			// signal that the snapshot actually reached it.
			record.childrenSucceeded =
				children.length > 0 &&
				(record.text ?? "").toLowerCase().includes("completed");
			record.headAfter = await git(workspace, ["rev-parse", "HEAD"]);
			// A run that never touched the provider is infrastructure, not a
			// judgement about delegation, and must not be averaged in as one.
			record.infra = result.usage.totalTokens === 0 || result.reason === "error";
		} catch (error) {
			record.infra = true;
			record.error = error instanceof Error ? error.message : String(error);
		} finally {
			record.elapsedMs = Date.now() - startedAt;
			records.push(record);
			process.stdout.write(`[nah-delegation-eval] ${JSON.stringify(record)}\n`);
			// Persist per-run, not just per-suite. A run that delegated but whose
			// child failed is the most informative record here, and it is exactly
			// the one a summary line erases.
			await mkdir(path.dirname(resultsPath), { recursive: true });
			await appendFile(
				resultsPath,
				`${JSON.stringify({ schemaVersion: 1, recordType: "delegation_run", ...record })}\n`,
				"utf8",
			);
			await rm(workspace, { recursive: true, force: true });
		}

		// The only hard assertion: the harness ran. Whether the model chose to
		// delegate is the measurement, not a pass condition.
		expect(
			record.infra,
			`Infrastructure failure; metrics appended to ${resultsPath}: ${JSON.stringify(record)}`,
		).toBe(false);
	}, 600_000);
});
