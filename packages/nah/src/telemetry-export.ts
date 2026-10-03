/**
 * Reporting this session to a running Studio.
 *
 * The agent in a terminal is the thing worth watching — it is the one doing the
 * work, and its traces are the evidence when something goes wrong at 2am. So a
 * session that finds a Studio reports to it, and a session that finds nothing
 * sends nothing anywhere: the endpoint file is the entire opt-in.
 *
 * Everything here is built to fail quietly. A turn must not fail because a
 * dashboard is not listening, a request must not hold up a turn, and a Studio
 * that has gone away must not produce an error in the transcript — the worst
 * outcome available would be a debugging tool breaking the thing it debugs.
 */
import { traceRun, type HarnessEvent, type Span, type Trace } from "not-another-harness";
import { hostname } from "node:os";
import { basename } from "node:path";
import { randomUUID } from "node:crypto";

import { liveEndpoint, type StudioEndpoint } from "./studio-endpoint.js";
import { readConfig, updateConfig } from "./nah-config.js";

/**
 * What the Studio is told about the process it is watching.
 *
 * Sent once per turn rather than per event: it does not change, and a heartbeat
 * on every span would be a request per tool call to say nothing new.
 */
export type AgentIdentity = {
  id: string;
  name: string;
  cwd: string;
  host: string;
  pid: number;
  model: string | null;
  version: string;
};

/**
 * Identity for this process.
 *
 * The id is per-process on purpose: two `nah` sessions in one repository are two
 * agents, and a dashboard that cannot tell them apart cannot answer "is anything
 * running right now". `name` is the grouping key, and it defaults to the
 * directory's name because a list of paths is not a list of agents.
 */
export const describeAgent = (options: {
  cwd: string;
  model?: string | null;
  env?: NodeJS.ProcessEnv;
  id?: string;
}): AgentIdentity => {
  const env = options.env ?? process.env;
  return {
    id: options.id ?? `ag_${randomUUID().replace(/-/g, "").slice(0, 16)}`,
    // `NAH_AGENT_NAME` is what the Studio sets when it launches an agent, so a
    // launched agent is named for the row the dashboard already has.
    name: env.NAH_AGENT_NAME?.trim() || basename(options.cwd) || "nah",
    cwd: options.cwd,
    host: hostname(),
    pid: process.pid,
    model: options.model ?? null,
    version: typeof __NAH_VERSION__ === "string" ? __NAH_VERSION__ : "0.0.0",
  };
};

export type TelemetryState = "on" | "off";

/**
 * Whether this session should report.
 *
 * Three inputs, in the order a user would expect to override them: an explicit
 * environment variable beats a remembered preference. Absent both, reporting is
 * on — but only ever to a Studio that published its own address, so "on" costs
 * one file read and nothing else.
 */
export const telemetryState = async (env: NodeJS.ProcessEnv = process.env): Promise<TelemetryState> => {
  const explicit = env.NAH_TELEMETRY?.trim().toLowerCase();
  if (explicit === "off" || explicit === "0" || explicit === "false") return "off";
  if (explicit === "on" || explicit === "1" || explicit === "true") return "on";
  return (await readConfig()).telemetry === "off" ? "off" : "on";
};

/** Remember a preference for later sessions. */
export const setTelemetryState = async (state: TelemetryState): Promise<void> => {
  await updateConfig((current) => ({ ...current, telemetry: state }));
};

/**
 * What is knowable about a trace before the run that fills it in has finished.
 *
 * A finished trace arrives whole, at the end. A trace that is still going has to
 * be sent from what the caller already knows, and the parts it knows are the
 * parts that never change: which run this is, what it was asked, which agent is
 * answering. What is missing — how long it took, whether it worked, which span
 * is the root — is exactly what the finished trace carries when it lands.
 */
export type TraceHint = {
  id: string;
  name: string;
  startTime: number;
  tags: string[];
  metadata: Record<string, unknown>;
};

/**
 * How often a running trace may be redrawn, in milliseconds.
 *
 * Long enough that a tool-heavy turn — which can close a span every few hundred
 * milliseconds — does not become a request per span, and short enough that
 * somebody watching a run does not see it sit still and conclude it is stuck.
 */
const PARTIAL_INTERVAL_MS = 500;

