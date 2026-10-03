/**
 * A workflow engine: repeatable task sequences defined as data, not prose.
 *
 * ## Why this exists next to `runAgent`
 *
 * `runAgent` hands the plan to a model and hopes it sequences the work. That is
 * the right shape for work whose shape is not known yet, and the wrong shape for
 * work that happens every week. A workflow states the steps, their order, and the
 * data each one consumes, so the same sequence runs the same way on every
 * invocation — and the expensive part (the agent) is confined to the steps that
 * actually need judgement.
 *
 * ## Why steps are the unit of work
 *
 * A step declares its input and output as schemas, so the shape of the data
 * moving through a sequence is checked at every hop rather than assumed at the
 * end. That is the whole difference from a prompt that asks for several things
 * in order: the order is in the code, and it holds when nobody is watching.
 *
 * ## What is deliberately absent
 *
 * No durable storage, no distributed runners. A run lives in the process that
 * started it, and a suspended run is resumed from an in-memory snapshot. That is
 * enough for repeatable tasks inside an agent session, and claiming otherwise
 * here would be a promise this package cannot keep.
 */
import { randomUUID } from "node:crypto";
import type { z } from "zod";

/** Arbitrary caller data handed to every step. The orchestrator puts `delegate` here. */
export type WorkflowContext = Record<string, unknown>;

/**
 * Thrown by a step to stop the run and wait for the caller.
 *
 * A distinct class rather than a status on the return value because a suspended
 * step and a failed step look identical from the return type, and picking the
 * wrong one silently drops work.
 */
export class StepSuspend<Payload = unknown> extends Error {
	constructor(public readonly payload?: Payload) {
		super(typeof payload === "string" ? payload : "step suspended");
		this.name = "StepSuspend";
	}
}

/** What a step gets handed: its input, the run's shared state, and the caller's context. */
export type StepExecuteArgs<
	TInput = unknown,
	TState = Record<string, unknown>,
> = {
	inputData: TInput;
	/** Shared workflow state. Read it; use `setState` to change it. */
	state: TState;
	/**
	 * Merge into state for later steps.
	 *
	 * Merge rather than replace, and applied immediately, because a step that
	 * accumulates (`setState({ count: state.count + 1 })`) and one that shares
	 * configuration with the rest of the run are both reading `state` as if their
	 * write were the only one.
	 */
	setState: (
		partial: Partial<TState> | ((current: TState) => Partial<TState>),
	) => void;
	/** Stream partial text out of a step. Only wired for `run.stream()`. */
	writer: (chunk: string) => void;
	/** Caller-supplied context, identical for every step of every nested workflow. */
	context: WorkflowContext;
	/**
	 * The run's abort signal.
	 *
	 * Handed down rather than checked only between steps: a step that spawns a child
	 * agent or a request has to be able to cancel it, or aborting a run leaves work
	 * running against a workspace the caller believes it has already abandoned.
	 */
	signal?: AbortSignal;
	/** Data handed to `run.resume()`, on the step that suspended. */
	resumeData?: unknown;
};

export type WorkflowStep<TInput = any, TOutput = any, TState = any> = {
	readonly __step: true;
	readonly id: string;
	readonly description?: string;
	readonly inputSchema?: z.ZodType<TInput>;
	readonly outputSchema?: z.ZodType<TOutput>;
	readonly stateSchema?: z.ZodType<TState>;
	execute: (
		args: StepExecuteArgs<TInput, TState>,
	) => Promise<TOutput> | TOutput;
};

/**
 * Define one step.
 *
 * `inputSchema`/`outputSchema` are enforced, not documentation: a step that
 * returns the wrong shape fails the run with the validation error rather than
 * feeding a malformed value into whatever reads it next.
 */
export const createStep = <TInput = any, TOutput = any, TState = any>(config: {
	id: string;
	description?: string;
	inputSchema?: z.ZodType<TInput>;
	outputSchema?: z.ZodType<TOutput>;
	stateSchema?: z.ZodType<TState>;
	execute: (
		args: StepExecuteArgs<TInput, TState>,
	) => Promise<TOutput> | TOutput;
}): WorkflowStep<TInput, TOutput, TState> => ({ __step: true, ...config });

export const isStep = (value: unknown): value is WorkflowStep =>
	(value as WorkflowStep | undefined)?.__step === true;

/** A runnable unit a workflow can contain: a step, a nested workflow, or a composition. */
export type WorkflowNode = {
	/** Stable handle used to cache a node's output so a resumed run can skip it. */
	key: string;
} & (
	| { kind: "step"; step: WorkflowStep }
	| { kind: "workflow"; workflow: Workflow<any, any, any> }
	| { kind: "sequence"; nodes: WorkflowNode[] }
	| { kind: "parallel"; branches: WorkflowNode[][] }
	| {
			kind: "branch";
			conditions: Array<{ when: BranchCondition; node: WorkflowNode }>;
			otherwise?: WorkflowNode;
	  }
	| {
			kind: "map";
			inputKey: string;
			outputKey: string;
			mapper: (item: any) => WorkflowNodeLike;
	  }
);

