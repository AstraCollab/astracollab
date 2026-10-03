import { useCallback, useEffect, useMemo, useState } from "react";

import { type TraceFilters, api } from "../api";
import {
	Badge,
	Button,
	Empty,
	ErrorNote,
	Panel,
	Stat,
	StatusDot,
	inputClass,
} from "../components/primitives";
import {
	SearchInput,
	SortHeader,
	SpanInspector,
	TraceSummary,
	Waterfall,
} from "../components/trace";
import {
	duration,
	percent,
	relativeTime,
	timestamp,
	tokens,
	truncate,
	usd,
} from "../lib/format";
import { useStudio } from "../store";
import type { Span, Trace } from "../types";

/**
 * Traces: the list people live in, and the detail they open to answer a question.
 *
 * Filters live in the URL-less query state of the component rather than in the
 * store, so the back button and a refresh behave the way they do everywhere else.
 */

const RANGES = [
	{ label: "15m", ms: 15 * 60_000 },
	{ label: "1h", ms: 60 * 60_000 },
	{ label: "6h", ms: 6 * 60 * 60_000 },
	{ label: "24h", ms: 24 * 60 * 60_000 },
	{ label: "7d", ms: 7 * 24 * 60 * 60_000 },
	{ label: "all", ms: undefined },
] as const;

