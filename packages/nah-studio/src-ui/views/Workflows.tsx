import { useCallback, useEffect, useState } from "react";

import { api } from "../api";
import {
	Badge,
	Button,
	Empty,
	ErrorNote,
	Field,
	Panel,
	inputClass,
	type BadgeTone,
} from "../components/primitives";
import { duration, prettyJson, relativeTime, truncate } from "../lib/format";
import type {
	WorkflowRunDetail,
	WorkflowRunStatus,
	WorkflowRunSummary,
	WorkflowStepRecord,
	WorkflowStepStatus,
	WorkflowSummary,
} from "../types";

/**
 * Workflows: the roster, the runs, and one run's steps.
 *
 * A list, on purpose. The wire types describe a graph and a canvas would be the
 * obvious thing to draw — and the obvious thing to draw answers a question worse:
 * which step is running, which finished, which failed, and how long each took. A
 * picture of that is harder to read than a column of it, harder to test, and a
 * dependency to keep current. The step graph stays a data structure; the Studio
 * prints it.
 *
 * Two rules the type forces rather than the screen inventing:
 *
 *  - A workflow cannot be run without a model, so `canRun` disables the button and
 *    says why, rather than offering one that comes back with an error.
 *  - A suspended run is only resumable while this process still holds it. The
 *    orchestrator keeps suspended runs in memory, so a run that reports the status
 *    without the payload was suspended by a process that has since gone away, and a
 *    Resume button there would fail every time it was pressed. The screen says so
 *    instead.
 */

const POLL_MS = 1500;

const runTone = (status: WorkflowRunStatus): BadgeTone =>
	status === "success"
		? "good"
		: status === "failed"
			? "danger"
			: status === "suspended"
				? "warn"
				: status === "running"
					? "accent"
					: "neutral";

const stepTone = (status: WorkflowStepStatus): BadgeTone =>
	status === "success"
		? "good"
		: status === "failed"
			? "danger"
			: status === "suspended"
				? "warn"
				: status === "running"
					? "accent"
					: "neutral";

const runDuration = (run: {
	startedAt: number;
	finishedAt: number | null;
}): number | null =>
	run.finishedAt === null ? null : run.finishedAt - run.startedAt;

/**
 * The box's contents as the run should receive them.
 *
 * JSON when it parses, the raw string when it does not: someone answering a
 * suspended step is asked a question, and a question is the likeliest thing to be
 * typed here. Rejecting it for failing to be valid JSON would be pedantry that
 * costs the common case.
 */
const asPayload = (text: string): unknown => {
	const trimmed = text.trim();
	if (trimmed === "") return undefined;
	try {
		return JSON.parse(trimmed) as unknown;
	} catch {
		return trimmed;
	}
};

const message = (caught: unknown): string =>
	caught instanceof Error ? caught.message : String(caught);