/**
 * A branch condition, handed the previous step's output and the run's context.
 *
 * A condition that cannot see what it is branching on is just a lookup.
 */
export type BranchCondition = (
	previous: unknown,
	context: WorkflowContext,
) => boolean | Promise<boolean>;

/** What one step did, kept so a caller can inspect a run without replaying it. */
export type StepRecord = {
	id: string;
	status: "success" | "failed" | "suspended";
	/** The value the step received, after schema selection and validation. */
	input?: unknown;
	/** The value the step returned, after output validation. */
	output?: unknown;
	durationMs: number;
	error?: string;
	suspendPayload?: unknown;
};

type WorkflowRunCommon = {
	/** The workflow's `id`. */
	workflowId: string;
	runId: string;
	input: unknown;
	/** Every step that ran, in order, keyed by step id. Nested ids are `workflow/step`. */
	steps: Record<string, StepRecord>;
	state: unknown;
	durationMs: number;
};

export type WorkflowRunResult<TOutput = any, TInput = any, TState = any> =
	| (WorkflowRunCommon & {
			status: "success";
			result: TOutput;
			input: TInput;
			state: TState;
	  })
	| (WorkflowRunCommon & { status: "failed"; error: Error })
	| (WorkflowRunCommon & {
			status: "suspended";
			suspendPayload: unknown;
			suspended: string[];
	  });

/** Typed events for `run.stream()`. */
export type WorkflowEvent<TState = any> =
	| {
			type: "workflow-start";
			workflowId: string;
			runId: string;
			input: unknown;
	  }
	| { type: "step-start"; workflowId: string; stepId: string; input: unknown }
	| { type: "step-delta"; workflowId: string; stepId: string; text: string }
	| {
			type: "step-finish";
			workflowId: string;
			stepId: string;
			output: unknown;
			durationMs: number;
	  }
	| {
			type: "step-suspend";
			workflowId: string;
			stepId: string;
			payload: unknown;
	  }
	| { type: "step-error"; workflowId: string; stepId: string; error: Error }
	| { type: "workflow-suspended"; workflowId: string; suspended: string[] }
	| {
			type: "workflow-finish";
			workflowId: string;
			result: WorkflowRunResult<unknown, unknown, TState>;
	  };

export type WorkflowRunStatus =
	| "running"
	| "waiting"
	| "success"
	| "failed"
	| "suspended";

/** Everything needed to pick up where a suspended run stopped. */
export type WorkflowSnapshot<TState = any> = {
	workflowId: string;
	runId: string;
	input: unknown;
	state: TState;
	steps: Record<string, StepRecord>;
	/** Step ids still to run, with the payload each suspended on. */
	pending: Array<{ id: string; payload: unknown }>;
};

/** How a caller starts or continues a run. */
export type WorkflowRunOptions<TInput = any> = {
	inputData?: TInput;
	context?: WorkflowContext;
	signal?: AbortSignal;
	/**
	 * Every event, as it happens.
	 *
	 * A second view of the same run, not a second one: the `stream` iterable and
	 * this callback see identical events. A caller uses one or the other, because
	 * the callback exists for callers that want progress without maintaining a
	 * queue, and a caller that opens both is reading the same run twice.
	 */
	onEvent?: (event: WorkflowEvent) => void;
};

export type WorkflowResumeOptions = Omit<WorkflowRunOptions, "inputData"> & {
	resumeData?: unknown;
};

/**
 * A live run: `start` waits, `stream` reports progress while it works, `resume`
 * continues a suspended run, `status`/`result` describe where it got to.
 */
export type WorkflowRun<TOutput = any, TInput = any, TState = any> = {
	readonly runId: string;
	readonly workflow: Workflow<TOutput, TInput, TState>;
	readonly status: WorkflowRunStatus;
	/** Settles when the run finishes. Reading it before `start()` starts the run with no input. */
	readonly result: Promise<WorkflowRunResult<TOutput, TInput, TState>>;
	start(
		opts?: WorkflowRunOptions<TInput>,
	): Promise<WorkflowRunResult<TOutput, TInput, TState>>;
	stream(opts?: WorkflowRunOptions<TInput>): {
		events: AsyncIterable<WorkflowEvent<TState>>;
		result: Promise<WorkflowRunResult<TOutput, TInput, TState>>;
	};
	resume(
		opts?: WorkflowResumeOptions,
	): Promise<WorkflowRunResult<TOutput, TInput, TState>>;
	resumeStream(opts?: WorkflowResumeOptions): {
		events: AsyncIterable<WorkflowEvent<TState>>;
		result: Promise<WorkflowRunResult<TOutput, TInput, TState>>;
	};
	/** Enough to resume later, while this run object is alive. Null once the run has settled. */
	snapshot(): WorkflowSnapshot<TState> | null;
};