/**
 * A trace shape the Studio will accept from a run that has not finished.
 *
 * Deliberately not `Trace`: the fields that only exist at the end are empty
 * rather than guessed, and the finished trace overwrites all of them a moment
 * later. The server does not touch this row once it exists, so the only cost of
 * a mistake here is a trace that was briefly missing its end time.
 */
type RunningTrace = Trace;

type Running = {
  trace: RunningTrace;
  /** Spans produced since the last partial went out. */
  unsent: Span[];
  timer: ReturnType<typeof setTimeout> | null;
  inFlight: boolean;
  /** The open partial, so the final write can wait for it. */
  inFlightJob: Promise<unknown> | null;
  /** The run is over: stop starting partials, even if spans are still waiting. */
  closing: boolean;
  /** A partial was asked for while another was in flight. */
  again: boolean;
  /** How many partials have been sent, including the first one. */
  sent: number;
};

/** Project a hint onto the trace shape the ingest endpoint reads. */
const runningTrace = (hint: TraceHint): RunningTrace => ({
  id: hint.id,
  name: hint.name,
  startTime: hint.startTime,
  // All three are what the run will report for itself, the moment it ends.
  endTime: null,
  rootSpanId: "",
  status: "unset",
  tags: hint.tags,
  metadata: hint.metadata,
});

export type StudioSink = {
  /**
   * Announce a run, so its spans can reach the Studio while it is still running.
   *
   * Optional, and the sink is correct without it: a trace nobody announced is
   * buffered and sent whole at the end, exactly as before. This is how you opt in
   * to a run showing up in the dashboard while it is still happening.
   */
  begin: (hint: TraceHint) => void;
  /** A `TelemetrySink`, so a run can be traced without knowing about HTTP. */
  emit: (span: Span) => void;
  /** Send the finished trace. Called when the run ends, however it ends. */
  flush: (trace: Trace) => Promise<void>;
  /**
   * Register work that must finish before the process may exit.
   *
   * Recording and sending are one piece of work, not two, and only the second
   * half is a network request: a caller that waits for the request but not for
   * the recording is waiting for nothing, because the request has not been made
   * yet.
   */
  track: (job: Promise<unknown>) => void;
  /**
   * Resolves when everything tracked so far has landed.
   *
   * A one-shot `nah -p` exits the moment its turn is over, and anything still in
   * flight is cancelled by the exit — so the trace of the only run that process
   * will ever do would be the one that never arrived. An interactive session does
   * not need to wait for this; a process that is about to die does.
   */
  settled: () => Promise<void>;
};

/**
 * A sink that POSTs traces to a Studio.
 *
 * A finished trace is sent as one unit, because the Studio stores a trace whole
 * and a waterfall needs the entire span tree anyway. A trace that was announced
 * with `begin` is also sent while it runs, so a dashboard can draw it growing —
 * those partials are additive on the server, and the finished trace replaces
 * them, so being wrong about a partial only ever costs a moment.
 */