export const TracesView = ({
	focusTrace,
	onFocusHandled,
}: {
	/** A trace to open on arrival, set from another view. */
	focusTrace?: string | null;
	onFocusHandled?: () => void;
}) => {
	// Scoped by the header, and refreshed when a trace lands anywhere on the
	// machine — this list is the main way anyone watches an agent work.
	const { selectedAgentId, traceVersion } = useStudio();
	const [filters, setFilters] = useState<TraceFilters>({
		sort: "startTime",
		order: "desc",
		limit: 200,
	});
	const [traces, setTraces] = useState<Trace[]>([]);
	const [error, setError] = useState<string | null>(null);
	const [loading, setLoading] = useState(true);
	const [selected, setSelected] = useState<{
		trace: Trace;
		spans: Span[];
	} | null>(null);
	const [selectedSpan, setSelectedSpan] = useState<Span | null>(null);

	const load = useCallback(async () => {
		setLoading(true);
		try {
			setTraces(await api.traces({ ...filters, agentId: selectedAgentId }));
			setError(null);
		} catch (caught) {
			setError(caught instanceof Error ? caught.message : String(caught));
		} finally {
			setLoading(false);
		}
	}, [filters, selectedAgentId]);

	// Loads on mount, on every filter or scope change, and when a trace lands
	// anywhere on the machine. The loading flag is only shown on the first pass:
	// this list is watched, and a flash of "loading" every time an agent finishes a
	// turn makes a live dashboard feel less trustworthy than a ten-second poll.
	useEffect(() => {
		void load();
	}, [load, traceVersion]);

	const open = useCallback(async (id: string) => {
		try {
			const detail = await api.trace(id);
			if (detail) {
				setSelected(detail);
				// Open on the root: an inspector with nothing selected is just a blank box.
				setSelectedSpan(
					detail.spans.find((span) => span.id === detail.trace.rootSpanId) ??
						null,
				);
			}
		} catch (caught) {
			setError(caught instanceof Error ? caught.message : String(caught));
		}
	}, []);

	// Opened from a chat turn or an evaluation row. Handled once, so returning to
	// traces later does not re-open whatever was last looked at.
	useEffect(() => {
		if (!focusTrace) return;
		void open(focusTrace);
		onFocusHandled?.();
	}, [focusTrace, open, onFocusHandled]);

	const totals = useMemo(
		() => ({
			cost: traces.reduce((sum, trace) => sum + (trace.costUsd ?? 0), 0),
			errors: traces.filter((trace) => trace.status === "error").length,
			interrupted: traces.filter((trace) => trace.status === "interrupted")
				.length,
			duration:
				traces.length === 0
					? 0
					: traces.reduce(
							(sum, trace) =>
								sum + ((trace.endTime ?? trace.startTime) - trace.startTime),
							0,
						) / traces.length,
		}),
		[traces],
	);

	const setRange = (ms: number | undefined) =>
		setFilters((current) => ({
			...current,
			since: ms === undefined ? undefined : Date.now() - ms,
		}));

	const toggleSort = (field: NonNullable<TraceFilters["sort"]>) =>
		setFilters((current) => ({
			...current,
			sort: field,
			order:
				current.sort === field && current.order === "desc" ? "asc" : "desc",
		}));

	return (
		<div className="flex flex-col gap-4">
			<div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
				<Stat
					label="traces in view"
					value={String(traces.length)}
					detail={loading ? "loading…" : "matching filters"}
				/>
				<Stat
					label="errors"
					value={String(totals.errors)}
					tone={totals.errors > 0 ? "danger" : "default"}
					detail={percent(traces.length ? totals.errors / traces.length : 0, 1)}
				/>
				<Stat
					label="interrupted"
					value={String(totals.interrupted)}
					tone={totals.interrupted > 0 ? "warn" : "default"}
					detail="stopped without reporting"
				/>
				<Stat
					label="spend"
					value={usd(totals.cost)}
					detail="sum of traces in view"
				/>
				<Stat
					label="mean duration"
					value={duration(totals.duration)}
					detail="per trace"
				/>
			</div>

			<Panel
				title="filters"
				action={
					<Button onClick={() => void load()} variant="ghost">
						refresh
					</Button>
				}
			>
				<div className="flex flex-wrap items-end gap-3">
					<div className="min-w-[16rem] flex-1">
						<SearchInput
							value={filters.search ?? ""}
							onChange={(search) =>
								setFilters((current) => ({ ...current, search }))
							}
							placeholder="Search name or trace id…"
						/>
					</div>
					<div className="flex gap-1">
						{RANGES.map((range) => {
							const active =
								range.ms === undefined
									? filters.since === undefined
									: filters.since !== undefined &&
										Date.now() - filters.since <= range.ms * 1.2;
							return (
								<button
									key={range.label}
									type="button"
									onClick={() => setRange(range.ms)}
									className={`rounded-lg px-2.5 py-1.5 font-mono text-[10px] uppercase tracking-[0.1em] transition ${
										active
											? "bg-violet-200 text-zinc-950"
											: "border border-white/[0.08] text-zinc-400 hover:text-white"
									}`}
								>
									{range.label}
								</button>
							);
						})}
					</div>
					<select
						value={filters.status ?? "all"}
						onChange={(event) =>
							setFilters((current) => ({
								...current,
								status: event.target.value,
							}))
						}
						className={inputClass}
						aria-label="Status"
					>
						<option value="all">all statuses</option>
						<option value="ok">ok</option>
						<option value="error">error</option>
						<option value="interrupted">interrupted</option>
					</select>
					<select
						value={filters.tag ?? "all"}
						onChange={(event) =>
							setFilters((current) => ({ ...current, tag: event.target.value }))
						}
						className={inputClass}
						aria-label="Tag"
					>
						<option value="all">all tags</option>
						{[...new Set(traces.flatMap((trace) => trace.tags))].map((tag) => (
							<option key={tag} value={tag}>
								{tag}
							</option>
						))}
					</select>
				</div>
			</Panel>

			{error && <ErrorNote error={error} onRetry={() => void load()} />}

			<Panel title={`traces · ${traces.length}`} bodyClassName="p-0">
				{traces.length === 0 && !loading ? (
					<Empty
						title="No traces match these filters."
						hint="Runs appear here once something has used the agent. `nah serve` records every request it handles."
					/>
				) : (
					<div className="overflow-x-auto">
						<table className="w-full min-w-[54rem]">
							<thead className="border-b border-white/[0.06]">
								<tr>
									<SortHeader
										label="trace"
										field="name"
										sort={filters.sort ?? "startTime"}
										order={filters.order ?? "desc"}
										onChange={(f) => toggleSort(f as "name")}
									/>
									<SortHeader
										label="status"
										field="name"
										sort={filters.sort ?? "startTime"}
										order={filters.order ?? "desc"}
										onChange={(f) => toggleSort(f as "name")}
									/>
									<SortHeader
										label="started"
										field="startTime"
										sort={filters.sort ?? "startTime"}
										order={filters.order ?? "desc"}
										onChange={(f) => toggleSort(f as "startTime")}
									/>
									<SortHeader
										label="duration"
										field="duration"
										sort={filters.sort ?? "startTime"}
										order={filters.order ?? "desc"}
										onChange={(f) => toggleSort(f as "duration")}
										align="right"
									/>
									<SortHeader
										label="cost"
										field="costUsd"
										sort={filters.sort ?? "startTime"}
										order={filters.order ?? "desc"}
										onChange={(f) => toggleSort(f as "costUsd")}
										align="right"
									/>
									<SortHeader
										label="tokens"
										field="name"
										sort={filters.sort ?? "startTime"}
										order={filters.order ?? "desc"}
										onChange={(f) => toggleSort(f as "name")}
										align="right"
									/>
									<th className="px-3 py-2" />
								</tr>
							</thead>
							<tbody className="divide-y divide-white/[0.04]">
								{traces.map((trace) => (
									<tr
										key={trace.id}
										onClick={() => void open(trace.id)}
										className="cursor-pointer transition hover:bg-white/[0.03]"
									>
										<td className="px-3 py-2">
											<div className="flex items-center gap-2">
												<span className="text-xs text-zinc-200">
													{truncate(trace.name, 64)}
												</span>
												{trace.tags.map((tag) => (
													<Badge key={tag} tone="accent">
														{tag}
													</Badge>
												))}
											</div>
											<p className="num mt-0.5 font-mono text-[10px] text-zinc-600">
												{trace.id.slice(0, 16)}
											</p>
										</td>
										<td className="px-3 py-2">
											<span className="flex items-center gap-1.5 font-mono text-[11px] text-zinc-400">
												<StatusDot status={trace.status} />
												{trace.status}
											</span>
										</td>
										<td
											className="num px-3 py-2 font-mono text-[11px] text-zinc-500"
											title={timestamp(trace.startTime)}
										>
											{relativeTime(trace.startTime)}
										</td>
										<td className="num px-3 py-2 text-right font-mono text-[11px] text-zinc-400">
											{duration(
												(trace.endTime ?? trace.startTime) - trace.startTime,
											)}
										</td>
										<td className="num px-3 py-2 text-right font-mono text-[11px] text-zinc-400">
											{usd(trace.costUsd)}
										</td>
										<td className="num px-3 py-2 text-right font-mono text-[11px] text-zinc-500">
											{tokens(
												(trace.inputTokens ?? 0) + (trace.outputTokens ?? 0),
											)}
										</td>
										<td className="px-3 py-2 text-right">
											<span className="eyebrow">open →</span>
										</td>
									</tr>
								))}
							</tbody>
						</table>
					</div>
				)}
			</Panel>

			{selected && (
				<div
					className="fixed inset-0 z-50 flex justify-end bg-black/60"
					onClick={() => setSelected(null)}
				>
					<aside
						className="flex h-full w-full max-w-5xl flex-col overflow-y-auto border-l border-white/[0.08] bg-zinc-950"
						onClick={(event) => event.stopPropagation()}
					>
						<header className="sticky top-0 z-10 flex items-start justify-between gap-4 border-b border-white/[0.08] bg-zinc-950/95 px-5 py-4 backdrop-blur">
							<div className="min-w-0">
								<p className="eyebrow">trace</p>
								<h2 className="mt-1 truncate text-sm font-medium text-zinc-100">
									{selected.trace.name}
								</h2>
								<p className="num mt-0.5 font-mono text-[10px] text-zinc-600">
									{selected.trace.id}
								</p>
							</div>
							<Button onClick={() => setSelected(null)} variant="ghost">
								close
							</Button>
						</header>

						<div className="flex flex-col gap-5 px-5 py-5">
							<TraceSummary trace={selected.trace} />

							<Panel
								title={`spans · ${selected.spans.length}`}
								bodyClassName="p-0"
							>
								<div className="max-h-72 overflow-y-auto">
									<Waterfall
										spans={selected.spans}
										onSelect={setSelectedSpan}
										selectedId={selectedSpan?.id}
									/>
								</div>
							</Panel>

							<Panel title="span inspector">
								{selectedSpan ? (
									<SpanInspector span={selectedSpan} />
								) : (
									<Empty title="Pick a span above." />
								)}
							</Panel>
						</div>
					</aside>
				</div>
			)}
		</div>
	);
};