export type Workflow<TOutput = any, TInput = any, TState = any> = {
	readonly __workflow: true;
	readonly id: string;
	readonly description?: string;
	readonly inputSchema?: z.ZodType<TInput>;
	readonly outputSchema?: z.ZodType<TOutput>;
	readonly stateSchema?: z.ZodType<TState>;
	/** Whether the workflow starts a fresh state when it is run or as a nested step. */
	readonly standaloneState: boolean;
	createRun(): WorkflowRun<TOutput, TInput, TState>;
};

/** One argument to `then` / `parallel` / `branch`: a step, a workflow, or a composition. */
export type WorkflowNodeLike =
	| WorkflowStep
	| Workflow<any, any, any>
	| WorkflowNode
	| Array<WorkflowStep | Workflow<any, any, any> | WorkflowNode>;

/** The builder. Steps accumulate; nothing runs until `commit()`. */
export type WorkflowBuilder<TOutput = any, TInput = any, TState = any> = {
	then(node: WorkflowNodeLike): WorkflowBuilder<TOutput, TInput, TState>;
	/** Run every branch concurrently; the array of their outputs is the value. */
	parallel(
		branches: WorkflowNodeLike[],
	): WorkflowBuilder<TOutput, TInput, TState>;
	/** First matching condition wins; `otherwise` runs when none match. */
	branch(
		conditions: Array<[BranchCondition, WorkflowNodeLike]>,
		options?: { otherwise?: WorkflowNodeLike },
	): WorkflowBuilder<TOutput, TInput, TState>;
	/** Fan out over `inputKey`, collecting each branch's output under `outputKey`. */
	map(options: {
		inputKey: string;
		outputKey: string;
		mapper: (item: any) => WorkflowNodeLike;
	}): WorkflowBuilder<TOutput, TInput, TState>;
	commit(): Workflow<TOutput, TInput, TState>;
};

/** Depth ceiling on nesting, which is how a cycle becomes an error instead of a hang. */
const MAX_DEPTH = 64;

/** Fan-out ceiling, so one `.parallel()` of a thousand cannot become a thousand model calls. */
const MAX_FAN_OUT = 64;

/** A single-element queue drains as fast as its producer, so polling is bounded and cheap. */
const STREAM_TICK_MS = 4;

const stepNode = (value: WorkflowNodeLike, key: string): WorkflowNode => {
	const items = Array.isArray(value) ? value : [value];
	if (items.length === 0) return { key, kind: "sequence", nodes: [] };
	const nodes = items.map((item, index) =>
		stepNodeOne(item, `${key}.${index}`),
	);
	return items.length === 1 && !Array.isArray(value)
		? nodes[0]!
		: { key, kind: "sequence", nodes };
};

const stepNodeOne = (
	value: WorkflowStep | Workflow<any, any, any> | WorkflowNode,
	key: string,
): WorkflowNode => {
	if (isStep(value)) return { key, kind: "step", step: value };
	if ((value as Workflow<any, any, any>)?.__workflow)
		return {
			key,
			kind: "workflow",
			workflow: value as Workflow<any, any, any>,
		};
	const node = value as WorkflowNode | undefined;
	if (!node?.kind)
		throw new Error(
			"workflow: a composition argument must be a step, a workflow, or another composition",
		);
	return node;
};

/**
 * Pick what the next step receives from what the last one returned.
 *
 * Two rules, and the order matters. When the next step declares an *object*
 * schema, its keys are read off the previous output — that is what makes a
 * three-step chain ergonomic without threading a growing envelope through every
 * `inputSchema`. When none of those keys exist, the previous output is passed
 * whole, because a step whose schema shares nothing with the last output is
 * almost always asking for that output directly.
 *
 * Chosen over always-picking-keys because the first step of a workflow would
 * otherwise receive `{}` instead of the workflow's own input.
 */
const resolveInput = (
	previous: unknown,
	schema: z.ZodType | undefined,
): unknown => {
	if (!schema) return previous;
	const shape = (schema as unknown as { shape?: unknown }).shape;
	if (!shape || typeof previous !== "object" || previous === null)
		return previous;
	const keys = Object.keys(shape as Record<string, unknown>);
	const present = keys.filter(
		(key) => key in (previous as Record<string, unknown>),
	);
	if (present.length === 0) return previous;
	const picked: Record<string, unknown> = {};
	for (const key of present)
		picked[key] = (previous as Record<string, unknown>)[key];
	return picked;
};

const validate = (
	schema: z.ZodType | undefined,
	value: unknown,
	label: string,
): unknown => {
	if (!schema) return value;
	const parsed = schema.safeParse(value);
	if (parsed.success) return parsed.data;
	throw new Error(
		`${label}: ${parsed.error.issues.map((issue) => `${issue.path.join(".") || "(root)"} ${issue.message}`).join("; ")}`,
	);
};

const isPlainObjectSchema = (
	schema: z.ZodType | undefined,
): schema is z.ZodType<Record<string, unknown>> & {
	shape: Record<string, z.ZodTypeAny>;
} => {
	const shape = (schema as unknown as { shape?: unknown } | undefined)?.shape;
	return Boolean(shape) && typeof shape === "object";
};

