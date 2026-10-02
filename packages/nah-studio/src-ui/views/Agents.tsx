import { useCallback, useEffect, useState } from "react";

import { api } from "../api";
import { duration, percent, relativeTime, usd } from "../lib/format";
import { Badge, Button, Empty, ErrorNote, Field, Panel, Stat, inputClass } from "../components/primitives";
import { statusTone, useStudio } from "../store";
import type { AgentLogLine, AgentSummary } from "../types";

/**
 * Agents: what is running, and what it cost.
 *
 * This is the view the rest of the dashboard hangs off. A trace belongs to an
 * agent, so "which agent was that" has to be answerable before the question "how
 * many traces were there" — otherwise every other number on the page is an
 * average over things you cannot tell apart.
 *
 * Live by way of the store's stream rather than a timer, so the list is current
 * when a turn finishes rather than up to ten seconds after.
 */
export const AgentsView = ({ onOpenTraces }: { onOpenTraces: (agentId: string | null) => void }) => {
  const { agents, selectedAgentId, setSelectedAgentId, info, agentVersion, connected } = useStudio();
  const [logs, setLogs] = useState<AgentLogLine[]>([]);
  const [launchError, setLaunchError] = useState<string | null>(null);

  const selected = agents.find((agent) => agent.id === selectedAgentId) ?? null;
  // The id, not the row: the row is a new object on every event the stream sends,
  // so depending on it would refetch the log constantly and still say nothing new.
  const selectedId = selected?.id ?? null;

  useEffect(() => {
    if (!selectedId) {
      setLogs([]);
      return;
    }
    let cancelled = false;
    void api
      .agentLogs(selectedId)
      .then((next) => {
        if (!cancelled) setLogs(next);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [selectedId, agentVersion]);

  const totals = agents.reduce(
    (sum, agent) => ({
      traces: sum.traces + agent.traces,
      errors: sum.errors + agent.errors,
      costUsd: sum.costUsd + agent.costUsd,
      inputTokens: sum.inputTokens + agent.inputTokens,
      outputTokens: sum.outputTokens + agent.outputTokens,
    }),
    { traces: 0, errors: 0, costUsd: 0, inputTokens: 0, outputTokens: 0 },
  );
  const live = agents.filter((agent) => agent.status === "running" || agent.status === "starting").length;
  const errorRate = totals.traces === 0 ? 0 : totals.errors / totals.traces;

  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
        <Stat label="agents" value={String(agents.length)} detail={`${live} running now`} />
        <Stat label="traces" value={totals.traces.toLocaleString()} detail="across every agent" />
        <Stat
          label="error rate"
          value={percent(errorRate, 1)}
          tone={errorRate > 0.05 ? "danger" : errorRate > 0 ? "warn" : "default"}
          detail={`${totals.errors} failed runs`}
        />
        <Stat label="spend" value={usd(totals.costUsd)} detail="all agents, all time" />
        <Stat
          label="tokens"
          value={(totals.inputTokens + totals.outputTokens).toLocaleString()}
          detail={`${totals.outputTokens.toLocaleString()} out`}
        />
      </div>

      <LaunchPanel onError={setLaunchError} error={launchError} />

      <Panel
        title="agents"
        action={
          <div className="flex items-center gap-2">
            {selected && (
              <Button
                variant="ghost"
                onClick={() => {
                  setSelectedAgentId(null);
                  onOpenTraces(null);
                }}
              >
                clear scope
              </Button>
            )}
            <span className="eyebrow">{connected ? "live" : "polling"}</span>
          </div>
        }
      >
        {agents.length === 0 ? (
          <Empty
            title="No agents yet"
            hint="Start one above, or run nah in another terminal — a session that finds this Studio reports to it by itself."
          />
        ) : (
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
                  <th className="eyebrow px-3 py-2 font-normal" />
                </tr>
              </thead>
              <tbody>
                {agents.map((agent) => (
                  <AgentRow
                    key={agent.id}
                    agent={agent}
                    selected={agent.id === selectedAgentId}
                    onSelect={() => {
                      setSelectedAgentId(agent.id);
                      onOpenTraces(agent.id);
                    }}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      {selected && <AgentLogs agent={selected} logs={logs} onCleared={() => setLogs([])} />}
    </div>
  );
};

const AgentRow = ({
  agent,
  selected,
  onSelect,
}: {
  agent: AgentSummary;
  selected: boolean;
  onSelect: () => void;
}) => {
  const { setSelectedAgentId, agents } = useStudio();
  const tone = statusTone(agent.status);
  const [busy, setBusy] = useState(false);

  const stop = useCallback(async () => {
    setBusy(true);
    try {
      // The server refuses to stop an agent it did not start, or one on another
      // host; its answer is the reason this button can exist at all.
      await api.stopAgent(agent.id);
    } catch {
      /* surfaced by the agent row going to failed/stopped on the stream */
    } finally {
      setBusy(false);
    }
  }, [agent.id]);

  return (
    <tr className={`border-b border-white/[0.04] transition hover:bg-white/[0.03] ${selected ? "bg-white/[0.04]" : ""}`}>
      <td className="px-4 py-2.5">
        <button type="button" onClick={onSelect} className="text-left">
          <span className="flex items-center gap-2 text-zinc-100">
            <span className={`size-1.5 shrink-0 rounded-full ${tone.dot}`} aria-hidden />
            {agent.name}
          </span>
          <span className="mt-0.5 block truncate font-mono text-[10px] text-zinc-600" title={agent.cwd}>
            {agent.cwd}
          </span>
        </button>
      </td>
      <td className="px-3 py-2.5">
        <div className="flex items-center gap-1.5">
          <Badge tone={tone.badge}>{tone.label}</Badge>
          {agent.source === "launch" && <span className="eyebrow text-zinc-600">launched</span>}
        </div>
        {agent.model && <span className="mt-1 block truncate font-mono text-[10px] text-zinc-600">{agent.model}</span>}
      </td>
      <td className="num px-3 py-2.5 text-right text-zinc-300">{agent.traces.toLocaleString()}</td>
      <td className={`num px-3 py-2.5 text-right ${agent.errors > 0 ? "text-rose-300" : "text-zinc-600"}`}>
        {agent.errors.toLocaleString()}
      </td>
      <td className="num px-3 py-2.5 text-right text-zinc-400">{duration(agent.medianDurationMs)}</td>
      <td className="num px-3 py-2.5 text-right text-zinc-400">{usd(agent.costUsd)}</td>
      <td className="px-3 py-2.5 text-right text-zinc-500">{relativeTime(agent.lastSeenAt)}</td>
      <td className="px-3 py-2.5 text-right">
        <div className="flex justify-end gap-1">
          {agent.source === "launch" && agent.status === "running" && (
            <Button onClick={() => void stop()} disabled={busy} variant="ghost">
              stop
            </Button>
          )}
          <Button
            onClick={() => {
              // Removing only tidies the list. Its traces stay, because the record
              // of what it did is the reason the dashboard exists.
              void api.removeAgent(agent.id);
              if (agents.length <= 1) setSelectedAgentId(null);
            }}
            variant="ghost"
            title="Remove from this list (its traces are kept)"
          >
            remove
          </Button>
        </div>
      </td>
    </tr>
  );
};

const LaunchPanel = ({
  onError,
  error,
}: {
  onError: (message: string | null) => void;
  error: string | null;
}) => {
  const { info, agents } = useStudio();
  const [name, setName] = useState("");
  const [cwd, setCwd] = useState("");
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (info?.cwd) setCwd((current) => current || info.cwd);
  }, [info?.cwd]);

  const submit = useCallback(async () => {
    if (!prompt.trim() || !cwd.trim()) return;
    setBusy(true);
    onError(null);
    try {
      const result = await api.launchAgent({
        cwd: cwd.trim(),
        ...(name.trim() ? { name: name.trim() } : {}),
        prompt: prompt.trim(),
      });
      if (result.error) onError(result.error);
      else setPrompt("");
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }, [cwd, name, prompt, onError]);

  const available = info?.launcher.available ?? false;

  return (
    <Panel
      title="start an agent"
      action={
        available ? (
          <span className="eyebrow text-zinc-600">{info?.launcher.command}</span>
        ) : (
          <Badge tone="warn">no nah binary found</Badge>
        )
      }
    >
      {!available ? (
        <p className="text-xs text-zinc-500">
          This Studio could not find a <code className="font-mono">nah</code> to start, so it can only watch the agents you start
          yourself. Run <code className="font-mono">nah</code> in a terminal and it will appear here.
        </p>
      ) : (
        <div className="flex flex-col gap-3">
          <div className="grid gap-3 md:grid-cols-2">
            <Field label="directory" hint="Where the agent works. Its tools are confined to this repository.">
              <input value={cwd} onChange={(event) => setCwd(event.target.value)} className={inputClass} spellCheck={false} />
            </Field>
            <Field label="name" hint="Optional. Defaults to the directory's name.">
              <input
                value={name}
                onChange={(event) => setName(event.target.value)}
                className={inputClass}
                placeholder="reviewer"
              />
            </Field>
          </div>
          <Field label="task" hint="One prompt, one run. The agent registers itself and pushes its traces like any other.">
            <textarea
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              rows={3}
              className={`${inputClass} resize-y font-mono`}
              placeholder="Run the test suite and report which failures are new."
            />
          </Field>
          {error && <ErrorNote error={error} />}
          <div className="flex justify-end">
            <Button onClick={() => void submit()} disabled={busy || !prompt.trim() || !cwd.trim()} variant="primary">
              {busy ? "starting…" : "start"}
            </Button>
          </div>
          {agents.some((agent) => agent.status === "starting") && (
            <p className="text-[11px] text-zinc-600">Starting. The row appears the moment the process exists.</p>
          )}
        </div>
      )}
    </Panel>
  );
};

const AgentLogs = ({
  agent,
  logs,
  onCleared,
}: {
  agent: AgentSummary;
  logs: AgentLogLine[];
  onCleared: () => void;
}) => {
  const { setSelectedAgentId } = useStudio();
  return (
    <Panel
      title={`output · ${agent.name}`}
      action={
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            onClick={() => {
              setSelectedAgentId(null);
              onCleared();
            }}
          >
            close
          </Button>
        </div>
      }
      bodyClassName="p-0"
    >
      {logs.length === 0 ? (
        <Empty title="No output yet" hint="A launched agent prints here as it runs, one JSON event per line." />
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
  );
};
