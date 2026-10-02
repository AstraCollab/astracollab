import { useCallback, useEffect, useState } from "react";

import { api } from "./api";
import { AgentsView } from "./views/Agents";
import { OverviewView } from "./views/Overview";
import { TracesView } from "./views/Traces";
import { ChatView, EvaluationsView, ToolsView } from "./views/Evaluations";
import { Badge, Button } from "./components/primitives";
import { statusTone, useStudio } from "./store";

/**
 * The shell: the same chrome as the docs site — grid field, violet glow in the
 * corner, mono eyebrows, hairlines — so this reads as part of the product rather
 * than as a tool bolted onto it.
 */

type View = "agents" | "overview" | "traces" | "tools" | "evaluations" | "chat";

const NAV: Array<{ id: View; label: string; hint: string }> = [
  { id: "agents", label: "agents", hint: "who is running, and what it cost" },
  { id: "overview", label: "overview", hint: "volume, errors, spend, latency" },
  { id: "traces", label: "traces", hint: "every run, with a span waterfall" },
  { id: "tools", label: "tools", hint: "per-tool latency and failures" },
  { id: "evaluations", label: "evaluations", hint: "datasets, scorers, experiments" },
  { id: "chat", label: "chat", hint: "ask the read-only agent" },
];

const App = () => {
  const { connected, info, agents, selectedAgentId, selectedAgent, setSelectedAgentId } = useStudio();
  const [view, setView] = useState<View>("agents");
  // A trace opened from elsewhere — a chat turn, an eval row — lands here and is
  // opened by the traces view when it sees the id change.
  const [focusTrace, setFocusTrace] = useState<string | null>(null);

  // Digits, so ⌘1..⌘6 moves between views without reaching for the mouse.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey)) return;
      const index = Number(event.key) - 1;
      if (Number.isInteger(index) && NAV[index]) {
        event.preventDefault();
        setView(NAV[index]!.id);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const openTracesFor = useCallback((agentId: string | null) => {
    setSelectedAgentId(agentId);
    setView("traces");
  }, [setSelectedAgentId]);

  const live = agents.filter((agent) => agent.status === "running" || agent.status === "starting").length;

  return (
    <div className="relative min-h-screen">
      {/* The docs page's backdrop, at the docs page's opacity. */}
      <div className="grid-field pointer-events-none fixed inset-0 -z-10" />
      <div className="pointer-events-none fixed -top-48 -right-40 -z-10 size-[42rem] rounded-full bg-violet-500/[0.09] blur-[130px]" />

      <div className="grid min-h-screen grid-cols-1 lg:grid-cols-[228px_minmax(0,1fr)]">
        <aside className="flex flex-col gap-6 border-b border-white/[0.08] px-4 py-5 lg:sticky lg:top-0 lg:h-screen lg:border-r lg:border-b-0 lg:px-5 lg:py-6">
          <div>
            <a href="./" className="flex items-center gap-2.5 text-sm font-semibold tracking-tight text-zinc-100">
              <span className="grid size-7 place-items-center rounded-lg border border-white/10 bg-white/[0.06] font-mono text-xs">n.</span>
              nah
              <span className="text-zinc-600">studio</span>
            </a>
            <p className="mt-2 text-[11px] leading-4 text-zinc-600">
              Every agent on this machine, its traces and what they cost.
            </p>
          </div>

          <nav className="flex gap-1 overflow-x-auto lg:flex-col" aria-label="Views">
            {NAV.map((item, index) => (
              <button
                key={item.id}
                type="button"
                onClick={() => setView(item.id)}
                aria-current={view === item.id ? "page" : undefined}
                className={`group shrink-0 rounded-lg px-2.5 py-2 text-left transition ${
                  view === item.id ? "bg-white/[0.07] text-white" : "text-zinc-500 hover:bg-white/[0.04] hover:text-zinc-200"
                }`}
              >
                <span className="flex items-baseline gap-2">
                  <span className="text-xs">{item.label}</span>
                  <span className="eyebrow opacity-0 transition group-hover:opacity-100">⌘{index + 1}</span>
                </span>
                <span className="hidden text-[10px] leading-4 text-zinc-600 lg:block">{item.hint}</span>
              </button>
            ))}
          </nav>

          <div className="mt-auto hidden flex-col gap-2 lg:flex">
            <div className="flex items-center gap-2">
              <span className={`size-1.5 rounded-full ${connected ? "bg-emerald-400" : "bg-amber-400"}`} />
              <span className="eyebrow">{connected ? "live" : "reconnecting"}</span>
            </div>
            <div className="flex items-center gap-2">
              <span className={`size-1.5 rounded-full ${live > 0 ? "bg-emerald-400" : "bg-zinc-600"}`} />
              <span className="eyebrow">
                {live} running · {agents.length} known
              </span>
            </div>
            {info && <span className="eyebrow truncate text-zinc-700" title={info.cwd}>v{info.version}</span>}
          </div>
        </aside>

        <main className="min-w-0 px-4 py-6 sm:px-8 lg:px-10 lg:py-8">
          <header className="mb-6 flex flex-wrap items-end justify-between gap-3 border-b border-white/[0.08] pb-4">
            <div>
              <p className="eyebrow">{NAV.find((item) => item.id === view)?.label}</p>
              <h1 className="mt-1.5 text-xl font-medium tracking-tight text-zinc-100">
                {view === "agents" && "Every agent, and what it is doing"}
                {view === "overview" && "How the work is going"}
                {view === "traces" && "Every run, in detail"}
                {view === "tools" && "What the tools are doing"}
                {view === "evaluations" && "Datasets and scorers"}
                {view === "chat" && "Ask the read-only agent"}
              </h1>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <AgentScope />
              <Badge tone="neutral">read-only chat agent</Badge>
              {info?.launcher.available === false && <Badge tone="warn">cannot launch agents</Badge>}
            </div>
          </header>

          {selectedAgent && (
            <div className="mb-4 flex flex-wrap items-center gap-2 rounded-xl border border-violet-300/20 bg-violet-300/[0.05] px-4 py-2.5">
              <span className={`size-1.5 rounded-full ${statusTone(selectedAgent.status).dot}`} aria-hidden />
              <span className="text-xs text-zinc-200">scoped to {selectedAgent.name}</span>
              <span className="truncate font-mono text-[10px] text-zinc-600">{selectedAgent.cwd}</span>
              <Button variant="ghost" onClick={() => setSelectedAgentId(null)} className="ml-auto">
                show every agent
              </Button>
            </div>
          )}

          {view === "agents" && <AgentsView onOpenTraces={openTracesFor} />}
          {view === "overview" && <OverviewView onOpenTraces={() => setView("traces")} />}
          {view === "traces" && <TracesView focusTrace={focusTrace} onFocusHandled={() => setFocusTrace(null)} />}
          {view === "tools" && <ToolsView />}
          {view === "evaluations" && <EvaluationsView />}
          {view === "chat" && (
            <ChatView
              onOpenTrace={(traceId) => {
                setFocusTrace(traceId);
                setView("traces");
              }}
            />
          )}
        </main>
      </div>
    </div>
  );
};

/**
 * The agent scope, in the header.
 *
 * On every view rather than only the agents list, because the number you are
 * reading is the number for whatever this says — and a filter that only exists on
 * the screen you set it from is a filter you forget about.
 */
const AgentScope = () => {
  const { agents, selectedAgentId, setSelectedAgentId } = useStudio();
  if (agents.length === 0) return null;
  return (
    <label className="flex items-center gap-1.5">
      <span className="eyebrow text-zinc-600">agent</span>
      <select
        value={selectedAgentId ?? ""}
        onChange={(event) => setSelectedAgentId(event.target.value === "" ? null : event.target.value)}
        className="rounded-lg border border-white/[0.08] bg-black/40 px-2 py-1 font-mono text-[11px] text-zinc-300 focus:border-violet-300/40 focus:outline-none"
        aria-label="Scope every view to one agent"
      >
        <option value="">all ({agents.length})</option>
        {agents.map((agent) => (
          <option key={agent.id} value={agent.id}>
            {agent.name} · {statusTone(agent.status).label}
          </option>
        ))}
      </select>
    </label>
  );
};

export default App;