/** Seed a run's state from its schema's defaults, so step two can read what step one would write. */
const initialState = <TState>(workflow: Workflow<any, any, TState>): TState => {
	const schema = workflow.stateSchema;
	if (!isPlainObjectSchema(schema)) return {} as TState;
	const seed: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(schema.shape)) {
		// A default lives on the wrapper's def in this schema library, and can be a
		// thunk for values that cannot be built eagerly.
		const def = (
			value as {
				_zod?: { def?: { defaultValue?: unknown; default?: unknown } };
			}
		)._zod?.def;
		const fallback = def?.defaultValue ?? def?.default;
		seed[key] =
			typeof fallback === "function" ? (fallback as () => unknown)() : fallback;
	}
	return seed as TState;
};

/** A run's live state. Shared by the engine and the caller's status/result accessors. */
type RunState = {
	workflowId: string;
	runId: string;
	status: WorkflowRunStatus;
	result?: WorkflowRunResult;
	steps: Record<string, StepRecord>;
	/** A node's value once it has run, keyed by node key — what lets a resume skip it. */
	outputs: Record<string, unknown>;
	state: Record<string, unknown>;
	pending: Array<{ id: string; payload: unknown }>;
	input?: unknown;
	/** True while this execution continues a suspended one, which is what makes it skip finished work. */
	resuming: boolean;
	context: WorkflowContext;
	onEvent?: (event: WorkflowEvent) => void;
	/** Aborting it stops the run between steps, and reaches a step that forwards the signal. */
	signal?: AbortSignal;
	emit: (event: WorkflowEvent) => void;
};

type NodeOutcome = { value: unknown; suspended: boolean };

/**
 * Reads of `run.status` go through a function on purpose.
 *
 * A step can suspend a run from several frames down, so the status at the point
 * of a check is not the one last assigned in this frame. Reading it as a
 * function keeps the type honest instead of narrowing to a stale literal.
 */
const isSuspended = (run: RunState): boolean => run.status === "suspended";

/** The composed graph and its step ids. Internal, but stable enough to serialise a run from. */
type WorkflowInternal = {
	__nodes: WorkflowNode[];
	__nodeIds: Record<string, true>;
};

const internalsOf = (workflow: Workflow<any, any, any>): WorkflowInternal =>
	workflow as unknown as WorkflowInternal;

/** Step ids in a node's subtree. Used to decide whether a resumed run can skip it. */
const stepIdsIn = (node: WorkflowNode): string[] => {
	switch (node.kind) {
		case "step":
			return [node.step.id];
		case "workflow":
			// A nested workflow records its own steps; `isComplete` reads them directly.
			return [];
		case "sequence":
			return node.nodes.flatMap(stepIdsIn);
		case "parallel":
			return node.branches.flat().flatMap(stepIdsIn);
		case "branch":
			return [
				...node.conditions.map(({ node: child }) => stepIdsIn(child)),
				...(node.otherwise ? [stepIdsIn(node.otherwise)] : []),
			].flat();
		case "map":
			return [];
	}
};

/**
 * True when every step under this node already finished successfully, and the
 * node's value is cached — so a resumed run can reuse it instead of repeating
 * whatever side effects it had.
 */
const isComplete = (node: WorkflowNode, run: RunState): boolean => {
	if (!run.resuming) return false;
	if (node.kind === "workflow") {
		const nestedIds = Object.keys(internalsOf(node.workflow).__nodeIds ?? {});
		return (
			nestedIds.length > 0 &&
			nestedIds.every(
				(id) => run.steps[`${node.workflow.id}/${id}`]?.status === "success",
			) &&
			node.key in run.outputs
		);
	}
	if (node.kind === "step")
		return (
			run.steps[node.step.id]?.status === "success" && node.key in run.outputs
		);
	const ids = stepIdsIn(node);
	if (ids.length === 0) return false;
	return (
		ids.every((id) => run.steps[id]?.status === "success") &&
		node.key in run.outputs
	);
};

/**
 * Run one node, threading `value` through it.
 *
 * Returns the node's output and whether it suspended. The flag is separate from
 * the value because a suspended step has no value while the run's state still
 * has to be kept.
 */