export const createStudioSink = (
  endpoint: StudioEndpoint,
  agent: AgentIdentity,
  options: { fetchImpl?: typeof fetch; now?: () => number } = {},
): StudioSink => {
  const fetchImpl = options.fetchImpl ?? fetch;
  const spansByTrace = new Map<string, Span[]>();
  // Announced runs only. A trace the caller never announced has no name or tags
  // to send, and inventing them would put a run in the dashboard under a name
  // nobody chose — so it waits for its final send, as it always did.
  const streaming = new Map<string, Running>();
  // Everything this sink owes somebody: recording a run, and the request that
  // carries it. One set, because from the outside it is one job.
  const work = new Set<Promise<unknown>>();

  const track = (job: Promise<unknown>): void => {
    work.add(job);
    void job.catch(() => undefined).finally(() => work.delete(job));
  };

  const post = async (trace: Trace | RunningTrace, spans: Span[], final: boolean): Promise<void> => {
    try {
      const response = await fetchImpl(new URL("/api/traces", endpoint.url), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(endpoint.token === undefined ? {} : { authorization: `Bearer ${endpoint.token}` }),
        },
        // The whole trace, minus the parts that make it large: a run's own
        // reasoning is what the model said, and the Studio has the root span.
        body: JSON.stringify({ agent, trace, spans, final }),
        signal: AbortSignal.timeout(5_000),
      });
      if (!response.ok) {
        // One 401 is worth knowing about — the token is wrong and no amount of
        // retrying fixes it — but it is a warning, never an error in the
        // transcript. Named and coded so it can be picked out of a log full of
        // unrelated warnings, and so a test can catch this one alone.
        if (response.status === 401) {
          process.emitWarning(`the Studio at ${endpoint.url} rejected this session's token`, {
            type: "NahStudioTokenWarning",
            code: "NAH_STUDIO_TOKEN_REJECTED",
          });
        }
      }
    } catch {
      // Offline, refused, timed out: a Studio that is not there is the normal
      // case, not a failure.
    }
  };

  /**
   * Send whatever a running trace has produced since it was last sent.
   *
   * Never awaited by `emit`, which is the whole point: a Studio that is slow
   * must not be able to slow down the model call that produced the span. One
   * request per trace at a time, and a request that lands while another is in
   * flight schedules the next rather than joining it — otherwise a fast run
   * would queue a request per span and finish its turn after its own dashboard.
   */
  const sendPartial = (traceId: string): void => {
    const running = streaming.get(traceId);
    if (!running) return;
    if (running.timer !== null) {
      clearTimeout(running.timer);
      running.timer = null;
    }
    if (running.inFlight) {
      // Whatever arrived while this one was in the air goes out the moment it
      // lands, so a quiet moment cannot strand spans the final send has to
      // carry anyway.
      running.again = true;
      return;
    }
    if (running.unsent.length === 0) return;

    const spans = running.unsent;
    running.unsent = [];
    running.sent += 1;
    running.inFlight = true;
    const job = post(running.trace, spans, false)
      .catch(() => undefined)
      .then(() => {
        running.inFlight = false;
        running.inFlightJob = null;
        // A run that is over does not get a trailing partial. The final write
        // carries every span anyway, so sending one now would only be a request
        // that arrives before the thing it is waiting for.
        if (running.closing) return;
        if (running.again || running.unsent.length > 0) {
          running.again = false;
          sendPartial(traceId);
        }
      });
    running.inFlightJob = job;
    track(job);
  };

  return {
    begin(hint: TraceHint): void {
      // A second `begin` for a live trace would reset what it has already sent,
      // so the first one wins: the caller that announced it is the one that knows.
      if (streaming.has(hint.id)) return;
      streaming.set(hint.id, {
        trace: runningTrace(hint),
        unsent: [],
        timer: null,
        inFlight: false,
        inFlightJob: null,
        closing: false,
        again: false,
        sent: 0,
      });
    },
    emit(span: Span): void {
      const existing = spansByTrace.get(span.traceId);
      if (existing) existing.push(span);
      else spansByTrace.set(span.traceId, [span]);

      const running = streaming.get(span.traceId);
      // A trace nobody announced waits for its final send, as it always did.
      if (!running) return;
      running.unsent.push(span);

      // The first span goes out at once: it is the one that makes the run
      // *appear*, and holding it back for the coalescing window would mean a
      // dashboard that stayed blank for exactly as long as it took to notice.
      if (running.sent === 0) {
        sendPartial(span.traceId);
        return;
      }
      // After that, coalesce. A run emits a span per model call and per tool,
      // which is several a second — each one is a tenth of a span, and the
      // Studio would be redrawing the same trace for all of them.
      if (running.timer === null) {
        const timer = setTimeout(() => sendPartial(span.traceId), PARTIAL_INTERVAL_MS);
        // Nothing here should be what keeps a one-shot `nah -p` alive.
        timer.unref?.();
        running.timer = timer;
      }
    },
    async flush(trace: Trace): Promise<void> {
      // The finished trace replaces everything the partials said, so it carries
      // every span — including the ones already sent.
      const running = streaming.get(trace.id);
      if (running) {
        if (running.timer !== null) {
          clearTimeout(running.timer);
          running.timer = null;
        }
        // Let the open partial land before the final goes out.
        //
        // A late partial is harmless to the row — the store ignores a second
        // insert and re-upserts spans the final already holds — but harmless is
        // not the same as orderly, and it depends on two things staying true:
        // that the final always carries every span a partial did, and that the
        // store never overwrites a trace row with an in-progress one. Waiting
        // costs one round trip on the exit path, and buys the simpler invariant
        // that the last write for a trace id is the one saying the run is over —
        // which is what lets anything downstream treat a missing final as
        // "this run never reported an ending" rather than a race.
        running.closing = true;
        // Bounded by the same 5s request timeout as every other post, so a
        // Studio that accepts the connection and never answers costs a bounded
        // wait, not a hung exit.
        if (running.inFlightJob) await running.inFlightJob;
      }
      streaming.delete(trace.id);
      const spans = spansByTrace.get(trace.id) ?? [];
      spansByTrace.delete(trace.id);
      await post(trace, spans, true);
    },
    track,
    async settled(): Promise<void> {
      // Looped rather than awaited once: a job in flight can add more work of its
      // own while we are waiting on it.
      while (work.size > 0) await Promise.allSettled([...work]);
    },
  };
};

