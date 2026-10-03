/**
 * Tracing for an agent run.
 *
 * Every run becomes a trace: one root span for the run, a span per model step, a
 * child span per tool call, and one per compaction. That is the shape a developer
 * actually needs at 2am — "which step was slow", "what did that tool receive",
 * "did this run cost 12 cents or 90" — and it is built here rather than by
 * instrumenting the loop, because the loop already emits the events that describe
 * all of it.
 *
 * Consuming the event stream rather than wrapping internals is deliberate: the
 * agent loop cannot tell it is being watched, an existing `runAgent` call gains
 * tracing by passing a recorder in, and there is no way for the instrumentation
 * to change what the agent does.
 *
 * The names follow OpenTelemetry's conventions (`gen_ai.usage.*`), because the
 * point of these records is to be exportable to whatever already understands
 * them, and because a private vocabulary means a rewrite before anything is.
 */
import type { HarnessEvent, HarnessUsage } from "./types.js";

/** What kind of work a span represents. Mirrors the shapes a run actually has. */
export type SpanKind = "agent" | "step" | "model" | "tool" | "compaction";

/**
 * `interrupted` is the one status this package never emits: it means a run
 * started, reported for a while, and then stopped without ever saying how it
 * ended — the process was killed, or it died mid-flight. Whoever stores a trace
 * decides that from evidence the agent cannot give (that it has stopped
 * reporting at all), because there is nothing to ask it. It lives here rather
 * than in one consumer's own vocabulary so that a span and the trace above it
 * cannot disagree about what they mean.
 */
export type SpanStatus = "ok" | "error" | "unset" | "interrupted";

/**
 * OpenTelemetry-style semantic attributes.
 *
 * An open map on purpose: a tool that wants `nah.tool.bytes` should not have to
 * change this file first.
 */
export type SpanAttributes = {
	"gen_ai.usage.input_tokens"?: number;
	"gen_ai.usage.output_tokens"?: number;
	"gen_ai.usage.cache_read_tokens"?: number;
	"gen_ai.usage.cache_write_tokens"?: number;
	/** Cumulative spend to the end of this span. Requires rates on the run. */
	"nah.cost.usd"?: number;
	"gen_ai.request.model"?: string;
	/** Prompt size for the request this step sent, cache composition included. */
	"nah.request.total_input_tokens"?: number;
	/** The uncached part of that prompt. */
	"nah.request.fresh_input_tokens"?: number;
	/** 0-1. The number worth putting on a dashboard. */
	"nah.request.cache_hit_rate"?: number;
	"nah.tool.name"?: string;
	"nah.tool.error"?: boolean;
	"nah.stop_reason"?: string;
	/** True when token counts were inferred rather than reported. */
	"nah.usage.estimated"?: boolean;
	[key: string]: string | number | boolean | null | undefined;
};

export type SpanError = { name: string; message: string; stack?: string };

export type Span = {
	id: string;
	traceId: string;
	parentId: string | null;
	name: string;
	kind: SpanKind;
	/** Epoch milliseconds. */
	startTime: number;
	/** Null while the span is still open. */
	endTime: number | null;
	status: SpanStatus;
	attributes: SpanAttributes;
	input?: unknown;
	output?: unknown;
	error?: SpanError;
	metadata: Record<string, unknown>;
};

export type Trace = {
	id: string;
	name: string;
	startTime: number;
	endTime: number | null;
	rootSpanId: string;
	status: SpanStatus;
	/** Root-only, like Mastra's: a tag describes the whole trace, not one step. */
	tags: string[];
	metadata: Record<string, unknown>;
	error?: SpanError;
};

/** Where finished spans go. Async is allowed so a sink can batch or write. */
export type TelemetrySink = {
	emit(span: Span): void | Promise<void>;
};

export type Sampling =
	| { type: "always" }
	| { type: "never" }
	| { type: "ratio"; probability: number }
	| {
			type: "custom";
			sampler: (context: {
				traceId: string;
				metadata: Record<string, unknown>;
			}) => boolean;
	  };

/**
 * Payload limits.
 *
 * A trace is a debugging aid, and an unbounded one is a liability: a 4 MB tool
 * result turns a 40 KB trace into a 4 MB row, and the cost is paid on every
 * export. Defaults match the sizes a developer actually reads.
 */