const runNode = async (
	node: WorkflowNode,
	value: unknown,
	run: RunState,
	depth: number,
	resumeData: unknown,
): Promise<NodeOutcome> => {
	if (depth > MAX_DEPTH)
		throw new Error(
			"workflow: composition nested too deep — that is a cycle, not a workflow",
		);
	// A resumed run replays only what did not finish. Everything else keeps its
	// recorded output, so a step that spent money or wrote a file does not do it
	// twice — including inside a partly-finished sequence or parallel fan-out.
	if (isComplete(node, run))
		return { value: run.outputs[node.key], suspended: false };

	switch (node.kind) {
		case "step": {
			const { step } = node;
			// Checked before the step starts, so an aborted run fails the step it was
			// about to run rather than reporting a success nobody is waiting for.
			run.signal?.throwIfAborted();
			const input = validate(
				step.inputSchema,
				resolveInput(value, step.inputSchema),
				`step "${step.id}" input`,
			);
			const writer = (chunk: string) =>
				run.emit({
					type: "step-delta",
					workflowId: run.workflowId,
					stepId: step.id,
					text: chunk,
				});
			run.emit({
				type: "step-start",
				workflowId: run.workflowId,
				stepId: step.id,
				input,
			});
			const startedAt = Date.now();
			try {
				const raw = await step.execute({
					inputData: input as never,
					state: run.state as never,
					setState: (partial) => {
						Object.assign(
							run.state,
							typeof partial === "function"
								? partial(run.state as never)
								: partial,
						);
					},
					writer,
					context: run.context,
					signal: run.signal,
					resumeData,
				});
				const output = validate(
					step.outputSchema,
					raw,
					`step "${step.id}" output`,
				);
				const durationMs = Date.now() - startedAt;
				run.steps[step.id] = {
					id: step.id,
					status: "success",
					input,
					output,
					durationMs,
				};
				run.outputs[node.key] = output;
				run.emit({
					type: "step-finish",
					workflowId: run.workflowId,
					stepId: step.id,
					output,
					durationMs,
				});
				return { value: output, suspended: false };
			} catch (error) {
				if (error instanceof StepSuspend) {
					const durationMs = Date.now() - startedAt;
					run.steps[step.id] = {
						id: step.id,
						status: "suspended",
						input,
						durationMs,
						suspendPayload: error.payload,
					};
					run.pending = [{ id: step.id, payload: error.payload }];
					run.status = "suspended";
					run.emit({
						type: "step-suspend",
						workflowId: run.workflowId,
						stepId: step.id,
						payload: error.payload,
					});
					return { value: undefined, suspended: true };
				}
				const failure =
					error instanceof Error ? error : new Error(String(error));
				run.steps[step.id] = {
					id: step.id,
					status: "failed",
					input,
					durationMs: Date.now() - startedAt,
					error: failure.message,
				};
				run.emit({
					type: "step-error",
					workflowId: run.workflowId,
					stepId: step.id,
					error: failure,
				});
				throw failure;
			}
		}
		case "workflow": {
			const nested = node.workflow.createRun();
			const result = await nested.start({
				inputData: resolveInput(value, node.workflow.inputSchema) as never,
				context: run.context,
			});
			for (const record of Object.values(result.steps))
				run.steps[`${node.workflow.id}/${record.id}`] = record;
			if (result.status === "suspended") {
				// The nested run cannot be resumed from here, so the parent records where
				// it stopped and replays the nested body on resume. Documented rather than
				// hidden: pretending it resumes mid-body would repeat its side effects.
				run.state = result.state as Record<string, unknown>;
				run.status = "suspended";
				run.pending = [
					{ id: node.workflow.id, payload: result.suspendPayload },
				];
				return { value: undefined, suspended: true };
			}
			if (result.status === "failed") {
				run.steps[node.workflow.id] = {
					id: node.workflow.id,
					status: "failed",
					durationMs: result.durationMs,
					error: result.error.message,
				};
				throw result.error;
			}
			run.outputs[node.key] = result.result;
			return { value: result.result, suspended: false };
		}
		case "sequence": {
			let current = value;
			for (const child of node.nodes) {
				const outcome = await runNode(
					child,
					current,
					run,
					depth + 1,
					undefined,
				);
				if (outcome.suspended) return { value: undefined, suspended: true };
				current = outcome.value;
			}
			run.outputs[node.key] = current;
			return { value: current, suspended: false };
		}
		case "parallel": {
			if (node.branches.length > MAX_FAN_OUT)
				throw new Error(
					`workflow: parallel fan-out of ${node.branches.length} exceeds the ${MAX_FAN_OUT} limit`,
				);
			const settled = await Promise.allSettled(
				node.branches.map((branch) =>
					runNode(
						{ key: node.key, kind: "sequence", nodes: branch },
						value,
						run,
						depth + 1,
						undefined,
					),
				),
			);
			const failure = settled.find(
				(entry): entry is PromiseRejectedResult => entry.status === "rejected",
			);
			if (failure) throw failure.reason;
			if (isSuspended(run)) return { value: undefined, suspended: true };
			const values = settled.map(
				(entry) => (entry as PromiseFulfilledResult<NodeOutcome>).value.value,
			);
			run.outputs[node.key] = values;
			return { value: values, suspended: false };
		}
		case "branch": {
			for (const condition of node.conditions) {
				if (await condition.when(value, run.context))
					return runNode(condition.node, value, run, depth + 1, undefined);
			}
			if (node.otherwise)
				return runNode(node.otherwise, value, run, depth + 1, undefined);
			run.outputs[node.key] = value;
			return { value, suspended: false };
		}
		case "map": {
			const source = (value ?? {}) as Record<string, unknown>;
			const items = source[node.inputKey];
			if (!Array.isArray(items))
				throw new Error(`workflow: map expects an array at "${node.inputKey}"`);
			if (items.length > MAX_FAN_OUT)
				throw new Error(
					`workflow: map fan-out of ${items.length} exceeds the ${MAX_FAN_OUT} limit`,
				);
			const perItem = await Promise.all(
				items.map(async (item, index) =>
					runNode(
						stepNode(node.mapper(item), `${node.key}[${index}]`),
						item,
						run,
						depth + 1,
						undefined,
					),
				),
			);
			if (isSuspended(run)) return { value: undefined, suspended: true };
			const collected = {
				...source,
				[node.outputKey]: perItem.map((entry) => entry.value),
			};
			run.outputs[node.key] = collected;
			return { value: collected, suspended: false };
		}
	}
};