export type StudioTelemetry = {
  sink: StudioSink;
  agent: AgentIdentity;
  endpoint: StudioEndpoint;
  /** Resolves when every trace sent so far has reached the Studio. */
  settled: () => Promise<void>;
};

/**
 * One stream, two readers.
 *
 * The harness's event queue is destructive — each `next()` shifts the item out of
 * it — so a second reader would take events away from the first rather than
 * seeing the same ones. Two consumers therefore cannot share a source; they have
 * to share a pump that fills a queue each.
 *
 * Unbounded on purpose. A slow reader must not stall the agent, and dropping
 * events would mean a trace that disagrees with what was rendered. A turn that
 * nobody watches holds a few hundred small objects for its own length, and then
 * releases them.
 */
export const teeEvents = <T>(source: AsyncIterable<T>): { a: AsyncIterable<T>; b: AsyncIterable<T> } => {
  const makeBranch = () => {
    const queue: T[] = [];
    const waiters: Array<() => void> = [];
    let closed = false;
    let failure: unknown;
    const wake = (): void => waiters.splice(0).forEach((resolve) => resolve());
    return {
      push(item: T): void {
        queue.push(item);
        wake();
      },
      close(): void {
        closed = true;
        wake();
      },
      fail(error: unknown): void {
        failure = error;
        closed = true;
        wake();
      },
      branch: async function* (): AsyncIterable<T> {
        for (;;) {
          const next = queue.shift();
          if (next !== undefined) {
            yield next;
            continue;
          }
          if (failure !== undefined) throw failure;
          if (closed) return;
          await new Promise<void>((resolve) => waiters.push(resolve));
        }
      },
    };
  };

  const left = makeBranch();
  const right = makeBranch();
  // Started immediately, not on first read: the branches are independent
  // consumers, and whichever one starts last must not decide when recording
  // begins. An error here has nowhere to go — both branches replay it.
  void (async () => {
    try {
      for await (const item of source) {
        left.push(item);
        right.push(item);
      }
      left.close();
      right.close();
    } catch (error) {
      left.fail(error);
      right.fail(error);
    }
  })();

  return { a: left.branch(), b: right.branch() };
};

/**
 * Trace a turn from a session that is reporting to a Studio.
 *
 * The same events the transcript renders are the ones recorded, so tracing cannot
 * change what the agent does, and the two can never disagree about what happened.
 *
 * The run is announced before its first span, so a turn that is still going shows
 * up as a turn that is still going. None of that reporting is awaited by the turn
 * — the spans are handed over and the sink sends them when it can.
 */