export type TelemetryLimits = {
	maxStringLength: number;
	maxDepth: number;
	maxArrayLength: number;
	maxObjectKeys: number;
};

const DEFAULT_LIMITS: TelemetryLimits = {
	maxStringLength: 8_192,
	maxDepth: 6,
	maxArrayLength: 50,
	maxObjectKeys: 50,
};

/**
 * Keys whose values are replaced before anything is recorded.
 *
 * On by default and biased towards over-redacting. A trace is written to disk and
 * read by anyone with the Studio open; a prompt containing a pasted key is
 * ordinary, not exotic, and a leaked credential is not recoverable by deleting a
 * row later.
 */
const DEFAULT_REDACTION = [
	/pass(word|phrase)?$/i,
	/secret/i,
	/token/i,
	/api[-_]?key/i,
	/authorization/i,
	/credential/i,
	/cookie/i,
	/private[-_]?key/i,
];

const REDACTED = "[redacted]";

const hex = (bytes: number): string =>
	Array.from({ length: bytes }, () =>
		Math.floor(Math.random() * 256)
			.toString(16)
			.padStart(2, "0"),
	).join("");

export type TelemetryOptions = {
	sink: TelemetrySink;
	serviceName?: string;
	sampling?: Sampling;
	/** Drop span inputs entirely. Use for prompts that carry PII. */
	hideInput?: boolean;
	/** Drop span outputs entirely. */
	hideOutput?: boolean;
	/** Extra patterns on top of the default secret-shaped keys. */
	redact?: RegExp[];
	limits?: Partial<TelemetryLimits>;
	/** Parent this trace into an external one (1-32 hex chars). */
	traceId?: string;
	/** Tags on the root span, for filtering. */
	tags?: string[];
	metadata?: Record<string, unknown>;
	/** Injected in tests; defaults to wall clock. */
	now?: () => number;
};

export type TraceContext = {
	/** Overrides the root span name, so a batch of runs is tellable apart. */
	rootSpanName?: string;
	/** Recorded on the root span. */
	input?: unknown;
	metadata?: Record<string, unknown>;
	tags?: string[];
	/** Set when the run had no model configured, for the record. */
	model?: string;
};

/** Deep copy with redaction and size limits applied. */
const sanitize = (
	value: unknown,
	limits: TelemetryLimits,
	patterns: RegExp[],
	depth = 0,
	seen = new WeakSet<object>(),
): unknown => {
	if (value === null || value === undefined) return value;
	if (typeof value === "string") {
		return value.length > limits.maxStringLength
			? `${value.slice(0, limits.maxStringLength)}… [${value.length} chars]`
			: value;
	}
	if (typeof value === "number" || typeof value === "boolean") return value;
	if (typeof value !== "object") return String(value);
	if (depth >= limits.maxDepth) return "[depth limit]";
	// Tool results are arbitrary objects from arbitrary code, and a cycle in one
	// would otherwise take the whole recorder down mid-run.
	if (seen.has(value as object)) return "[circular]";
	seen.add(value as object);

	if (Array.isArray(value)) {
		const kept = value
			.slice(0, limits.maxArrayLength)
			.map((item) => sanitize(item, limits, patterns, depth + 1, seen));
		return value.length > limits.maxArrayLength
			? [...kept, `[+${value.length - limits.maxArrayLength} more]`]
			: kept;
	}

	const source = value as Record<string, unknown>;
	const out: Record<string, unknown> = {};
	for (const [key, item] of Object.entries(source).slice(
		0,
		limits.maxObjectKeys,
	)) {
		out[key] = patterns.some((pattern) => pattern.test(key))
			? REDACTED
			: sanitize(item, limits, patterns, depth + 1, seen);
	}
	const dropped = Object.keys(source).length - Object.keys(out).length;
	return dropped > 0 ? { ...out, "[+keys dropped]": dropped } : out;
};

const toError = (error: unknown): SpanError => {
	if (error instanceof Error) {
		return {
			name: error.name,
			message: error.message,
			...(error.stack === undefined ? {} : { stack: error.stack }),
		};
	}
	return {
		name: "Error",
		message:
			typeof error === "string"
				? error
				: (JSON.stringify(error) ?? String(error)),
	};
};