const createEngineRun = <TOutput, TInput, TState>(
	workflow: Workflow<TOutput, TInput, TState>,
): WorkflowRun<TOutput, TInput, TState> => {
	const runId = randomUUID();
	let emit: (event: WorkflowEvent) => void = () => {};
	const run: RunState = {
		workflowId: workflow.id,
		runId,
		status: "running",
		steps: {},
		outputs: {},
		state: initialState(workflow) as Record<string, unknown>,
		pending: [],
		resuming: false,
		context: {},
		onEvent: undefined,
		emit: (event) => {
			emit(event);
			run.onEvent?.(event);
		},
	};

	const settle = (
		status: WorkflowRunStatus,
		extra: Record<string, unknown>,
		startedAt: number,
	): WorkflowRunResult => {
		run.status = status;
		const result = {
			status,
			workflowId: workflow.id,
			runId,
			input: run.input,
			steps: { ...run.steps },
			state: { ...run.state },
			durationMs: Date.now() - startedAt,
			...extra,
		} as WorkflowRunResult;
		run.result = result;
		return result;
	};

	const execute = async (options?: {
		inputData?: TInput;
		context?: WorkflowContext;
		resumeData?: unknown;
		signal?: AbortSignal;
		onEvent?: (event: WorkflowEvent) => void;
		startedAt?: number;
	}): Promise<WorkflowRunResult<TOutput, TInput, TState>> => {
		const startedAt = options?.startedAt ?? Date.now();
		const resuming = isSuspended(run);
		if (options?.context) run.context = { ...run.context, ...options.context };
		if (options?.signal) run.signal = options.signal;
		if (options?.onEvent) run.onEvent = options.onEvent;
		// Set before the walk, not instead of the status: "running" is what the run is,
		// "resuming" is how this pass got here, and only the second one means skip.
		run.resuming = resuming;
		run.status = "running";
		let value: unknown = run.input;
		try {
			// Inside the try: bad input is a failed run like any other, not a throw at
			// the caller. A caller that starts a run gets a result either way.
			if (!resuming) {
				run.input = validate(
					workflow.inputSchema,
					options?.inputData,
					`workflow "${workflow.id}" input`,
				);
				emit({
					type: "workflow-start",
					workflowId: workflow.id,
					runId,
					input: run.input,
				});
				value = run.input;
			}
			for (const node of internalsOf(workflow).__nodes) {
				const outcome = await runNode(
					node,
					value,
					run,
					0,
					resuming ? options?.resumeData : undefined,
				);
				if (outcome.suspended) {
					const result = settle(
						"suspended",
						{
							suspendPayload: run.pending.at(-1)?.payload,
							suspended: run.pending.map((entry) => entry.id),
						},
						startedAt,
					);
					emit({
						type: "workflow-suspended",
						workflowId: workflow.id,
						suspended: run.pending.map((entry) => entry.id),
					});
					emit({ type: "workflow-finish", workflowId: workflow.id, result });
					return result as WorkflowRunResult<TOutput, TInput, TState>;
				}
				value = outcome.value;
			}
			const output = validate(
				workflow.outputSchema,
				value,
				`workflow "${workflow.id}" output`,
			);
			const result = settle("success", { result: output }, startedAt);
			emit({ type: "workflow-finish", workflowId: workflow.id, result });
			return result as WorkflowRunResult<TOutput, TInput, TState>;
		} catch (error) {
			const failure = error instanceof Error ? error : new Error(String(error));
			const result = settle("failed", { error: failure }, startedAt);
			emit({ type: "workflow-finish", workflowId: workflow.id, result });
			return result as WorkflowRunResult<TOutput, TInput, TState>;
		}
	};

	/** One execution, one event stream: both views of the same run, never two executions. */
	const stream = (options?: {
		inputData?: TInput;
		context?: WorkflowContext;
		resumeData?: unknown;
	}): {
		events: AsyncIterable<WorkflowEvent<TState>>;
		result: Promise<WorkflowRunResult<TOutput, TInput, TState>>;
	} => {
		const queue: WorkflowEvent<TState>[] = [];
		// Read through a function: the flag is set by the run's own promise, which the
		// generator below cannot see an assignment to.
		const lifecycle = { done: false };
		const isDone = (): boolean => lifecycle.done;
		emit = (event) => queue.push(event as WorkflowEvent<TState>);
		const result = execute({ ...options, startedAt: Date.now() });
		result.then(
			() => {
				lifecycle.done = true;
			},
			() => {
				lifecycle.done = true;
			},
		);
		const events = (async function* (): AsyncIterable<WorkflowEvent<TState>> {
			for (;;) {
				if (queue.length > 0) {
					yield queue.shift()!;
					continue;
				}
				if (isDone()) return;
				await new Promise((resolve) => setTimeout(resolve, STREAM_TICK_MS));
			}
		})();
		return { events, result };
	};

	let started: Promise<WorkflowRunResult<TOutput, TInput, TState>> | undefined;

	return {
		runId,
		workflow,
		get status() {
			return run.status;
		},
		get result() {
			started ??= execute({});
			return started;
		},
		start: async (options) => {
			const result = await execute({ ...options, startedAt: Date.now() });
			started = Promise.resolve(result);
			return result;
		},
		stream: (options) => {
			const handle = stream(options);
			started ??= handle.result;
			return handle;
		},
		resume: async (options) => {
			const result = await execute({ ...options, startedAt: Date.now() });
			started = Promise.resolve(result);
			return result;
		},
		resumeStream: (options) => {
			const handle = stream({ ...options });
			started ??= handle.result;
			return handle;
		},
		snapshot: () =>
			run.status === "suspended"
				? {
						workflowId: workflow.id,
						runId,
						input: run.input,
						state: run.state as TState,
						steps: { ...run.steps },
						pending: [...run.pending],
					}
				: null,
	};
};

