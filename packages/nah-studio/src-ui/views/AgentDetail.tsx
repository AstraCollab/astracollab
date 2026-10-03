import { useCallback, useEffect, useState } from "react";

import { api } from "../api";
import { duration, percent, relativeTime, timestamp, tokens, usd } from "../lib/format";
import { Badge, Button, Empty, ErrorNote, Panel, Stat } from "../components/primitives";
import { statusTone, useStudio } from "../store";
import type { AgentLogLine, AgentSummary, Trace } from "../types";

/**
 * One agent, in full.
 *
 * Its own view rather than a panel that appears at the bottom of the list,
 * because the questions about an agent — what is it doing, what has it run, what
 * did it say — are about that agent, and answering them next to nine other agents
 * makes the reader do the arithmetic of working out which row they belong to.
 *
 * Everything here is that agent's. The scope selector in the header stays as it
 * is: this view is a place, and the selector is a filter over every place.
 */
export const AgentDetailView = ({
  agentId,
  onBack,
  onOpenTrace,
}: {
  agentId: string;
  onBack: () => void;
  onOpenTrace: (traceId: string) => void;
}) => {
  const { agents, agentVersion, traceVersion, setSelectedAgentId, selectedAgentId } = useStudio();
  const [logs, setLogs] = useState<AgentLogLine[]>([]);
  const [traces, setTraces] = useState<Trace[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const agent = agents.find((candidate) => candidate.id === agentId) ?? null;

  useEffect(() => {
    let cancelled = false;
    void api
      .agentLogs(agentId)
      .then((next) => {
        if (!cancelled) setLogs(next);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [agentId, agentVersion]);

  useEffect(() => {
    let cancelled = false;
    void api
      // A recent slice, not the whole history: this view is about what the agent
      // is doing now, and Traces is where the full list lives.
      .traces({ agentId, limit: 25, sort: "startTime", order: "desc" })
      .then((next) => {
        if (!cancelled) setTraces(next);
      })
      .catch((caught) => {
        if (!cancelled) setError(caught instanceof Error ? caught.message : String(caught));
      });
    return () => {
      cancelled = true;
    };
  }, [agentId, traceVersion]);

  const stop = useCallback(async () => {
    setBusy(true);
    try {
      await api.stopAgent(agentId);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }, [agentId]);

  if (!agent) {
    // Removed from the list while it was open. The traces are still there; the row
    // is not, and saying so is better than a page of zeroes.
    return (
      <Empty
        title="This agent is no longer listed"
        hint="Its traces were kept. Go back to the list to see the ones still running."
      />
    );
  }

  const tone = statusTone(agent.status);
  const errorRate = agent.traces === 0 ? 0 : agent.errors / agent.traces;

  return (
    <div className="flex flex-col gap-4">
      <Panel
        title="agent"
        action={
          <div className="flex items-center gap-2">
            {selectedAgentId !== agent.id && (
              <Button variant="ghost" onClick={() => setSelectedAgentId(agent.id)}>
                scope every view here
              </Button>
            )}
            {agent.source === "launch" && agent.status === "running" && (
              <Button onClick={() => void stop()} disabled={busy} variant="danger">
                stop
              </Button>
            )}
            <Button onClick={onBack} variant="ghost">
              back to agents
            </Button>
          </div>
        }
      >
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className={`size-2 shrink-0 rounded-full ${tone.dot}`} aria-hidden />
              <span className="truncate text-sm text-zinc-100">{agent.name}</span>
              <Badge tone={tone.badge}>{tone.label}</Badge>
              {agent.source === "launch" && <span className="eyebrow text-zinc-600">launched by the studio</span>}
            </div>
            <p className="mt-1 break-all font-mono text-[11px] text-zinc-500">{agent.cwd}</p>
          </div>
          <dl className="grid shrink-0 grid-cols-2 gap-x-6 gap-y-1.5 text-[11px] sm:grid-cols-3">
            <Fact label="host" value={agent.host || "—"} />
            <Fact label="pid" value={agent.pid === null ? "—" : String(agent.pid)} />
            <Fact label="version" value={agent.version ?? "—"} />
            <Fact label="model" value={agent.model ?? "—"} />
            <Fact label="started" value={relativeTime(agent.startedAt)} />
            <Fact label="last seen" value={relativeTime(agent.lastSeenAt)} />
          </dl>
        </div>
      </Panel>

      {error && <ErrorNote error={error} onRetry={() => setError(null)} />}

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
        <Stat label="traces" value={agent.traces.toLocaleString()} detail="this agent, all time" />
        <Stat
          label="error rate"
          value={percent(errorRate, 1)}
          tone={errorRate > 0.05 ? "danger" : errorRate > 0 ? "warn" : "default"}
          detail={agent.traces === 0 ? "no runs yet" : `${agent.errors} failed of ${agent.traces}`}
        />
        <Stat label="median run" value={duration(agent.medianDurationMs)} detail="last 200 runs" />
        <Stat label="spend" value={usd(agent.costUsd)} detail="this agent" />
        <Stat
          label="tokens"
          value={tokens(agent.inputTokens + agent.outputTokens)}
          detail={`${tokens(agent.outputTokens)} out`}
        />
      </div>

      <Panel title="recent runs" action={<span className="eyebrow text-zinc-600">{traces.length}</span>}>
        {traces.length === 0 ? (
          <Empty
            title="Nothing yet"
            hint="Traces appear here as soon as this agent finishes a turn — a session reports its own runs, and a launched one is followed from the moment it starts."
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-white/[0.06] text-left">
                  <th className="eyebrow px-4 py-2 font-normal">run</th>
                  <th className="eyebrow px-3 py-2 font-normal">status</th>
                  <th className="eyebrow px-3 py-2 text-right font-normal">took</th>
                  <th className="eyebrow px-3 py-2 text-right font-normal">spend</th>
                  <th className="eyebrow px-3 py-2 text-right font-normal">started</th>
                </tr>
              </thead>
              <tbody>
                {traces.map((trace) => (
                  <tr key={trace.id} className="border-b border-white/[0.04] transition hover:bg-white/[0.03]">
                    <td className="px-4 py-2.5">
                      <button type="button" onClick={() => onOpenTrace(trace.id)} className="max-w-[24rem] truncate text-left text-zinc-200">
                        {trace.name}
                      </button>
                    </td>
                    <td className="px-3 py-2.5">
                      <Badge tone={trace.status === "error" ? "danger" : "good"}>{trace.status}</Badge>
                    </td>
                    <td className="num px-3 py-2.5 text-right text-zinc-400">
                      {duration(trace.endTime === null ? null : trace.endTime - trace.startTime)}
                    </td>
                    <td className="num px-3 py-2.5 text-right text-zinc-400">{usd(trace.costUsd)}</td>
                    <td className="px-3 py-2.5 text-right text-zinc-500" title={timestamp(trace.startTime)}>
                      {relativeTime(trace.startTime)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      <Panel title="output" bodyClassName="p-0">
        {logs.length === 0 ? (
          <Empty
            title="No output"
            hint="An agent this Studio launched prints here as it runs. A session you started yourself has no captured output — its transcript is in its own terminal."
          />
        ) : (
          <pre className="max-h-96 overflow-auto px-4 py-3 font-mono text-[11px] leading-5 text-zinc-400">
            {logs.map((line) => (
              <span
                key={line.seq}
                className={`block ${line.stream === "stderr" ? "text-rose-300/80" : line.stream === "system" ? "text-zinc-600" : ""}`}
              >
                <span className="text-zinc-700">{relativeTime(line.at)} </span>
                {line.text}
              </span>
            ))}
          </pre>
        )}
      </Panel>
    </div>
  );
};

const Fact = ({ label, value }: { label: string; value: string }) => (
  <div>
    <dt className="eyebrow text-zinc-600">{label}</dt>
    <dd className="mt-0.5 truncate font-mono text-zinc-300" title={value}>
      {value}
    </dd>
  </div>
);