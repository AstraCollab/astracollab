import { Fragment, type ReactNode } from "react";

import { Badge } from "./primitives";
import type { AgentDirectory } from "../lib/agents";
import { duration, relativeTime, usd } from "../lib/format";
import { statusTone } from "../store";
import type { AgentSummary } from "../types";

/**
 * The agents of one or more directories, as a table.
 *
 * Shared by the agents list and the overview's directory panel: both answer the
 * same question — which agents are in this place, and what did they cost — and
 * two versions of it would drift apart.
 */
export const AgentTable = ({
	groups,
	selectedAgentId,
	onOpenAgent,
	actions,
}: {
	groups: AgentDirectory[];
	selectedAgentId: string | null;
	onOpenAgent: (agentId: string) => void;
	/** Extra buttons on each row, if this table is one you can act in. */
	actions?: (agent: AgentSummary) => ReactNode;
}) => (
	<div className="overflow-x-auto">
		<table className="w-full text-xs">
			<thead>
				<tr className="border-b border-white/[0.06] text-left">
					<th className="eyebrow px-4 py-2 font-normal">agent</th>
					<th className="eyebrow px-3 py-2 font-normal">status</th>
					<th className="eyebrow px-3 py-2 text-right font-normal">traces</th>
					<th className="eyebrow px-3 py-2 text-right font-normal">errors</th>
					<th className="eyebrow px-3 py-2 text-right font-normal">median</th>
					<th className="eyebrow px-3 py-2 text-right font-normal">spend</th>
					<th className="eyebrow px-3 py-2 text-right font-normal">last seen</th>
					{actions && <th className="eyebrow px-3 py-2 font-normal" />}
				</tr>
			</thead>
			<tbody>
				{groups.map((group) => (
					<Fragment key={group.path}>
						<tr className="border-b border-white/[0.06] bg-white/[0.015]">
							<td colSpan={actions ? 8 : 7} className="px-4 py-2">
								<div className="flex flex-wrap items-center gap-2.5">
									<span className="text-xs text-zinc-200">{group.name}</span>
									<span className="eyebrow">
										{group.agents.length}{" "}
										{group.agents.length === 1 ? "agent" : "agents"}
									</span>
									{group.running > 0 && (
										<span className="eyebrow text-emerald-400/80">
											{group.running} running
										</span>
									)}
									<span
										className="truncate font-mono text-[10px] text-zinc-600"
										title={group.path}
									>
										{group.path}
									</span>
								</div>
							</td>
						</tr>
						{group.agents.map((agent) => (
							<AgentRow
								key={agent.id}
								agent={agent}
								selected={agent.id === selectedAgentId}
								onOpen={() => onOpenAgent(agent.id)}
								actions={actions}
							/>
						))}
					</Fragment>
				))}
			</tbody>
		</table>
	</div>
);

const AgentRow = ({
	agent,
	selected,
	onOpen,
	actions,
}: {
	agent: AgentSummary;
	selected: boolean;
	onOpen: () => void;
	actions?: (agent: AgentSummary) => ReactNode;
}) => {
	const tone = statusTone(agent.status);
	return (
		<tr
			className={`border-b border-white/[0.04] transition hover:bg-white/[0.03] ${selected ? "bg-white/[0.04]" : ""}`}
		>
			<td className="px-4 py-2.5">
				<button type="button" onClick={onOpen} className="text-left">
					<span className="flex items-center gap-2 text-zinc-100">
						<span
							className={`size-1.5 shrink-0 rounded-full ${tone.dot}`}
							aria-hidden
						/>
						{agent.name}
					</span>
					{/* The directory is in the group header above, so it is not repeated
					    on every row of the same group. */}
				</button>
			</td>
			<td className="px-3 py-2.5">
				<div className="flex items-center gap-1.5">
					<Badge tone={tone.badge}>{tone.label}</Badge>
					{agent.source === "launch" && (
						<span className="eyebrow text-zinc-600">launched</span>
					)}
				</div>
				{agent.model && (
					<span className="mt-1 block truncate font-mono text-[10px] text-zinc-600">
						{agent.model}
					</span>
				)}
			</td>
			<td className="num px-3 py-2.5 text-right text-zinc-300">
				{agent.traces.toLocaleString()}
			</td>
			<td
				className={`num px-3 py-2.5 text-right ${agent.errors > 0 ? "text-rose-300" : "text-zinc-600"}`}
			>
				{agent.errors.toLocaleString()}
			</td>
			<td className="num px-3 py-2.5 text-right text-zinc-400">
				{duration(agent.medianDurationMs)}
			</td>
			<td className="num px-3 py-2.5 text-right text-zinc-400">
				{usd(agent.costUsd)}
			</td>
			<td className="px-3 py-2.5 text-right text-zinc-500">
				{relativeTime(agent.lastSeenAt)}
			</td>
			{actions && (
				<td className="px-3 py-2.5 text-right">{actions(agent)}</td>
			)}
		</tr>
	);
};
