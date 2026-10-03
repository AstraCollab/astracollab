import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { api } from "../api";
import {
	Badge,
	Button,
	Empty,
	ErrorNote,
	Field,
	Histogram,
	Panel,
	Stat,
	StatusDot,
	inputClass,
} from "../components/primitives";
import { ScoreCell } from "../components/trace";
import {
	duration,
	percent,
	relativeTime,
	scoreTone,
	tokens,
	toneClass,
	truncate,
	usd,
} from "../lib/format";
import { useStudio } from "../store";
import type {
	Dataset,
	Experiment,
	ExperimentSummaryRow,
	Scorer,
} from "../types";

/**
 * Evaluations.
 *
 * The table is the point: a score with a reason, a per-item answer, and a link to
 * the trace it came from. A number on its own cannot be argued with, so every
 * score here is a number and a sentence.
 */

export const EvaluationsView = () => {
	const [datasets, setDatasets] = useState<Dataset[]>([]);
	const [scorers, setScorers] = useState<Scorer[]>([]);
	const [experiments, setExperiments] = useState<ExperimentSummaryRow[]>([]);
	const [active, setActive] = useState<Experiment | null>(null);
	const [compareWith, setCompareWith] = useState<string | null>(null);
	const [datasetId, setDatasetId] = useState("");
	const [chosen, setChosen] = useState<string[]>([]);
	const [running, setRunning] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [creating, setCreating] = useState(false);
	const [newName, setNewName] = useState("");
	const [newItems, setNewItems] = useState("");

	const refresh = useCallback(async () => {
		try {
			const [nextDatasets, nextScorers, nextExperiments] = await Promise.all([
				api.datasets(),
				api.scorers(),
				api.experiments(),
			]);
			setDatasets(nextDatasets);
			setScorers(nextScorers);
			setExperiments(nextExperiments);
			setDatasetId((current) => current || nextDatasets[0]?.id || "");
			setChosen((current) =>
				current.length > 0 ? current : nextScorers.map((scorer) => scorer.id),
			);
			if (active) setActive(await api.experiment(active.id));
			setError(null);
		} catch (caught) {
			setError(caught instanceof Error ? caught.message : String(caught));
		}
	}, [active]);

	useEffect(() => {
		void refresh();
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	// Poll only while something is in flight. A finished experiment is immutable.
	useEffect(() => {
		if (!running) return;
		const timer = setInterval(() => void refresh(), 1500);
		return () => clearInterval(timer);
	}, [running, refresh]);

	const start = async () => {
		if (!datasetId) return;
		setRunning(true);
		setError(null);
		try {
			const { id } = await api.startExperiment({
				datasetId,
				scorerIds: chosen,
			});
			setActive(await api.experiment(id));
		} catch (caught) {
			setError(caught instanceof Error ? caught.message : String(caught));
			setRunning(false);
		}
	};

	const createDataset = async () => {
		const items = newItems
			.split("\n")
			.map((line) => line.trim())
			.filter(Boolean)
			.map((line) => ({ input: line }));
		if (!newName.trim() || items.length === 0) return;
		setCreating(true);
		try {
			await api.createDataset({ name: newName.trim(), items });
			setNewName("");
			setNewItems("");
			await refresh();
		} catch (caught) {
			setError(caught instanceof Error ? caught.message : String(caught));
		} finally {
			setCreating(false);
		}
	};

	const distribution = useMemo(() => {
		if (!active) return [];
		const bins = new Array(10).fill(0);
		for (const result of active.results) {
			const usable = result.scores.filter((score) => !score.skipped);
			if (usable.length === 0) continue;
			const mean =
				usable.reduce((sum, score) => sum + score.score, 0) / usable.length;
			bins[Math.min(9, Math.floor(mean * 10))] += 1;
		}
		return bins;
	}, [active]);

	// The comparison arm is fetched whole: its per-scorer means are the point of
	// comparing, and the history row only carries the pass rate.
	const [comparisonDetail, setComparisonDetail] = useState<Experiment | null>(
		null,
	);
	useEffect(() => {
		if (!compareWith) {
			setComparisonDetail(null);
			return;
		}
		let cancelled = false;
		void api.experiment(compareWith).then((detail) => {
			if (!cancelled) setComparisonDetail(detail);
		});
		return () => {
			cancelled = true;
		};
	}, [compareWith]);
	const comparison = comparisonDetail;

	return (
		<div className="flex flex-col gap-4">
			{error && <ErrorNote error={error} onRetry={() => void refresh()} />}

			<div className="grid gap-4 lg:grid-cols-[minmax(0,26rem)_1fr]">
				<div className="flex flex-col gap-4">
					<Panel title="run an experiment">
						<div className="flex flex-col gap-3">
							<Field label="dataset">
								<select
									value={datasetId}
									onChange={(event) => setDatasetId(event.target.value)}
									className={inputClass}
								>
									{datasets.length === 0 && (
										<option value="">no datasets yet</option>
									)}
									{datasets.map((dataset) => (
										<option key={dataset.id} value={dataset.id}>
											{dataset.name} · {dataset.items} items · v
											{dataset.version}
										</option>
									))}
								</select>
							</Field>

							<Field
								label="scorers"
								hint="Rule scorers are deterministic, so a score that moves means something changed."
							>
								<div className="flex flex-col gap-1.5">
									{scorers.length === 0 && (
										<p className="text-[11px] text-zinc-600">
											no scorers registered
										</p>
									)}
									{scorers.map((scorer) => (
										<label
											key={scorer.id}
											className="flex items-start gap-2 text-xs text-zinc-300"
										>
											<input
												type="checkbox"
												checked={chosen.includes(scorer.id)}
												onChange={(event) =>
													setChosen((current) =>
														event.target.checked
															? [...current, scorer.id]
															: current.filter((id) => id !== scorer.id),
													)
												}
												className="mt-0.5 accent-violet-300"
											/>
											<span className="min-w-0">
												<span className="block">{scorer.name}</span>
												{scorer.description && (
													<span className="block text-[10px] leading-4 text-zinc-600">
														{truncate(scorer.description, 90)}
													</span>
												)}
											</span>
											<Badge
												tone={scorer.kind === "judge" ? "accent" : "neutral"}
											>
												{scorer.kind}
											</Badge>
										</label>
									))}
								</div>
							</Field>

							<Button
								variant="primary"
								onClick={() => void start()}
								disabled={
									running ||
									!datasetId ||
									chosen.length === 0 ||
									datasets.length === 0
								}
							>
								{running ? "running…" : "run experiment"}
							</Button>
						</div>
					</Panel>

					<Panel title="datasets">
						{datasets.length === 0 ? (
							<Empty
								title="No datasets yet."
								hint="Add a few cases below, or POST them to /api/datasets."
							/>
						) : (
							<ul className="flex flex-col gap-2">
								{datasets.map((dataset) => (
									<li
										key={dataset.id}
										className="flex items-center gap-2 text-xs"
									>
										<span className="min-w-0 flex-1 truncate text-zinc-300">
											{dataset.name}
										</span>
										<span className="num font-mono text-[10px] text-zinc-600">
											{dataset.items} items · v{dataset.version}
										</span>
										<button
											type="button"
											onClick={async () => {
												await api.deleteDataset(dataset.id);
												await refresh();
											}}
											className="eyebrow transition hover:text-rose-300"
											title="Delete dataset"
										>
											✕
										</button>
									</li>
								))}
							</ul>
						)}
					</Panel>

					<Panel title="add cases">
						<div className="flex flex-col gap-3">
							<Field label="name">
								<input
									value={newName}
									onChange={(event) => setNewName(event.target.value)}
									className={inputClass}
									placeholder="auth regressions"
								/>
							</Field>
							<Field label="one case per line">
								<textarea
									value={newItems}
									onChange={(event) => setNewItems(event.target.value)}
									rows={4}
									className={inputClass}
									placeholder={
										"What is the staging build id?\nWhich port does the gateway listen on?"
									}
								/>
							</Field>
							<Button
								onClick={() => void createDataset()}
								disabled={creating || !newName.trim() || !newItems.trim()}
							>
								{creating ? "adding…" : "add dataset"}
							</Button>
						</div>
					</Panel>
				</div>

				<div className="flex flex-col gap-4">
					<Panel title="history" bodyClassName="p-0">
						{experiments.length === 0 ? (
							<Empty title="Nothing has been run yet." />
						) : (
							<ul className="divide-y divide-white/[0.04]">
								{experiments.map((experiment) => (
									<li key={experiment.id}>
										<button
											type="button"
											onClick={async () =>
												setActive(await api.experiment(experiment.id))
											}
											className={`grid w-full grid-cols-[1fr_9rem_7rem_5rem] items-center gap-3 px-4 py-2.5 text-left transition hover:bg-white/[0.03] ${
												active?.id === experiment.id
													? "bg-violet-300/[0.07]"
													: ""
											}`}
										>
											<span className="flex min-w-0 items-center gap-2">
												<StatusDot
													status={
														experiment.status === "completed"
															? "ok"
															: experiment.status === "running"
																? "unset"
																: "error"
													}
												/>
												<span className="truncate text-xs text-zinc-300">
													{experiment.model || "no model"}
												</span>
											</span>
											<span className="num font-mono text-[10px] text-zinc-600">
												{relativeTime(experiment.startedAt)}
											</span>
											<span
												className={`num text-right font-mono text-[11px] ${toneClass(scoreTone(experiment.summary.passRate))}`}
											>
												{experiment.summary.passRate === undefined
													? "—"
													: percent(experiment.summary.passRate)}
											</span>
											<span className="num text-right font-mono text-[10px] text-zinc-600">
												{experiment.id}
											</span>
										</button>
									</li>
								))}
							</ul>
						)}
					</Panel>

					{active && (
						<ExperimentDetail
							experiment={active}
							distribution={distribution}
							comparison={comparison}
							onCompare={setCompareWith}
							comparisons={experiments.filter(
								(experiment) => experiment.id !== active.id,
							)}
						/>
					)}
				</div>
			</div>
		</div>
	);
};

const ExperimentDetail = ({
	experiment,
	distribution,
	comparison,
	comparisons,
	onCompare,
}: {
	experiment: Experiment;
	distribution: number[];
	comparison: Experiment | null;
	comparisons: ExperimentSummaryRow[];
	onCompare: (id: string | null) => void;
}) => {
	const summary = experiment.summary;
	const scorerIds = Object.keys(summary.scorers ?? {});
	const running = experiment.status === "running";

	return (
		<>
			<div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
				<Stat
					label="pass rate"
					value={
						summary.passRate === undefined ? "—" : percent(summary.passRate)
					}
					tone={
						summary.passRate !== undefined && summary.passRate < 0.5
							? "danger"
							: "default"
					}
					detail={`${summary.passed ?? 0} passed · ${summary.failed ?? 0} failed`}
				/>
				<Stat
					label="errored"
					value={String(summary.errored ?? 0)}
					tone={(summary.errored ?? 0) > 0 ? "warn" : "default"}
					detail="provider failures, not agent failures"
				/>
				<Stat
					label="wall clock"
					value={duration(summary.durationMs ?? 0)}
					detail={`${summary.items ?? 0} items`}
				/>
				<Panel title="score spread" className="px-4 py-3.5">
					<Histogram bins={distribution.length > 0 ? distribution : [0]} />
					<p className="mt-2 text-[10px] leading-4 text-zinc-600">
						mean score per item, 0 → 1
					</p>
				</Panel>
			</div>

			<Panel
				title={`results · ${experiment.id}`}
				action={
					<div className="flex items-center gap-2">
						<select
							value={comparison?.id ?? ""}
							onChange={(event) => onCompare(event.target.value || null)}
							className={`${inputClass} w-auto`}
						>
							<option value="">compare with…</option>
							{comparisons.map((other) => (
								<option key={other.id} value={other.id}>
									{other.id} · {other.model || "no model"}
								</option>
							))}
						</select>
						<Badge
							tone={
								running
									? "warn"
									: experiment.status === "completed"
										? "good"
										: "danger"
							}
						>
							{experiment.status}
						</Badge>
					</div>
				}
				bodyClassName="p-0"
			>
				{scorerIds.length > 0 && (
					<div className="flex flex-wrap items-center gap-4 border-b border-white/[0.06] px-4 py-2.5">
						{scorerIds.map((id) => {
							const scorer = summary.scorers?.[id]!;
							return (
								<div key={id} className="flex items-baseline gap-2">
									<span className="eyebrow">{id}</span>
									<span
										className={`num font-mono text-xs ${toneClass(scoreTone(scorer.mean))}`}
									>
										{scorer.mean === null ? "—" : scorer.mean.toFixed(2)}
									</span>
									{scorer.skipped > 0 && (
										<span className="num font-mono text-[10px] text-zinc-600">
											{scorer.skipped} skipped
										</span>
									)}
								</div>
							);
						})}
					</div>
				)}

				{experiment.results.length === 0 ? (
					<Empty title={running ? "Running…" : "No results."} />
				) : (
					<div className="overflow-x-auto">
						<table className="w-full min-w-[52rem]">
							<thead className="border-b border-white/[0.06]">
								<tr>
									<th className="px-3 py-2 text-left eyebrow">status</th>
									<th className="px-3 py-2 text-left eyebrow">case</th>
									<th className="px-3 py-2 text-left eyebrow">answer</th>
									{scorerIds.map((id) => (
										<th key={id} className="px-3 py-2 text-right eyebrow">
											{id}
										</th>
									))}
									{comparison && (
										<th
											className="px-3 py-2 text-right eyebrow"
											title={`pass rate of ${comparison.id}`}
										>
											vs {comparison.id}
										</th>
									)}
									<th className="px-3 py-2 text-right eyebrow">trace</th>
								</tr>
							</thead>
							<tbody className="divide-y divide-white/[0.04]">
								{experiment.results.map((result) => {
									const usable = result.scores.filter(
										(score) => !score.skipped,
									);
									const mean =
										usable.length === 0
											? null
											: usable.reduce((sum, score) => sum + score.score, 0) /
												usable.length;
									return (
										<tr
											key={result.id}
											className="align-top transition hover:bg-white/[0.02]"
										>
											<td className="px-3 py-2.5">
												<span className="flex items-center gap-1.5 font-mono text-[11px] text-zinc-400">
													<StatusDot status={result.status} />
													{result.status}
												</span>
												{result.attempts > 1 && (
													<span
														className="num mt-0.5 block font-mono text-[10px] text-amber-300/80"
														title="provider retries"
													>
														{result.attempts} attempts
													</span>
												)}
											</td>
											<td className="max-w-[18rem] px-3 py-2.5 text-xs leading-5 text-zinc-300">
												{truncate(result.input, 110)}
											</td>
											<td className="max-w-[22rem] px-3 py-2.5">
												{result.error ? (
													<span className="text-[11px] text-rose-300">
														{result.error}
													</span>
												) : (
													<span className="text-[11px] leading-5 text-zinc-500">
														{truncate(result.output ?? "—", 150)}
													</span>
												)}
											</td>
											{scorerIds.map((id) => {
												const score = result.scores.find(
													(candidate) => candidate.scorerId === id,
												);
												return (
													<td key={id} className="px-3 py-2.5 text-right">
														{score ? (
															<ScoreCell
																score={score.score}
																reason={score.reason}
																skipped={score.skipped}
															/>
														) : (
															<span className="num font-mono text-xs text-zinc-700">
																—
															</span>
														)}
													</td>
												);
											})}
											{comparison && (
												<td
													className={`num px-3 py-2.5 text-right font-mono text-[11px] ${toneClass(scoreTone(mean))}`}
												>
													{comparison.summary.passRate === undefined
														? "—"
														: percent(comparison.summary.passRate)}
												</td>
											)}
											<td className="px-3 py-2.5 text-right">
												{result.traceId ? (
													<span className="num font-mono text-[10px] text-zinc-600">
														{result.traceId.slice(0, 8)}
													</span>
												) : (
													<span className="num font-mono text-[10px] text-zinc-700">
														—
													</span>
												)}
											</td>
										</tr>
									);
								})}
							</tbody>
						</table>
					</div>
				)}
			</Panel>

			{comparison && (
				<Panel
					title={`comparison · ${experiment.id} vs ${comparison.id}`}
					bodyClassName="p-0"
				>
					<table className="w-full">
						<thead className="border-b border-white/[0.06]">
							<tr>
								<th className="px-3 py-2 text-left eyebrow">metric</th>
								<th className="px-3 py-2 text-right eyebrow">
									{experiment.id}
								</th>
								<th className="px-3 py-2 text-right eyebrow">
									{comparison.id}
								</th>
								<th className="px-3 py-2 text-right eyebrow">delta</th>
							</tr>
						</thead>
						<tbody className="divide-y divide-white/[0.04]">
							{(
								[
									[
										"pass rate",
										experiment.summary.passRate,
										comparison.summary.passRate,
										(value: number) => percent(value),
									],
									[
										"items",
										experiment.summary.items,
										comparison.summary.items,
										(value: number) => String(value ?? 0),
									],
									[
										"errored",
										experiment.summary.errored,
										comparison.summary.errored,
										(value: number) => String(value ?? 0),
									],
									[
										"wall clock",
										experiment.summary.durationMs,
										comparison.summary.durationMs,
										(value: number) => duration(value ?? 0),
									],
									...scorerIds.flatMap((id) => [
										[
											`scorer · ${id}`,
											experiment.summary.scorers?.[id]?.mean,
											comparison.summary.scorers?.[id]?.mean,
											(value: number | null) =>
												value === null || value === undefined
													? "—"
													: value.toFixed(2),
										],
									]),
								] as Array<
									[
										string,
										number | undefined,
										number | undefined,
										(value: never) => string,
									]
								>
							).map(([label, left, right, render]) => {
								const delta =
									typeof left === "number" && typeof right === "number"
										? left - right
										: null;
								return (
									<tr key={label}>
										<td className="px-3 py-2 text-xs text-zinc-400">{label}</td>
										<td className="num px-3 py-2 text-right font-mono text-[11px] text-zinc-300">
											{render(left as never)}
										</td>
										<td className="num px-3 py-2 text-right font-mono text-[11px] text-zinc-300">
											{render(right as never)}
										</td>
										<td
											className={`num px-3 py-2 text-right font-mono text-[11px] ${
												delta === null || Math.abs(delta) < 1e-9
													? "text-zinc-600"
													: delta > 0
														? "text-emerald-300"
														: "text-rose-300"
											}`}
										>
											{delta === null || Math.abs(delta) < 1e-9
												? "—"
												: `${delta > 0 ? "+" : ""}${render(delta as unknown as never)}`}
										</td>
									</tr>
								);
							})}
						</tbody>
					</table>
				</Panel>
			)}
		</>
	);
};

/** Per-tool aggregates. The question is "which tool is slow or failing", not "which run". */
export const ToolsView = () => {
	const [tools, setTools] = useState<Array<{
		tool: string;
		calls: number;
		errors: number;
		errorRate: number;
		p50Ms: number;
		p95Ms: number;
		totalMs: number;
	}> | null>(null);
	const [error, setError] = useState<string | null>(null);

	const { selectedAgentId, traceVersion } = useStudio();

	const load = useCallback(async () => {
		try {
			setTools(await api.tools(selectedAgentId));
			setError(null);
		} catch (caught) {
			setError(caught instanceof Error ? caught.message : String(caught));
		}
	}, [selectedAgentId]);

	useEffect(() => {
		void load();
	}, [load, traceVersion]);

	const totalCalls = tools?.reduce((sum, tool) => sum + tool.calls, 0) ?? 0;
	const totalErrors = tools?.reduce((sum, tool) => sum + tool.errors, 0) ?? 0;

	return (
		<div className="flex flex-col gap-4">
			{error && <ErrorNote error={error} onRetry={() => void load()} />}
			<div className="grid gap-3 sm:grid-cols-3">
				<Stat label="tool calls" value={String(totalCalls)} />
				<Stat
					label="failed calls"
					value={String(totalErrors)}
					tone={totalErrors > 0 ? "warn" : "default"}
				/>
				<Stat
					label="error rate"
					value={percent(totalCalls ? totalErrors / totalCalls : 0, 1)}
					tone={
						totalCalls > 0 && totalErrors / totalCalls > 0.05
							? "danger"
							: "default"
					}
				/>
			</div>

			<Panel
				title="per tool"
				bodyClassName="p-0"
				action={<Button onClick={() => void load()}>refresh</Button>}
			>
				{!tools || tools.length === 0 ? (
					<Empty
						title="No tool calls recorded yet."
						hint="Every tool span in a trace is counted here, with its latency and outcome."
					/>
				) : (
					<table className="w-full">
						<thead className="border-b border-white/[0.06]">
							<tr>
								<th className="px-4 py-2 text-left eyebrow">tool</th>
								<th className="px-4 py-2 text-right eyebrow">calls</th>
								<th className="px-4 py-2 text-right eyebrow">errors</th>
								<th className="px-4 py-2 text-right eyebrow">p50</th>
								<th className="px-4 py-2 text-right eyebrow">p95</th>
								<th className="px-4 py-2 text-right eyebrow">total</th>
							</tr>
						</thead>
						<tbody className="divide-y divide-white/[0.04]">
							{tools.map((tool) => (
								<tr
									key={tool.tool}
									className="transition hover:bg-white/[0.02]"
								>
									<td className="px-4 py-2 font-mono text-xs text-zinc-200">
										{tool.tool}
									</td>
									<td className="num px-4 py-2 text-right font-mono text-[11px] text-zinc-400">
										{tool.calls}
									</td>
									<td
										className={`num px-4 py-2 text-right font-mono text-[11px] ${tool.errors > 0 ? "text-rose-300" : "text-zinc-600"}`}
									>
										{tool.errors} · {percent(tool.errorRate, 1)}
									</td>
									<td className="num px-4 py-2 text-right font-mono text-[11px] text-zinc-400">
										{duration(tool.p50Ms)}
									</td>
									<td className="num px-4 py-2 text-right font-mono text-[11px] text-zinc-400">
										{duration(tool.p95Ms)}
									</td>
									<td className="num px-4 py-2 text-right font-mono text-[11px] text-zinc-500">
										{duration(tool.totalMs)}
									</td>
								</tr>
							))}
						</tbody>
					</table>
				)}
			</Panel>
		</div>
	);
};

/**
 * Chat, wired to the same recorder as everything else.
 *
 * The thread is read back from the server on mount rather than held in component
 * state alone. Every message is already written to the store when it is sent, so
 * keeping a second copy in React and never reconciling it means the thread
 * disappears when you switch views — which reads as "chats are not persisted"
 * even though they are.
 */
export const ChatView = ({
	onOpenTrace,
}: { onOpenTrace: (traceId: string) => void }) => {
	const [message, setMessage] = useState("");
	const [turns, setTurns] = useState<
		Array<{
			role: "user" | "agent";
			content: string;
			tools: string[];
			traceId?: string;
			/** Set when the run stopped short of an answer. */
			stopNotice?: string;
		}>
	>([]);
	const [sending, setSending] = useState(false);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const bottom = useRef<HTMLDivElement | null>(null);

	// Hydrate from the store, oldest first: the API returns newest first because
	// that is what a log view wants, and a conversation read backwards is a
	// conversation nobody can follow. Ordered by `seq` rather than `createdAt`,
	// which cannot separate two writes inside the same millisecond.
	useEffect(() => {
		let cancelled = false;
		void api
			.messages(200)
			.then((messages) => {
				if (cancelled) return;
				setTurns(
					[...messages]
						.sort((a, b) => a.seq - b.seq)
						.map((entry) => ({
							role:
								entry.role === "user" ? ("user" as const) : ("agent" as const),
							content: entry.content,
							tools: [],
							...(entry.traceId === undefined
								? {}
								: { traceId: entry.traceId }),
						})),
				);
			})
			.catch((caught: unknown) => {
				if (!cancelled)
					setError(caught instanceof Error ? caught.message : String(caught));
			})
			.finally(() => {
				if (!cancelled) setLoading(false);
			});
		return () => {
			cancelled = true;
		};
	}, []);

	useEffect(() => {
		bottom.current?.scrollIntoView({ block: "end" });
	}, [turns, sending]);

	const send = async () => {
		const text = message.trim();
		if (!text || sending) return;
		setMessage("");
		setTurns((current) => [
			...current,
			{ role: "user", content: text, tools: [] },
		]);
		setSending(true);
		setError(null);
		try {
			const result = await api.chat(text);
			setTurns((current) => [
				...current,
				{
					role: "agent",
					content: result.output,
					tools: result.toolsCalled,
					...(result.traceId === undefined ? {} : { traceId: result.traceId }),
					...(result.stopNotice === undefined ? {} : { stopNotice: result.stopNotice }),
				},
			]);
		} catch (caught) {
			setError(caught instanceof Error ? caught.message : String(caught));
		} finally {
			setSending(false);
		}
	};

	return (
		<div className="flex h-[calc(100vh-9rem)] flex-col gap-4">
			{error && <ErrorNote error={error} />}
			<Panel
				title={`thread · ${turns.length} message${turns.length === 1 ? "" : "s"}`}
				className="min-h-0 flex-1"
				bodyClassName="flex flex-col justify-end gap-3 overflow-y-auto p-4"
			>
				{turns.length === 0 && !loading && (
					<Empty
						title="Ask the agent something."
						hint="The run is traced exactly like a terminal one, so a turn from here opens in the traces tab."
					/>
				)}
				{loading && (
					<p className="text-[11px] text-zinc-600">loading thread…</p>
				)}
				{turns.map((turn, index) => (
					<div
						key={index}
						className={`flex flex-col ${turn.role === "user" ? "items-end" : "items-start"}`}
					>
						<div
							className={`max-w-[80%] rounded-xl px-3.5 py-2.5 text-xs leading-6 whitespace-pre-wrap ${
								turn.role === "user"
									? "bg-violet-300/[0.12] text-violet-100"
									: "border border-white/[0.06] bg-white/[0.03] text-zinc-200"
							}`}
						>
							{turn.content}
						{turn.stopNotice && (
							<p className="mt-2 border-t border-amber-300/20 pt-2 text-[11px] text-amber-200/90">
								{turn.stopNotice}
							</p>
						)}
							{(turn.tools.length > 0 || turn.traceId) && (
								<div className="mt-2 flex flex-wrap items-center gap-1 border-t border-white/[0.06] pt-2">
									{turn.tools.map((tool) => (
										<Badge key={tool} tone="neutral">
											{tool}
										</Badge>
									))}
									{turn.traceId && (
										<button
											type="button"
											onClick={() => onOpenTrace(turn.traceId!)}
											className="eyebrow text-violet-200/80 transition hover:text-violet-200"
											title="Open this run in traces"
										>
											trace {turn.traceId.slice(0, 8)} →
										</button>
									)}
								</div>
							)}
						</div>
					</div>
				))}
				{sending && <p className="text-[11px] text-zinc-600">running…</p>}
				<div ref={bottom} />
			</Panel>

			<Panel bodyClassName="p-3">
				<div className="flex gap-2">
					<textarea
						value={message}
						onChange={(event) => setMessage(event.target.value)}
						onKeyDown={(event) => {
							if (event.key === "Enter" && !event.shiftKey) {
								event.preventDefault();
								void send();
							}
						}}
						rows={2}
						placeholder="Ask something. Enter to send, Shift+Enter for a newline."
						className={inputClass}
					/>
					<Button
						variant="primary"
						onClick={() => void send()}
						disabled={sending || !message.trim()}
					>
						send
					</Button>
				</div>
				<p className="mt-2 text-[10px] text-zinc-600">
					Messages are written to the store as they are sent, so the thread
					survives switching views and restarts. The agent runs read-only here:
					mutating tools are refused.
				</p>
			</Panel>
		</div>
	);
};

export { usd, tokens };
