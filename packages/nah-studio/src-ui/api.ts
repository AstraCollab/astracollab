import type {
	Agent,
	AgentLogLine,
	AgentSummary,
	ChatResponse,
	Dataset,
	DatasetItem,
	Experiment,
	ExperimentSummaryRow,
	Message,
	Overview,
	Scorer,
	ToolStat,
	Trace,
	TraceDetail,
	WorkflowRunDetail,
	WorkflowRunSummary,
	WorkflowSummary,
} from "./types";

/**
 * One place that knows how to talk to the server.
 *
 * The token dance is here rather than in every view because a 401 mid-session
 * should ask once, not once per component: the prompt() below caches the answer
 * in localStorage, so the second 401 is silent.
 */

const TOKEN_KEY = "nah.studio.token";

export class ApiError extends Error {
	constructor(
		message: string,
		readonly status: number,
	) {
		super(message);
		this.name = "ApiError";
	}
}

let promptedForToken = false;

const request = async <T>(path: string, init: RequestInit = {}): Promise<T> => {
	const token = localStorage.getItem(TOKEN_KEY);
	const response = await fetch(path, {
		...init,
		headers: {
			"content-type": "application/json",
			...(token ? { authorization: `Bearer ${token}` } : {}),
			...(init.headers ?? {}),
		},
	});

	if (response.status === 401 && !promptedForToken) {
		promptedForToken = true;
		const supplied = window.prompt(
			"This Studio requires NAH_STUDIO_TOKEN. Paste it:",
		);
		if (supplied) {
			localStorage.setItem(TOKEN_KEY, supplied);
			promptedForToken = false;
			return request<T>(path, init);
		}
	}

	if (response.status === 204) return null as T;
	const text = await response.text();
	const data = text ? (JSON.parse(text) as unknown) : null;
	if (!response.ok) {
		const message =
			data && typeof data === "object" && "error" in data
				? String((data as { error: unknown }).error)
				: response.statusText;
		throw new ApiError(message, response.status);
	}
	return data as T;
};

const query = (params: Record<string, string | number | undefined>): string => {
	const search = new URLSearchParams();
	for (const [key, value] of Object.entries(params)) {
		if (value !== undefined && value !== "" && value !== "all")
			search.set(key, String(value));
	}
	const text = search.toString();
	return text ? `?${text}` : "";
};

export type TraceFilters = {
	search?: string;
	status?: string;
	tag?: string;
	since?: number;
	until?: number;
	/** Scope to one agent. Omitted means every agent. */
	agentId?: string | null;
	sort?: "startTime" | "name" | "costUsd" | "duration";
	order?: "asc" | "desc";
	limit?: number;
};

export type StudioInfo = {
	service: string;
	version: string;
	cwd: string;
	model: string | null;
	launcher: { available: boolean; command: string | null };
};