export const WorkflowsView = () => {
	const [workflows, setWorkflows] = useState<WorkflowSummary[]>([]);
	const [canRun, setCanRun] = useState(false);
	const [model, setModel] = useState<string | null>(null);
	const [runs, setRuns] = useState<WorkflowRunSummary[]>([]);
	const [openRunId, setOpenRunId] = useState<string | null>(null);
	const [openRun, setOpenRun] = useState<WorkflowRunDetail | null>(null);
	const [runInput, setRunInput] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [loading, setLoading] = useState(true);
	// Id of whatever a button is currently posting, so one row's stop does not grey
	// out every other row's.
	const [busy, setBusy] = useState<string | null>(null);

	const load = useCallback(async () => {
		try {
			const [roster, listed] = await Promise.all([
				api.workflows(),
				api.workflowRuns(),
			]);
			// Both routes answer 200 with `{ error }` when no runner is attached, and
			// both can fail that way at once. Every message is collected rather than
			// letting the first one win, so one refresh fixes everything that is wrong.
			const problems: string[] = [];
			if ("error" in roster) problems.push(roster.error);
			else {
				setWorkflows(roster.workflows);
				setCanRun(roster.canRun);
				setModel(roster.model);
			}
			if ("error" in listed) problems.push(listed.error);
			else setRuns(listed.runs);
			setError(problems.length > 0 ? problems.join(" · ") : null);
		} catch (caught) {
			setError(message(caught));
		} finally {
			setLoading(false);
		}
	}, []);

	const loadRun = useCallback(async (id: string) => {
		const detail = await api.workflowRun(id);
		if ("error" in detail) {
			setError(detail.error);
			return;
		}
		if (!detail.run) {
			setError("no such run");
			return;
		}
		setOpenRun(detail.run);
	}, []);

	useEffect(() => {
		void load();
	}, [load]);

	// The open run refreshes itself while it is unfinished. Polling the list too
	// would mean three requests a second for rows nobody is looking at; a run that
	// stops is picked up on the next tick, and a finished run stops asking.
	useEffect(() => {
		if (!openRunId) return;
		if (openRun?.status !== "running" && openRun?.status !== "suspended") return;
		const timer = setInterval(() => {
			void loadRun(openRunId).catch((caught: unknown) =>
				setError(message(caught)),
			);
		}, POLL_MS);
		return () => clearInterval(timer);
	}, [openRunId, openRun?.status, loadRun]);

	const open = (runId: string) => {
		setOpenRunId(runId);
		void loadRun(runId).catch((caught: unknown) => setError(message(caught)));
	};

	const launch = async (workflow: WorkflowSummary) => {
		setBusy(workflow.id);
		try {
			const started = await api.launchWorkflow(workflow.id, asPayload(runInput));
			if ("error" in started) {
				setError(started.error);
				return;
			}
			setError(null);
			setRunInput("");
			await loadRun(started.runId);
			setOpenRunId(started.runId);
			await load();
		} catch (caught) {
			setError(message(caught));
		} finally {
			setBusy(null);
		}
	};

	const stop = async (runId: string) => {
		setBusy(runId);
		try {
			const outcome = await api.stopWorkflowRun(runId);
			if ("error" in outcome) {
				setError(outcome.error);
				return;
			}
			if (!outcome.ok) {
				setError(outcome.reason ?? "the server refused to stop this run");
				return;
			}
			setError(null);
			await loadRun(runId);
			await load();
		} catch (caught) {
			setError(message(caught));
		} finally {
			setBusy(null);
		}
	};

	const resume = async (runId: string) => {
		// window.prompt rather than a field in the panel: the answer is one value,
		// it is wanted once, and a permanently visible input on the run suggests it
		// is waiting on an empty box rather than on an answer.
		const answer = window.prompt(
			"This run is suspended. What should it be resumed with?",
		);
		if (answer === null) return;
		setBusy(runId);
		try {
			const outcome = await api.resumeWorkflowRun(runId, asPayload(answer));
			if ("error" in outcome) {
				setError(outcome.error);
				return;
			}
			if (!outcome.ok) {
				setError(outcome.reason ?? "the server refused to resume this run");
				return;
			}
			setError(null);
			await loadRun(runId);
			await load();
		} catch (caught) {
			setError(message(caught));
		} finally {
			setBusy(null);
		}
	};

	// A suspended run is resumable only while this process still holds it. The
	// field is optional on the type because a run read back from a store that never
	// had it says the status and nothing to go on with.
	const resumable = Boolean(
		openRun &&
			openRun.status === "suspended" &&
			openRun.suspended &&
			openRun.suspended.length > 0,
	);

	return (
		<div className="flex flex-col gap-4">
			{error && <ErrorNote error={error} onRetry={() => void load()} />}

			<div className="grid gap-4 lg:grid-cols-[minmax(0,26rem)_1fr]">
				<Panel
					title="workflows"
					action={
						<Button variant="ghost" onClick={() => void load()}>
							refresh
						</Button>
					}
				>
					{!canRun && (
						<p className="mb-3 rounded-lg border border-amber-300/25 bg-amber-300/[0.06] p-3 text-[11px] leading-5 text-amber-200/90">
							No model is configured, so nothing can be run.{" "}
							{model
								? `This machine reports ${model}, and it is not usable.`
								: "Set NAH_MODEL and restart the Studio."}
						</p>
					)}

					<Field
						label="run input"
						hint="Optional. JSON, or plain text — it is passed to the run as given."
						className="mb-3"
					>
						<textarea
							value={runInput}
							onChange={(event) => setRunInput(event.target.value)}
							rows={2}
							spellCheck={false}
							placeholder='{"question": "what changed?"}'
							className={`${inputClass} resize-y font-mono`}
						/>
					</Field>

					{workflows.length === 0 ? (
						<Empty
							title="No workflows found."
							hint={
								loading
									? "Looking…"
									: "Put a workflow in .nah/workflows, or start the Studio on a directory that has one."
							}
						/>
					) : (
						<div className="flex flex-col gap-2">
							{workflows.map((workflow) => (
								<WorkflowCard
									key={workflow.id}
									workflow={workflow}
									canRun={canRun}
									busy={busy === workflow.id}
									onRun={() => void launch(workflow)}
								/>
							))}
						</div>
					)}
				</Panel>

				<Panel title={`runs · ${runs.length}`} bodyClassName="p-0">
					{runs.length === 0 ? (
						<Empty
							title="No workflow runs yet."
							hint="A run appears here the moment one is started, and stays after it finishes."
						/>
					) : (
						<div className="divide-y divide-white/[0.04]">
							{runs.map((run) => (
								<RunRow
									key={run.runId}
									run={run}
									open={run.runId === openRunId}
									busy={busy === run.runId}
									onOpen={() => open(run.runId)}
									onStop={() => void stop(run.runId)}
								/>
							))}
						</div>
					)}
				</Panel>
			</div>

			{openRun && (
				<RunPanel
					run={openRun}
					resumable={resumable}
					busy={busy === openRun.runId}
					onResume={() => void resume(openRun.runId)}
					onStop={() => void stop(openRun.runId)}
					onRefresh={() => void loadRun(openRun.runId)}
				/>
			)}
		</div>
	);
};