/**
 * Define a workflow, then compose steps onto it and `commit()`.
 *
 * Nothing runs at definition time. A workflow is a value: it can be built in one
 * module, cloned under a second id, nested inside another, and started any number
 * of times with none of those runs sharing state.
 */
export const createWorkflow = <
	TOutput = any,
	TInput = any,
	TState = any,
>(config: {
	id: string;
	description?: string;
	inputSchema?: z.ZodType<TInput>;
	outputSchema?: z.ZodType<TOutput>;
	stateSchema?: z.ZodType<TState>;
}): WorkflowBuilder<TOutput, TInput, TState> => {
	const nodes: WorkflowNode[] = [];
	const builder: WorkflowBuilder<TOutput, TInput, TState> = {
		then(node) {
			nodes.push(stepNode(node, `${config.id}#${nodes.length}`));
			return builder;
		},
		parallel(branches) {
			const key = `${config.id}#${nodes.length}`;
			nodes.push({
				key,
				kind: "parallel",
				branches: branches.map((branch, index) =>
					Array.isArray(branch)
						? branch.map((item, inner) =>
								stepNode(item, `${key}.${index}.${inner}`),
							)
						: [stepNode(branch, `${key}.${index}`)],
				),
			});
			return builder;
		},
		branch(conditions, options) {
			const key = `${config.id}#${nodes.length}`;
			nodes.push({
				key,
				kind: "branch",
				conditions: conditions.map(([when, node], index) => ({
					when,
					node: stepNode(node, `${key}.${index}`),
				})),
				...(options?.otherwise === undefined
					? {}
					: { otherwise: stepNode(options.otherwise, `${key}.otherwise`) }),
			});
			return builder;
		},
		map({ inputKey, outputKey, mapper }) {
			nodes.push({
				key: `${config.id}#${nodes.length}`,
				kind: "map",
				inputKey,
				outputKey,
				mapper,
			});
			return builder;
		},
		commit() {
			const ids = new Set<string>();
			const visit = (node: WorkflowNode) => {
				if (node.kind === "step") {
					if (ids.has(node.step.id))
						throw new Error(
							`workflow "${config.id}": step "${node.step.id}" appears twice — step ids key the run's results, so they must be unique`,
						);
					ids.add(node.step.id);
					return;
				}
				if (node.kind === "workflow") {
					for (const nestedId of Object.keys(
						(node.workflow as unknown as { __nodeIds: Record<string, true> })
							.__nodeIds,
					)) {
						const full = `${node.workflow.id}/${nestedId}`;
						if (ids.has(full))
							throw new Error(
								`workflow "${config.id}": nested step "${full}" appears twice`,
							);
						ids.add(full);
					}
					return;
				}
				if (node.kind === "sequence") node.nodes.forEach(visit);
				if (node.kind === "parallel") node.branches.flat().forEach(visit);
				if (node.kind === "branch") {
					node.conditions.forEach(({ node: child }) => visit(child));
					if (node.otherwise) visit(node.otherwise);
				}
			};
			nodes.forEach(visit);
			const workflow = {
				__workflow: true as const,
				id: config.id,
				description: config.description,
				inputSchema: config.inputSchema,
				outputSchema: config.outputSchema,
				stateSchema: config.stateSchema,
				standaloneState: true,
				__nodes: [...nodes],
				__nodeIds: Object.fromEntries([...ids].map((id) => [id, true])),
				createRun: () =>
					createEngineRun(
						workflow as unknown as Workflow<TOutput, TInput, TState>,
					),
			} as unknown as Workflow<TOutput, TInput, TState>;
			return workflow;
		},
	};
	return builder;
};