/** Differences between two cumulative usage readings, which is all we get. */
const usageDelta = (
	current: HarnessUsage,
	previous: HarnessUsage,
): HarnessUsage => ({
	inputTokens: Math.max(0, current.inputTokens - previous.inputTokens),
	outputTokens: Math.max(0, current.outputTokens - previous.outputTokens),
	totalTokens: Math.max(0, current.totalTokens - previous.totalTokens),
	cachedInputTokens: Math.max(
		0,
		(current.cachedInputTokens ?? 0) - (previous.cachedInputTokens ?? 0),
	),
	cacheCreationInputTokens: Math.max(
		0,
		(current.cacheCreationInputTokens ?? 0) -
			(previous.cacheCreationInputTokens ?? 0),
	),
	// Dollar spend rides along with the tokens. Without this line the cost of a
	// single request does not exist anywhere on the wire: `HarnessUsage.spendUsd`
	// is cumulative for the run, so the only figure available was the run total,
	// and every request in a session read as though it had spent everything the
	// session spent.
	...(current.spendUsd === undefined && previous.spendUsd === undefined
		? {}
		: {
				spendUsd: Math.max(
					0,
					(current.spendUsd ?? 0) - (previous.spendUsd ?? 0),
				),
			}),
});

const EMPTY_USAGE: HarnessUsage = {
	inputTokens: 0,
	outputTokens: 0,
	totalTokens: 0,
};

/**
 * Decide whether this run is recorded.
 *
 * Ratio sampling uses a hash of the trace id rather than `Math.random`, so a
 * re-run of the same trace is sampled the same way and two scorers configured at
 * the same rate see the same runs.
 */
const shouldSample = (
	sampling: Sampling | undefined,
	traceId: string,
	metadata: Record<string, unknown>,
): boolean => {
	if (!sampling) return true;
	switch (sampling.type) {
		case "never":
			return false;
		case "always":
			return true;
		case "ratio": {
			const probability = Math.min(1, Math.max(0, sampling.probability));
			let hash = 0;
			for (let index = 0; index < traceId.length; index += 1)
				hash = (hash * 31 + traceId.charCodeAt(index)) >>> 0;
			return hash / 0xffffffff < probability;
		}
		case "custom":
			return sampling.sampler({ traceId, metadata });
	}
};

/**
 * Trace one run from its event stream.
 *
 * Returns the trace, or null when sampling declined it — the same contract as
 * "traceId is undefined when the trace was not sampled", so a caller cannot
 * accidentally report a trace id for a trace that does not exist.
 */