/**
 * One workflow: its steps, and the button that runs it.
 *
 * The steps are printed from the workflow rather than from a run, because that is
 * the shape before anything has happened — which steps exist, and in what order
 * they are meant to run.
 */
const WorkflowCard = ({
	workflow,
	canRun,
	busy,
	onRun,
}: {
	workflow: WorkflowSummary;
	canRun: boolean;
	busy: boolean;
	onRun: () => void;
}) => (
	<div className="rounded-xl border border-white/[0.08] bg-black/30 p-3">
		<div className="flex items-start justify-between gap-2">
			<div className="min-w-0">
				<p className="truncate font-mono text-xs text-zinc-100" title={workflow.id}>
					{workflow.id}
				</p>
				{workflow.description && (
					<p className="mt-1 text-[11px] leading-4 text-zinc-500">
						{truncate(workflow.description, 140)}
					</p>
				)}
			</div>
			<Button
				variant="primary"
				onClick={onRun}
				disabled={!canRun || busy || Boolean(workflow.error)}
				title={
					workflow.error
						? "This workflow failed to load"
						: canRun
							? "Start a run"
							: "No model is configured"
				}
			>
				{busy ? "starting…" : "run"}
			</Button>
		</div>

		{workflow.error && (
			<p className="mt-2 text-[11px] leading-4 text-rose-300">{workflow.error}</p>
		)}

		<ol className="mt-2.5 flex flex-col gap-1">
			{workflow.steps.map((step, index) => (
				<li key={step.id} className="flex items-baseline gap-2 text-[11px]">
					<span className="num w-4 shrink-0 text-right text-zinc-700">
						{index + 1}
					</span>
					<span className="font-mono text-zinc-400" title={step.id}>
						{step.id}
					</span>
					{step.description && (
						<span className="min-w-0 flex-1 truncate text-zinc-600">
							{truncate(step.description, 70)}
						</span>
					)}
				</li>
			))}
		</ol>
	</div>
);

/** One run in the list. A row, because a run is a fact rather than a shape. */
const RunRow = ({
	run,
	open,
	busy,
	onOpen,
	onStop,
}: {
	run: WorkflowRunSummary;
	open: boolean;
	busy: boolean;
	onOpen: () => void;
	onStop: () => void;
}) => (
	<div
		className={`flex flex-wrap items-center gap-x-3 gap-y-1.5 px-4 py-2.5 transition hover:bg-white/[0.03] ${
			open ? "bg-white/[0.04]" : ""
		}`}
	>
		<button type="button" onClick={onOpen} className="min-w-0 flex-1 text-left">
			<span className="flex flex-wrap items-center gap-2">
				<Badge tone={runTone(run.status)}>{run.status}</Badge>
				<span className="truncate font-mono text-[11px] text-zinc-200">
					{run.workflowId}
				</span>
			</span>
			<span className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[10px] text-zinc-600">
				<span>
					{run.started}/{run.steps} steps
				</span>
				<span>{relativeTime(run.startedAt)}</span>
				<span className="num">{duration(runDuration(run))}</span>
				{run.model && <span className="truncate font-mono">{run.model}</span>}
			</span>
		</button>
		{run.status === "running" && (
			<Button variant="danger" onClick={onStop} disabled={busy}>
				stop
			</Button>
		)}
	</div>
);