/**
 * Reuse a workflow's steps under a new id.
 *
 * Cloning is how a caller runs the same sequence per tenant, per branch, or per
 * test case without redefining it — and the clone is a separate value, so results
 * and logs attribute each run to the id that actually ran.
 */
export const cloneWorkflow = <TOutput, TInput, TState>(
	workflow: Workflow<TOutput, TInput, TState>,
	overrides: { id: string; description?: string },
): Workflow<TOutput, TInput, TState> => {
	return createWorkflow<TOutput, TInput, TState>({
		id: overrides.id,
		description: overrides.description ?? workflow.description,
		inputSchema: workflow.inputSchema,
		outputSchema: workflow.outputSchema,
		stateSchema: workflow.stateSchema,
	})
		.then(internalsOf(workflow).__nodes)
		.commit();
};

export type WorkflowSummary = { id: string; description?: string };

/**
 * A named set of workflows, and the only way a caller resolves one by name.
 *
 * Names come from somewhere — a module, a directory, a config file — and a
 * resolver is what turns a string a user typed into a workflow that exists.
 * Failing loudly is the point: a typo that ran the wrong workflow would be worse
 * than one that did not run.
 */
export type WorkflowRegistry = {
	register(workflow: Workflow<any, any, any>): void;
	get(id: string): Workflow<any, any, any> | undefined;
	list(): WorkflowSummary[];
	has(id: string): boolean;
};

export const createWorkflowRegistry = (
	workflows: Record<string, Workflow<any, any, any>> = {},
): WorkflowRegistry => {
	const byId = new Map<string, Workflow<any, any, any>>();
	const add = (workflow: Workflow<any, any, any>) => {
		if (!workflow?.__workflow)
			throw new Error("workflow registry: only workflows can be registered");
		if (byId.has(workflow.id))
			throw new Error(
				`workflow registry: duplicate workflow id "${workflow.id}"`,
			);
		byId.set(workflow.id, workflow);
	};
	for (const workflow of Object.values(workflows)) add(workflow);
	return {
		register: add,
		get: (id) => byId.get(id),
		has: (id) => byId.has(id),
		list: () =>
			[...byId.values()].map(({ id, description }) => ({
				id,
				...(description ? { description } : {}),
			})),
	};
};

/** Roster text for a registry, for a `/workflow`-style listing. */
export const formatWorkflowList = (registry: WorkflowRegistry): string => {
	const workflows = registry.list();
	if (workflows.length === 0) return "No workflows are registered.";
	const width = Math.max(...workflows.map(({ id }) => id.length));
	return workflows
		.map(({ id, description }) =>
			`${id.padEnd(width)}  ${description ?? ""}`.trimEnd(),
		)
		.join("\n");
};

/** One step as it appears in a workflow's shape, before it has run. */
export type WorkflowStepInfo = {
	/** Nested steps are `workflow/step`, the same key a run records them under. */
	id: string;
	description: string;
};

const stepNodeChildren = (node: WorkflowNode): WorkflowNode[] => {
	if (node.kind === "sequence") return node.nodes;
	if (node.kind === "parallel") return node.branches.flat();
	if (node.kind === "branch")
		return [
			...node.conditions.map(({ node: child }) => child),
			...(node.otherwise ? [node.otherwise] : []),
		];
	return [];
};

/**
 * Every step a workflow contains, in the order the graph declares them.
 *
 * Read off the committed graph rather than off a run, because that is what
 * answers "what will this do" — including the steps a run has not reached yet,
 * and a workflow that has never been run at all. A `.map` contributes nothing:
 * its steps only exist once the mapper has been given an item.
 */
export const workflowSteps = (
	workflow: Workflow<any, any, any>,
): WorkflowStepInfo[] => {
	const found: WorkflowStepInfo[] = [];
	const visit = (node: WorkflowNode, prefix: string): void => {
		if (node.kind === "step") {
			// Nested ids are `workflow/step`, the same key a run records them under.
			found.push({
				id: `${prefix}/${node.step.id}`,
				description: node.step.description ?? "",
			});
			return;
		}
		if (node.kind === "workflow") {
			for (const nested of workflowSteps(node.workflow))
				found.push({
					id: `${prefix}/${nested.id}`,
					description: nested.description,
				});
			return;
		}
		for (const child of stepNodeChildren(node)) visit(child, prefix);
	};
	for (const node of internalsOf(workflow).__nodes ?? [])
		visit(node, workflow.id);
	return found;
};

/** One line per step of a finished run, for a caller rendering a result as text. */
export const workflowStepsSummary = (result: WorkflowRunResult): string => {
	const records = Object.values(result.steps);
	if (records.length === 0) return "(no steps ran)";
	return records
		.map((record) => {
			const suffix =
				record.status === "success"
					? `${record.durationMs}ms`
					: record.status === "failed"
						? `failed: ${record.error}`
						: "suspended";
			return `${record.id}: ${record.status} (${suffix})`;
		})
		.join("\n");
};