export const traceRun = async (
	options: TelemetryOptions,
	events: AsyncIterable<HarnessEvent>,
	context: TraceContext = {},
): Promise<Trace | null> => {
	const now = options.now ?? (() => Date.now());
	const limits = { ...DEFAULT_LIMITS, ...options.limits };
	const patterns = [...DEFAULT_REDACTION, ...(options.redact ?? [])];
	const traceId = options.traceId ?? hex(16);
	const metadata = { ...options.metadata, ...context.metadata };

	if (!shouldSample(options.sampling, traceId, metadata)) return null;

	const trace: Trace = {
		id: traceId,
		name: context.rootSpanName ?? "nah.run",
		startTime: now(),
		endTime: null,
		rootSpanId: "",
		status: "unset",
		tags: [...(options.tags ?? []), ...(context.tags ?? [])],
		metadata,
	};

	const spans: Span[] = [];
	const open = new Map<string, Span>();
	const toolSpans = new Map<string, Span>();
	let previousUsage: HarnessUsage = EMPTY_USAGE;
	/**
	 * Money attributed to the requests inside this trace, accumulated from
	 * per-request deltas rather than copied off a single cumulative reading.
	 *
	 * Two things fall out of keeping it here. A run that dies before `finish`
	 * still reports what it had spent up to that point, and the total is never
	 * read back off one mutable field on the root span — which is what let a
	 * cumulative figure be presented as the cost of one request.
	 */
	let tracedSpendUsd = 0;

	const emit = async (span: Span): Promise<void> => {
		spans.push(span);
		await options.sink.emit(span);
	};

	const start = (
		name: string,
		kind: SpanKind,
		parentId: string | null,
		input?: unknown,
	): Span => ({
		id: hex(8),
		traceId,
		parentId,
		name,
		kind,
		startTime: now(),
		endTime: null,
		status: "unset",
		attributes: {},
		...(input === undefined || options.hideInput
			? {}
			: { input: sanitize(input, limits, patterns) }),
		metadata: {},
	});

	const close = async (
		span: Span,
		outcome: { output?: unknown; error?: unknown } = {},
	): Promise<void> => {
		if (span.endTime !== null) return;
		span.endTime = now();
		if (outcome.error !== undefined) {
			span.status = "error";
			span.error = toError(outcome.error);
		} else if (span.status === "unset") {
			span.status = "ok";
		}
		if (outcome.output !== undefined && !options.hideOutput) {
			span.output = sanitize(outcome.output, limits, patterns);
		}
		open.delete(span.id);
		await emit(span);
	};

	const root = start(trace.name, "agent", null, context.input);
	trace.rootSpanId = root.id;
	if (context.model) root.attributes["gen_ai.request.model"] = context.model;

	for await (const event of events) {
		switch (event.type) {
			case "run-start": {
				// `null` rather than a number, because an unbounded run has no budget and
				// a span attribute of 0 would read as "allowed no steps".
				root.attributes["nah.run.step_budget"] = event.stepBudget;
				root.attributes["nah.run.token_budget"] = event.tokenBudget;
				break;
			}
			case "step-start": {
				const step = start(`step ${event.step}`, "step", root.id);
				// The model call is what the step is *for*; the tool calls hang off it,
				// so it gets its own span rather than being implied by the step's timing.
				const model = start(
					`model call (step ${event.step})`,
					"model",
					step.id,
				);
				open.set(step.id, step);
				open.set(model.id, model);
				break;
			}
			case "tool-call": {
				const step = [...open.values()].find(
					(span) => span.kind === "step" && span.endTime === null,
				);
				const tool = start(
					`tool: ${event.toolName}`,
					"tool",
					step?.id ?? root.id,
					event.input,
				);
				tool.attributes["nah.tool.name"] = event.toolName;
				toolSpans.set(event.toolCallId, tool);
				break;
			}
			case "tool-result": {
				const tool = toolSpans.get(event.toolCallId);
				toolSpans.delete(event.toolCallId);
				if (!tool) break;
				if (event.isError) {
					// The tool reported failure in its result rather than throwing, so the
					// span is marked here; a thrown error reaches close() instead.
					tool.attributes["nah.tool.error"] = true;
					await close(tool, { output: event.output });
					if (tool.status === "ok") tool.status = "error";
				} else {
					await close(tool, { output: event.output });
				}
				break;
			}
			case "step-finish": {
				const step = [...open.values()].find(
					(span) => span.kind === "step" && span.endTime === null,
				);
				const model = [...open.values()].find(
					(span) => span.kind === "model" && span.endTime === null,
				);
				// step-finish carries the run's *cumulative* usage, so the step's own cost
				// is the difference from the previous step. Reporting the cumulative
				// figure here would make step 7 of a 7-step run look like it spent
				// everything.
				const delta = usageDelta(event.usage, previousUsage);
				previousUsage = event.usage;
				const { totalInputTokens, freshInputTokens, cachedInputTokens } =
					event.request;
				const cachedFraction =
					totalInputTokens &&
					totalInputTokens > 0 &&
					cachedInputTokens !== undefined
						? cachedInputTokens / totalInputTokens
						: undefined;
				const attributes: SpanAttributes = {
					"gen_ai.usage.input_tokens": delta.inputTokens,
					"gen_ai.usage.output_tokens": delta.outputTokens,
					...(delta.cachedInputTokens
						? { "gen_ai.usage.cache_read_tokens": delta.cachedInputTokens }
						: {}),
					...(delta.cacheCreationInputTokens
						? {
								"gen_ai.usage.cache_write_tokens":
									delta.cacheCreationInputTokens,
							}
						: {}),
					...(totalInputTokens === undefined
						? {}
						: { "nah.request.total_input_tokens": totalInputTokens }),
					...(freshInputTokens === undefined
						? {}
						: { "nah.request.fresh_input_tokens": freshInputTokens }),
					...(cachedFraction === undefined
						? {}
						: {
								"nah.request.cache_hit_rate": Number(cachedFraction.toFixed(4)),
							}),
					// What *this* request cost, so the waterfall reads per request rather
					// than as a running total. Absent when no rates were supplied, which
					// is the honest state for a model we cannot price.
					...(delta.spendUsd === undefined
						? {}
						: { "nah.cost.usd": delta.spendUsd }),
					...(event.usage.estimated ? { "nah.usage.estimated": true } : {}),
				};
				if (delta.spendUsd !== undefined) {
					tracedSpendUsd += delta.spendUsd;
					root.attributes["nah.cost.usd"] = tracedSpendUsd;
				}
				if (model) {
					Object.assign(model.attributes, attributes);
					await close(model);
				}
				if (step) {
					Object.assign(step.attributes, attributes);
					await close(step);
				}
				break;
			}
			case "compacted": {
				const span = start("compaction", "compaction", root.id);
				span.attributes["nah.compaction.dropped_messages"] =
					event.droppedMessages;
				span.attributes["nah.compaction.kept_messages"] = event.keptMessages;
				span.attributes["nah.compaction.summary_chars"] = event.summaryChars;
				await close(span, { output: event });
				break;
			}
			case "wrap-up": {
				root.attributes["nah.wrap_up_reason"] = event.reason;
				break;
			}
			case "user-message": {
				root.metadata[
					`user_message_${event.delivery}_${Object.keys(root.metadata).length}`
				] = event.text;
				break;
			}
			case "finish": {
				root.attributes["nah.stop_reason"] = event.reason;
				root.attributes["gen_ai.usage.input_tokens"] = event.usage.inputTokens;
				root.attributes["gen_ai.usage.output_tokens"] =
					event.usage.outputTokens;
				if (event.usage.cachedInputTokens !== undefined) {
					root.attributes["gen_ai.usage.cache_read_tokens"] =
						event.usage.cachedInputTokens;
				}
				if (event.usage.cacheCreationInputTokens !== undefined) {
					root.attributes["gen_ai.usage.cache_write_tokens"] =
						event.usage.cacheCreationInputTokens;
				}
				if (event.usage.spendUsd !== undefined) {
					// The steps have already been charged to the trace total. Compaction
					// bills through the same meter but reports no `step-finish`, so the
					// remainder since the last step is added here instead of the
					// accumulated figure being overwritten with the run total.
					tracedSpendUsd += Math.max(
						0,
						event.usage.spendUsd - (previousUsage.spendUsd ?? 0),
					);
					root.attributes["nah.cost.usd"] = tracedSpendUsd;
				}
				if (event.usage.estimated)
					root.attributes["nah.usage.estimated"] = true;
				await close(root, { output: event.text });
				break;
			}
			case "error": {
				await close(root, { error: event.error });
				break;
			}
			case "text-delta":
				// Deliberately not recorded. Per-delta spans would multiply storage by the
				// token count for a record nobody reads; the assembled text is on the root
				// span's output when the run finishes.
				break;
			case "tool-approval-request": {
				// The tool span is closed here rather than left to the orphan sweep at the
				// end, because "waiting for a person" and "crashed mid-call" are different
				// facts about a run and a trace that cannot tell them apart sends whoever
				// is debugging it to the wrong place. `unset` is left deliberately: the
				// call did not fail, it has not run.
				const tool = toolSpans.get(event.toolCallId);
				if (tool && !event.isAutomatic) {
					tool.attributes["nah.tool.awaiting_approval"] = true;
					await close(tool);
					toolSpans.delete(event.toolCallId);
				}
				break;
			}
			case "tool-approval-response":
				// Nothing to close: the request above already closed the span, and the
				// decision itself is recorded on the root via the events that follow it —
				// a result for an approved call, an error result for a denied one.
				break;
		}
	}

	// A run that ended without `finish` or `error` (an abort, a crash) still has a
	// root span, and leaving it open would make the waterfall look like the agent
	// is still thinking. The same is true of the step and model spans open inside
	// it: on an abort, the step that was in flight is the one being debugged, so it
	// is closed here rather than dropped.
	for (const span of [...open.values()].reverse()) await close(span);
	await close(root);
	trace.endTime = root.endTime;
	trace.status = root.status;
	if (root.error) trace.error = root.error;

	return trace;
};

/** A sink that keeps spans in memory. For tests, and for a server with a buffer. */
export const memorySink = (): TelemetrySink & { spans: Span[] } => {
	const spans: Span[] = [];
	return { spans, emit: (span) => void spans.push(span) };
};