/**
 * The open run: its steps as a list, and whatever it is waiting on.
 *
 * A finished run shows its output too — the step records are the diagnosis, but
 * "what did it actually produce" is the other half of the question, and the half a
 * step list cannot answer.
 */
const RunPanel = ({
	run,
	resumable,
	busy,
	onResume,
	onStop,
	onRefresh,
}: {
	run: WorkflowRunDetail;
	resumable: boolean;
	busy: boolean;
	onResume: () => void;
	onStop: () => void;
	onRefresh: () => void;
}) => (
	<div className="flex flex-col gap-4">
		<Panel
			title={
				<span className="flex flex-wrap items-center gap-2">
					run {run.workflowId} · {run.runId}
					<Badge tone={runTone(run.status)}>{run.status}</Badge>
				</span>
			}
			action={
				<div className="flex items-center gap-1.5">
					<Button variant="ghost" onClick={onRefresh}>
						refresh
					</Button>
					{run.status === "running" && (
						<Button variant="danger" onClick={onStop} disabled={busy}>
							stop
						</Button>
					)}
					{resumable && (
						<Button variant="primary" onClick={onResume} disabled={busy}>
							resume
						</Button>
					)}
				</div>
			}
		>
			<div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-zinc-500">
				<span>started {relativeTime(run.startedAt)}</span>
				<span className="num">took {duration(runDuration(run))}</span>
				{run.model && <span className="font-mono">{run.model}</span>}
				{run.finishedAt === null && <Badge tone="accent">in flight</Badge>}
			</div>

			{run.status === "suspended" && (
				<div className="mt-3 rounded-lg border border-amber-300/25 bg-amber-300/[0.06] p-3">
					<p className="text-[11px] leading-5 text-amber-200/90">
						{resumable ? (
							<>
								Suspended on <span className="font-mono">{run.suspended?.join(", ")}</span>
								. Resuming hands the run your answer; nothing else will move it on.
							</>
						) : (
							<>
								Suspended, and this process cannot resume it. The orchestrator holds a
								suspended run in memory, so a run reported as suspended without the steps
								holding it up belongs to a process that is gone. Start it again.
							</>
						)}
					</p>
					{run.suspendPayload !== undefined && (
						<pre className="mt-2 max-h-40 overflow-auto rounded-lg border border-white/[0.06] bg-black/40 p-2.5 font-mono text-[10px] leading-4 text-zinc-400">
							{prettyJson(run.suspendPayload)}
						</pre>
					)}
				</div>
			)}

			{run.error && (
				<p className="mt-3 rounded-lg border border-rose-400/25 bg-rose-400/[0.06] p-3 text-[11px] leading-5 text-rose-200/90">
					{run.error}
				</p>
			)}
		</Panel>

		<Panel title={`steps · ${run.records.length}`} bodyClassName="p-0">
			{run.records.length === 0 ? (
				<Empty
					title="No steps recorded yet."
					hint="Steps appear as the run reports them, which is before the run finishes."
				/>
			) : (
				<div className="divide-y divide-white/[0.04]">
					{run.records.map((record) => (
						<StepRow key={record.stepId} record={record} />
					))}
				</div>
			)}
		</Panel>

		{run.output !== undefined && (
			<Panel title="output" bodyClassName="p-3">
				<pre className="max-h-80 overflow-auto rounded-lg border border-white/[0.06] bg-black/40 p-3 font-mono text-[11px] leading-5 text-zinc-300">
					{prettyJson(run.output)}
				</pre>
			</Panel>
		)}
	</div>
);

/** One step: status, how long, and whatever it said. */
const StepRow = ({ record }: { record: WorkflowStepRecord }) => (
	<div className="px-4 py-2.5">
		<div className="flex flex-wrap items-center gap-2">
			<Badge tone={stepTone(record.status)}>{record.status}</Badge>
			<span className="truncate font-mono text-[11px] text-zinc-200">
				{record.stepId}
			</span>
			<span className="num ml-auto text-[10px] text-zinc-500">
				{duration(record.durationMs)}
			</span>
		</div>
		{record.error && (
			<p className="mt-1.5 text-[11px] leading-5 text-rose-300">{record.error}</p>
		)}
		{record.text && (
			<pre className="mt-1.5 max-h-32 overflow-auto whitespace-pre-wrap rounded-lg border border-white/[0.06] bg-black/30 p-2 font-mono text-[10px] leading-4 text-zinc-500">
				{truncate(record.text, 1200)}
			</pre>
		)}
	</div>
);
