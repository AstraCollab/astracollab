/**
 * Workflows: the ones a workspace has, and the runs it is making of them.
 *
 * A workflow in a workspace is a file under `.nah/workflows` — a real piece of the
 * user's project, versionable with it and editable by hand. So the Studio does not
 * keep its own copy of one: it reads the file, shows what the file builds, writes
 * the file back when the user edits it, and re-reads on every request so an edit
 * made in an editor shows up here the same way it does in the terminal.
 *
 * Runs are the other half. They happen in this process rather than in someone
 * else's terminal, so the Studio owns their lifetime: it holds the abort handle,
 * it records each step as the run reports it, and a run the user stopped ends
 * because the browser asked it to.
 */
import { randomUUID } from "node:crypto";
import { readFile, rename, unlink, writeFile } from "node:fs/promises";
import { basename, join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import {
	WORKSPACE_WORKFLOW_DIR,
	loadWorkspaceWorkflows,
	resolveWorkspaceWorkflow,
} from "nah-ai/workflows";
import {
	type Orchestrator,
	type Workflow,
	type WorkflowEvent,
	type WorkflowRegistry,
	createWorkflowRegistry,
	workflowSteps,
} from "not-another-harness";

import type { StudioStore } from "./store.js";
import type { WorkflowRunStatus, WorkflowSummary } from "./wire.js";

/** Extensions the loader accepts, so the editor cannot save to a name nothing reads. */
const WORKFLOW_EXTENSIONS = [".mjs", ".js"];

const message = (error: unknown): string =>
	error instanceof Error ? error.message : String(error);

export type WorkflowCatalogOptions = {
	/** The workspace the Studio watches. Where `.nah/workflows` is looked for. */
	cwd: string;
	/**
	 * Resolves a name to a workflow, and what runs it.
	 *
	 * Null only stops a workflow from being *run*: the list, the graph and the
	 * editor all work without a model, because a workflow you cannot start today is
	 * still a workflow you need to be able to read.
	 */
	runner: {
		registry: WorkflowRegistry;
		orchestrator: Orchestrator;
		model: string | null;
	} | null;
};

export class WorkflowCatalog {
	readonly #cwd: string;
	readonly #runner: WorkflowCatalogOptions["runner"];

	constructor(options: WorkflowCatalogOptions) {
		this.#cwd = options.cwd;
		this.#runner = options.runner;
	}

	/** The absolute directory workflow files are read from. */
	get directory(): string {
		return join(this.#cwd, ...WORKSPACE_WORKFLOW_DIR.split("/"));
	}

	/** Whether this catalog can start a run, and the model it would run it on. */
	get canRun(): boolean {
		return this.#runner !== null;
	}

	get model(): string | null {
		return this.#runner?.model ?? null;
	}

	/**
	 * What actually runs a workflow, when there is a model to run it on.
	 *
	 * Null exactly when `canRun` is false, and every caller checks that first: the
	 * list, the graph and the editor all work with no model at all, so the runner
	 * is something this class holds rather than something it requires.
	 */
	get orchestrator(): Orchestrator | null {
		return this.#runner?.orchestrator ?? null;
	}

	/**
	 * Every workflow, with the file it came from.
	 *
	 * The directory is read on every call rather than cached for the life of the
	 * process, because a workflow the agent wrote two minutes ago is much of the
	 * point of showing these here: a roster frozen at startup would not have it.
	 */
	async list(): Promise<WorkflowSummary[]> {
		// A registry of its own rather than the runner's. Loading into the runner's
		// would throw the moment two files exported the same id, and this is the code
		// whose whole job is to show both files.
		const registry = createWorkflowRegistry();
		const { loaded, failed } = await loadWorkspaceWorkflows({
			cwd: this.#cwd,
			registry,
		});

		const summaries: WorkflowSummary[] = [];
		for (const { file, ids } of loaded) {
			const source = await readFile(file, "utf8").catch(() => undefined);
			for (const id of ids) {
				const workflow = registry.get(id);
				summaries.push({
					id,
					...(workflow?.description
						? { description: workflow.description }
						: {}),
					file,
					editable: true,
					steps: workflow ? workflowSteps(workflow) : [],
					...(source === undefined ? {} : { source }),
				});
			}
		}

		// The ones built into nah have no file, so they are listed from the runner's
		// registry and cannot be edited: they are code in nah, not in this workspace.
		for (const { id, description } of this.#runner?.registry.list() ?? []) {
			if (summaries.some((entry) => entry.id === id)) continue;
			const workflow = this.#runner?.registry.get(id);
			summaries.push({
				id,
				...(description ? { description } : {}),
				file: null,
				editable: false,
				steps: workflow ? workflowSteps(workflow) : [],
			});
		}

		// Named, not swallowed: a file that will not load is a workflow the user
		// believes they have, and a list that quietly omits it is worse than an error.
		for (const { file, error } of failed) {
			summaries.push({
				id: basename(file),
				file,
				editable: true,
				steps: [],
				error,
			});
		}

		return summaries.sort((a, b) => a.id.localeCompare(b.id));
	}

	/** One workflow by id, or null when there is no such workflow. */
	async get(id: string): Promise<WorkflowSummary | null> {
		return (await this.list()).find((entry) => entry.id === id) ?? null;
	}

	/**
	 * The runnable workflow behind an id, resolved the way the terminal resolves it.
	 *
	 * Registry first, then the files: a workspace workflow written during this
	 * session is not in the registry, and refusing to run it because the Studio
	 * started before it existed would be its own kind of wrong.
	 */
	async resolve(id: string): Promise<Workflow | undefined> {
		if (!this.#runner) return undefined;
		return resolveWorkspaceWorkflow({
			cwd: this.#cwd,
			registry: this.#runner.registry,
			id,
		});
	}

	/**
	 * Save new source for a workflow, if it still loads.
	 *
	 * Written to a sibling file and imported before it replaces anything: an editor
	 * that saves half a change would otherwise leave the workspace with a workflow
	 * that cannot be run, and no way to tell which keystroke did it. The scratch
	 * file carries a `.mjs` name because the loader decides how to import a file
	 * from its extension, and a temp name would not be one it reads.
	 */
	async save(
		id: string,
		source: string,
	): Promise<{ ok: true; workflow: WorkflowSummary } | { error: string }> {
		const entry = await this.get(id);
		if (!entry) return { error: `no workflow named "${id}"` };
		if (!entry.editable || !entry.file)
			return { error: `"${id}" is built into nah; there is no file to edit` };

		const file = resolve(entry.file);
		if (!file.startsWith(this.directory + sep)) {
			return { error: `${entry.file} is not under ${WORKSPACE_WORKFLOW_DIR}` };
		}

		const scratch = `${file.slice(0, file.length - basename(file).length)}${randomUUID()}.mjs`;
		try {
			await writeFile(scratch, source, "utf8");
			await import(`${pathToFileURL(scratch).href}?nah=${Date.now()}`);
		} catch (error) {
			await unlink(scratch).catch(() => undefined);
			return { error: message(error) };
		}

		// The import above loaded the scratch file, not this one, so nothing already
		// in the registry is stale by name — but the file on disk is new all the same,
		// and every request re-reads it.
		await rename(scratch, file);
		return { ok: true, workflow: (await this.get(id))! };
	}
}

/**
 * The runs this process is making of the workspace's workflows.
 *
 * Separate from the catalog because the two answer different questions and have
 * very different lifetimes: the catalog is a reading of the filesystem and is
 * stateless, while a run is an in-flight thing with an abort handle that only
 * makes sense inside the process that started it.
 */
export class WorkflowRuns {
	readonly #store: StudioStore;
	readonly #catalog: WorkflowCatalog;
	/** Runs started here and not yet settled, by id. */
	readonly #live = new Map<string, AbortController>();
	readonly #stopped = new Set<string>();

	constructor(options: { store: StudioStore; catalog: WorkflowCatalog }) {
		this.#store = options.store;
		this.#catalog = options.catalog;
	}

	/**
	 * Start a run and return its id immediately.
	 *
	 * Immediate because a workflow is a sequence of model calls and can run for
	 * minutes: a request that held the connection open for that long is a request
	 * the browser will eventually report as failed, and a run with no id is a run
	 * nobody can watch or stop. The run's own row is written before this returns, so
	 * the canvas has the whole graph to draw the moment the caller has an id.
	 */
	async launch(
		workflowId: string,
		input: unknown,
	): Promise<{ ok: true; runId: string } | { error: string }> {
		if (!this.#catalog.canRun)
			return {
				error: "no model is configured, so this Studio cannot run workflows",
			};
		const workflow = await this.#catalog.resolve(workflowId);
		if (!workflow) return { error: `no workflow named "${workflowId}"` };

		const run = workflow.createRun();
		const steps = workflowSteps(workflow);
		this.#store.startWorkflowRun({
			runId: run.runId,
			workflowId,
			input,
			model: this.#catalog.model,
			steps: steps.map(({ id }) => id),
		});

		const controller = new AbortController();
		this.#live.set(run.runId, controller);

		// Background, like an experiment: the caller polls the run it was just given.
		void (async () => {
			try {
				const result = await this.#catalog.orchestrator?.runWorkflow(workflow, {
					inputData: input as never,
					signal: controller.signal,
					onEvent: (event) => this.#record(run.runId, event),
				});
				const stopped = this.#stopped.has(run.runId);
				this.#store.finishWorkflowRun(run.runId, {
					status: stopped ? "stopped" : (result.status as WorkflowRunStatus),
					...(result.status === "success" ? { output: result.result } : {}),
					...(result.status === "failed"
						? { error: result.error.message }
						: {}),
				});
			} catch (error) {
				// A run that throws rather than settling — an aborted signal surfacing at
				// the wrong moment, say — still has to leave a row that says it stopped
				// rather than one stuck on `running` forever.
				this.#store.finishWorkflowRun(run.runId, {
					status: "stopped",
					error: message(error),
				});
			} finally {
				this.#live.delete(run.runId);
				this.#stopped.delete(run.runId);
			}
		})();

		return { ok: true, runId: run.runId };
	}

	/**
	 * Stop a run this process started.
	 *
	 * Refuses a run id it does not have, the same way the agent stop route refuses
	 * to kill another machine's process: a run that is not ours is somebody else's
	 * terminal, and a browser button is not consent.
	 */
	stop(runId: string): { ok: boolean; reason?: string } {
		const controller = this.#live.get(runId);
		if (!controller) return { ok: false, reason: "no such run in this Studio" };
		this.#stopped.add(runId);
		controller.abort(new Error("stopped from the Studio"));
		return { ok: true };
	}

	isRunning(runId: string): boolean {
		return this.#live.has(runId);
	}

	/** Write one event into the store. The whole of the canvas comes from here. */
	#record(runId: string, event: WorkflowEvent): void {
		const stepId = "stepId" in event ? event.stepId : null;
		if (!stepId) return;
		switch (event.type) {
			case "step-start":
				this.#store.updateWorkflowStep(runId, stepId, {
					status: "running",
					startedAt: Date.now(),
					input: event.input,
				});
				break;
			case "step-delta":
				this.#store.updateWorkflowStep(runId, stepId, { text: event.text });
				break;
			case "step-finish":
				this.#store.updateWorkflowStep(runId, stepId, {
					status: "success",
					finishedAt: Date.now(),
					durationMs: event.durationMs,
					output: event.output,
				});
				break;
			case "step-suspend":
				this.#store.updateWorkflowStep(runId, stepId, {
					status: "suspended",
					output: event.payload,
				});
				break;
			case "step-error":
				this.#store.updateWorkflowStep(runId, stepId, {
					status: "failed",
					finishedAt: Date.now(),
					error: event.error.message,
				});
				break;
			default:
				// `workflow-start`, `workflow-suspended` and `workflow-finish` carry no
				// step; the run's own row says where the run got to.
				break;
		}
	}
}