export const traceTurn = (
  telemetry: StudioTelemetry,
  events: AsyncIterable<HarnessEvent>,
  context: { prompt: string; model?: string },
): AsyncIterable<HarnessEvent> => {
  const branches = teeEvents(events);

  // The id is chosen here rather than left to the harness, because the sink
  // needs it before the run starts: a trace announced while it is still going
  // has to land under the same id it finishes under, or the dashboard shows the
  // run twice — once as a run in progress, once as the run that replaced it.
  const traceId = randomUUID().replace(/-/g, "");
  const tags = ["studio"];
  const metadata = { "nah.agent.id": telemetry.agent.id, "nah.agent.name": telemetry.agent.name };

  // Announced before the first span, so the dashboard can show the run existing
  // before it has done anything. Says what the turn *is*; the harness below
  // decides how it goes, and its answer is what finally lands.
  telemetry.sink.begin({
    id: traceId,
    name: context.prompt.slice(0, 60),
    startTime: Date.now(),
    tags,
    metadata,
  });

  const traced = traceRun(
    {
      sink: telemetry.sink,
      serviceName: "nah",
      traceId,
      tags,
      metadata,
    },
    branches.a,
    {
      rootSpanName: context.prompt.slice(0, 60),
      input: context.prompt,
      ...(context.model === undefined ? {} : { model: context.model }),
    },
  );

  // Not awaited by the turn, and never able to delay it: a dashboard that is slow,
  // or gone, must not be able to hold up an answer the user is waiting for. It is
  // *tracked* instead, so a process about to exit can wait for it — see
  // `StudioSink.settled`.
  //
  // A rejection here means the recorder itself failed, which for this engine means
  // the event stream threw rather than reporting a failure through an `error`
  // event. There is no trace to send in that case, and inventing one would put a
  // half-run in the dashboard as though it were a whole one.
  telemetry.sink.track(
    traced
      .then((trace) => (trace === null ? undefined : telemetry.sink.flush(trace)))
      .catch(() => undefined),
  );

  return branches.b;
};

/**
 * Connect to a running Studio, or return null when there is nothing to report to.
 *
 * Called once per session rather than per turn: the check is a file read and a
 * process-existence test, and doing it per turn would mean a session that
 * outlives its Studio keeps trying.
 */
export const connectStudio = async (options: {
  cwd: string;
  model?: string | null;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
}): Promise<StudioTelemetry | null> => {
  const env = options.env ?? process.env;
  if ((await telemetryState(env)) === "off") return null;
  const endpoint = await liveEndpoint();
  if (!endpoint) return null;
  const agent = describeAgent({ cwd: options.cwd, model: options.model ?? null, env });
  const sink = createStudioSink(endpoint, agent, {
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
  });

  // Say hello now, rather than on the first finished turn.
  //
  // This is the difference between a dashboard that lists the sessions on your
  // machine and one that lists the sessions that have recently finished
  // something. Registering here means the agent appears the moment it starts —
  // before any model call, while you are still typing the first prompt — and the
  // list is a list of what is running rather than a list of what has run.
  void registerWithStudio(endpoint, agent, options.fetchImpl);

  return { endpoint, agent, sink, settled: () => sink.settled() };
};

/**
 * Tell the Studio this agent exists.
 *
 * Fire-and-forget, and never awaited by the session: a Studio that is slow, or
 * gone, must not delay the first prompt. A failure here is not an error — the
 * first trace POST registers the agent anyway, so the worst case is a row that
 * appears a turn late.
 */
const registerWithStudio = async (
  endpoint: StudioEndpoint,
  agent: AgentIdentity,
  fetchImpl: typeof fetch | undefined,
): Promise<void> => {
  try {
    const send = fetchImpl ?? fetch;
    await send(new URL("/api/agents", endpoint.url), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(endpoint.token === undefined ? {} : { authorization: `Bearer ${endpoint.token}` }),
      },
      body: JSON.stringify({
        id: agent.id,
        name: agent.name,
        cwd: agent.cwd,
        host: agent.host,
        pid: agent.pid,
        model: agent.model,
        version: agent.version,
        source: "session",
      }),
      signal: AbortSignal.timeout(5_000),
    });
  } catch {
    // The endpoint file said there was a Studio here. If there is not, the next
    // attempt is the next turn.
  }
};

/**
 * Start reporting mid-session, after `/studio`.
 *
 * A `/studio` typed into a running session should not need the session to be
 * restarted for its next turn to show up in the dashboard, and asking the user to
 * quit and re-run to make a tool work is how a tool goes unused.
 */
export const attachStudio = async (
  state: { cwd: string; model?: { spec?: string } | null; studio?: StudioTelemetry | null },
  options: { env?: NodeJS.ProcessEnv; fetchImpl?: typeof fetch } = {},
): Promise<StudioTelemetry | null> => {
  if (state.studio) return state.studio;
  const telemetry = await connectStudio({
    cwd: state.cwd,
    model: state.model?.spec ?? null,
    ...(options.env === undefined ? {} : { env: options.env }),
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
  });
  state.studio = telemetry;
  return telemetry;
};

/** Stop reporting without ending the session. */
export const detachStudio = (state: { studio?: StudioTelemetry | null }): void => {
  state.studio = null;
};

declare const __NAH_VERSION__: string;