export const api = {
	health: () => request<{ ok: boolean; service: string }>("/api/health"),
	info: () => request<StudioInfo>("/api/info"),
	overview: (buckets?: number, agentId?: string | null) =>
		request<Overview>(
			`/api/overview${query({ buckets, agentId: agentId ?? undefined })}`,
		),

	traces: (filters: TraceFilters = {}) =>
		request<Trace[]>(
			`/api/traces${query({
				search: filters.search,
				status: filters.status,
				tag: filters.tag,
				agentId: filters.agentId ?? undefined,
				since: filters.since,
				until: filters.until,
				sort: filters.sort,
				order: filters.order,
				limit: filters.limit ?? 200,
			})}`,
		),

	trace: (id: string) =>
		request<TraceDetail | null>(`/api/traces/${encodeURIComponent(id)}`),

	tools: (agentId?: string | null) =>
		request<ToolStat[]>(
			`/api/tools${query({ agentId: agentId ?? undefined })}`,
		),
	messages: (limit = 50) =>
		request<Message[]>(`/api/messages${query({ limit })}`),

	/**
	 * Every agent, each with its own totals.
	 *
	 * Fetched on mount as the fallback for the live stream, and re-fetched whenever
	 * an agent changes, so a dashboard whose stream is blocked still works.
	 */
	agents: () => request<AgentSummary[]>("/api/agents"),
	agent: (id: string) =>
		request<Agent | null>(`/api/agents/${encodeURIComponent(id)}`),
	agentLogs: (id: string, limit = 500) =>
		request<AgentLogLine[]>(
			`/api/agents/${encodeURIComponent(id)}/logs${query({ limit })}`,
		),

	/**
	 * Start an agent.
	 *
	 * A real `nah` process with one prompt, so it registers and traces itself like
	 * any other. The response is the agent row, not the run — watching it happen is
	 * the point, and a request that waited for a whole task would look like a hang.
	 */
	launchAgent: (body: {
		cwd: string;
		name?: string;
		prompt: string;
		model?: string;
	}) =>
		request<{ ok: boolean; agent: Agent | null; error?: string }>(
			"/api/agents/launch",
			{
				method: "POST",
				body: JSON.stringify(body),
			},
		),

	stopAgent: (id: string) =>
		request<{ ok: boolean; error?: string }>(
			`/api/agents/${encodeURIComponent(id)}/stop`,
			{ method: "POST" },
		),

	removeAgent: (id: string) =>
		request<{ ok: boolean }>(`/api/agents/${encodeURIComponent(id)}`, {
			method: "DELETE",
		}),

	datasets: () => request<Dataset[]>("/api/datasets"),
	datasetItems: (id: string) =>
		request<DatasetItem[]>(`/api/datasets/${encodeURIComponent(id)}/items`),
	createDataset: (body: {
		name: string;
		description?: string;
		items?: Array<{ input: string; expected?: string }>;
	}) =>
		request<{ id: string; version: number; items: number }>("/api/datasets", {
			method: "POST",
			body: JSON.stringify(body),
		}),
	deleteDataset: (id: string) =>
		request<{ ok: boolean }>(`/api/datasets/${encodeURIComponent(id)}`, {
			method: "DELETE",
		}),

	scorers: () => request<Scorer[]>("/api/scorers"),

	/**
	 * Starts an experiment and returns immediately.
	 *
	 * The server runs it in the background and the view polls, because a run over a
	 * real dataset takes minutes and a spinner with no progress is indistinguishable
	 * from a hang.
	 */
	startExperiment: (body: { datasetId: string; scorerIds: string[] }) =>
		request<{ id: string }>("/api/experiments", {
			method: "POST",
			body: JSON.stringify(body),
		}),
	experiments: () => request<ExperimentSummaryRow[]>("/api/experiments"),
	experiment: (id: string) =>
		request<Experiment | null>(`/api/experiments/${encodeURIComponent(id)}`),

	chat: (message: string) =>
		request<ChatResponse>("/api/chat", {
			method: "POST",
			body: JSON.stringify({ message }),
		}),

	/**
	 * Workflows.
	 *
	 * These routes answer with a body, not a status code: a Studio with no runner
	 * attached gets `{ error }` with a 200, because the Studio itself is fine — it is
	 * the machine under it that cannot run anything. Throwing here would paint the
	 * whole screen red for a condition the header explains better than an error
	 * banner can, so each envelope is typed as the union it really is and the view
	 * decides which half it is holding.
	 */
	workflows: () => request<WorkflowRoster>(`/api/workflows`),

	launchWorkflow: (id: string, input?: unknown) =>
		request<WorkflowLaunch>(`/api/workflows/${encodeURIComponent(id)}/run`, {
			method: "POST",
			body: JSON.stringify(input === undefined ? {} : { input }),
		}),

	workflowRuns: (workflowId?: string) =>
		request<WorkflowRuns>(`/api/workflow-runs${query({ workflowId })}`),

	workflowRun: (id: string) =>
		request<WorkflowRun>(`/api/workflow-runs/${encodeURIComponent(id)}`),

	stopWorkflowRun: (id: string) =>
		request<WorkflowOutcome>(
			`/api/workflow-runs/${encodeURIComponent(id)}/stop`,
			{ method: "POST" },
		),

	resumeWorkflowRun: (id: string, resumeData?: unknown) =>
		request<WorkflowOutcome>(
			`/api/workflow-runs/${encodeURIComponent(id)}/resume`,
			{
				method: "POST",
				body: JSON.stringify(
					resumeData === undefined ? {} : { resumeData },
				),
			},
		),
};

export type WorkflowRoster =
	| { workflows: WorkflowSummary[]; canRun: boolean; model: string | null }
	| { error: string };
export type WorkflowLaunch = { ok: true; runId: string } | { error: string };
export type WorkflowRuns = { runs: WorkflowRunSummary[] } | { error: string };
export type WorkflowRun = { run: WorkflowRunDetail | null } | { error: string };
/**
 * Stop and resume answer in three voices: refused (`ok: false` plus a reason),
 * unavailable (`{ error }`, no runner), and done. Only the first two are problems,
 * and they are told apart here so the view does not have to guess which it got.
 */
export type WorkflowOutcome =
	| { ok: true }
	| { ok: false; reason?: string }
	| { error: string };
