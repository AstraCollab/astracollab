import { useState } from "react";

import { AgentTable } from "./AgentTable";
import { Badge, Button, Empty, Panel } from "./primitives";
import { groupAgentsByDirectory } from "../lib/agents";
import { useStudio } from "../store";
import type { AgentSummary } from "../types";

/**
 * A two-level browser: directories with counts, then the agents inside one.
 *
 * The overview and the agents list both need this pattern — a directory is the
 * unit a person thinks in, so the first choice is always "which place", and the
 * second is "which agent in that place". Putting it here keeps the two views
 * from drifting apart.
 */
export const AgentBrowser = ({
	onOpenAgent,
	onBack,
	startAtDirectory,
}: {
	onOpenAgent: (agentId: string) => void;
	/** Called when the user wants to go back up a level. */
	onBack: () => void;
	/** Optional directory to open directly (e.g. from a deep link or scope). */
	startAtDirectory?: string | null;
}) => {
	const { agents } = useStudio();
	const [selectedDirectory, setSelectedDirectory] = useState<string | null>(
		startAtDirectory ?? null,
	);
	const groups = groupAgentsByDirectory(agents);

	// No agents at all — nothing to browse.
	if (groups.length === 0) {
		return (
			<Panel title="agents">
				<Empty
					title="No agents yet"
					hint="Start one, or run nah in another terminal — a session that finds this Studio reports to it by itself."
				/>
			</Panel>
		);
	}

	// Directory list level.
	if (!selectedDirectory) {
		const totalAgents = groups.reduce((sum, group) => sum + group.agents.length, 0);
		const totalRunning = groups.reduce((sum, group) => sum + group.running, 0);

		return (
			<Panel
				title="directories with agents"
				action={
					<div className="flex items-center gap-2">
						<Badge tone="neutral">{groups.length} directories</Badge>
						<Badge tone="neutral">{totalAgents} agents</Badge>
						{totalRunning > 0 && (
							<Badge tone="good">{totalRunning} running</Badge>
						)}
					</div>
				}
			>
				<div className="overflow-x-auto">
					<table className="w-full text-xs">
						<thead>
							<tr className="border-b border-white/[0.06] text-left">
								<th className="eyebrow px-4 py-2 font-normal">directory</th>
								<th className="eyebrow px-3 py-2 text-right font-normal">agents</th>
								<th className="eyebrow px-3 py-2 text-right font-normal">running</th>
								<th className="eyebrow px-3 py-2 text-right font-normal">traces</th>
								<th className="eyebrow px-3 py-2 text-right font-normal">errors</th>
								<th className="eyebrow px-3 py-2 text-right font-normal">spend</th>
							</tr>
						</thead>
						<tbody>
							{groups.map((group) => (
								<tr
									key={group.path}
									className="border-b border-white/[0.04] transition hover:bg-white/[0.03]"
								>
									<td className="px-4 py-2.5">
										<button
											type="button"
											onClick={() => setSelectedDirectory(group.path)}
											className="text-left w-full"
										>
											<div className="flex flex-wrap items-center gap-2.5">
												<span className="text-xs text-zinc-100">{group.name}</span>
												<span className="truncate font-mono text-[10px] text-zinc-600" title={group.path}>
													{group.path}
												</span>
											</div>
										</button>
									</td>
									<td className="num px-3 py-2.5 text-right text-zinc-300">
										{group.agents.length}
									</td>
									<td className="num px-3 py-2.5 text-right text-zinc-400">
										{group.running}
									</td>
									<td className="num px-3 py-2.5 text-right text-zinc-400">
										{group.agents.reduce((sum, agent) => sum + agent.traces, 0).toLocaleString()}
									</td>
									<td className="num px-3 py-2.5 text-right text-rose-300">
										{group.agents.reduce((sum, agent) => sum + agent.errors, 0).toLocaleString()}
									</td>
									<td className="num px-3 py-2.5 text-right text-zinc-400">
										{group.agents.reduce((sum, agent) => sum + agent.costUsd, 0).toFixed(4)}
									</td>
								</tr>
							))}
						</tbody>
					</table>
				</div>
			</Panel>
		);
	}

	// Agent list level (inside one directory).
	const group = groups.find((g) => g.path === selectedDirectory);
	if (!group) {
		// Directory was removed while we were looking at it.
		return (
			<Panel title="agents">
				<Empty
					title="Directory no longer has agents"
					hint="It may have been cleaned up. Go back to pick another."
				/>
			</Panel>
		);
	}

	return (
		<Panel
			title={`agents in ${group.name}`}
			action={
				<div className="flex items-center gap-2">
					<Button variant="ghost" onClick={() => setSelectedDirectory(null)}>
						all directories
					</Button>
					<Badge tone="neutral">{group.agents.length} agents</Badge>
					{group.running > 0 && <Badge tone="good">{group.running} running</Badge>}
				</div>
			}
		>
			{group.agents.length === 0 ? (
				<Empty
					title="No agents in this directory"
					hint="An agent appears here as soon as it reports this directory."
				/>
			) : (
				<AgentTable
					groups={[group]}
					selectedAgentId={null}
					onOpenAgent={onOpenAgent}
				/>
			)}
		</Panel>
	);
};