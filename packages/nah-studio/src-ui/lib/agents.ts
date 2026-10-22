import type { AgentSummary } from "../types";

/**
 * Agents, grouped by the directory they ran in.
 *
 * A directory is the one thing every agent shares that a person recognises: the
 * project it was working in. A flat list of agents is a list of names, and names
 * repeat — four agents can all be called `astracollab`, because that is what
 * their working directory is called. The list of directories is the list of
 * places work happened, and that is what you navigate by.
 */
export type AgentDirectory = {
	/** The working directory, exactly as the agent reported it. */
	path: string;
	/** The last segment of the path — what a person calls the directory. */
	name: string;
	agents: AgentSummary[];
	/** How many of them are running or starting right now. */
	running: number;
};

/**
 * The last segment of a path.
 *
 * `/Users/x/code/astracollab` is `astracollab`; a trailing slash is not a
 * directory of its own, and the root is still the root.
 */
export const directoryName = (path: string): string => {
	const parts = path.replace(/[\\/]+$/, "").split(/[\\/]+/).filter(Boolean);
	return parts[parts.length - 1] ?? path;
};

/**
 * Group agents by their working directory.
 *
 * Directories are sorted by path, so the list reads like a tree rather than
 * reshuffling every time an agent moves. Agents inside a directory keep the
 * order they arrived in, which is most-recently-active first.
 */
export const groupAgentsByDirectory = (
	agents: AgentSummary[],
): AgentDirectory[] => {
	const groups = new Map<string, AgentSummary[]>();
	for (const agent of agents) {
		const path = agent.cwd.trim() || "/";
		const existing = groups.get(path);
		if (existing) existing.push(agent);
		else groups.set(path, [agent]);
	}
	return [...groups.entries()]
		.map(([path, group]) => ({
			path,
			name: directoryName(path),
			agents: group,
			running: group.filter(
				(agent) => agent.status === "running" || agent.status === "starting",
			).length,
		}))
		.sort((a, b) => a.path.localeCompare(b.path));
};
