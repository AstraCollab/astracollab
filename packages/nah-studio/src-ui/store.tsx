import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

import { api } from "./api";
import { openStream } from "./stream";
import type { Agent, AgentSummary } from "./types";

/**
 * What every view needs to know about the agents on this machine.
 *
 * A context rather than a prop or a store library, because the whole thing is one
 * live list and one selection: the views read it, `App` owns it, and nothing else
 * writes it.
 *
 * The stream is a notification channel, not a data channel. When a trace lands,
 * the version counter moves and the view that shows traces refetches — one shape
 * for every endpoint, no incremental update logic spread across six files, and no
 * second copy of the truth to fall out of sync.
 */

export type StudioState = {
  agents: AgentSummary[];
  /** The agent the other views are scoped to, or null for every agent. */
  selectedAgentId: string | null;
  selectedAgent: AgentSummary | null;
  setSelectedAgentId: (id: string | null) => void;
  /** False until the stream opens; a monitoring dashboard should admit when it is blind. */
  connected: boolean;
  /** Bumped when a trace arrives. Views include it in their fetch dependencies. */
  traceVersion: number;
  /** Bumped when an agent appears, moves, or prints something. */
  agentVersion: number;
  /** What this server is: version, directory, whether it can start agents. */
  info: StudioInfo | null;
};

export type StudioInfo = {
  service: string;
  version: string;
  cwd: string;
  model: string | null;
  /** False when no `nah` binary was found, so the launch form can say so. */
  launcher: { available: boolean; command: string | null };
};

const StudioContext = createContext<StudioState | null>(null);

export const StudioProvider = ({ children }: { children: ReactNode }) => {
  const [agents, setAgents] = useState<AgentSummary[]>([]);
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const [traceVersion, setTraceVersion] = useState(0);
  const [agentVersion, setAgentVersion] = useState(0);
  const [info, setInfo] = useState<StudioInfo | null>(null);

  const upsert = useCallback((next: AgentSummary) => {
    setAgents((current) => {
      const index = current.findIndex((agent) => agent.id === next.id);
      if (index === -1) return [next, ...current];
      const copy = [...current];
      copy[index] = next;
      // Newest activity first, so the agent you are watching is at the top.
      return copy.sort((a, b) => b.lastSeenAt - a.lastSeenAt);
    });
    setAgentVersion((version) => version + 1);
  }, []);

  // The snapshot the stream sends on connect is authoritative; the fetch is the
  // fallback for a server whose stream is blocked by a proxy.
  useEffect(() => {
    let cancelled = false;
    void api
      .agents()
      .then((next) => {
        if (!cancelled) setAgents(next);
      })
      .catch(() => undefined);
    void api
      .info()
      .then((next) => {
        if (!cancelled) setInfo(next);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const close = openStream({
      onOpen: () => setConnected(true),
      onClose: () => setConnected(false),
      onEvent: (event) => {
        switch (event.type) {
          case "hello":
            setAgents(event.agents);
            setAgentVersion((version) => version + 1);
            break;
          case "agent":
            upsert(event.agent);
            break;
          case "trace":
            // The trace itself arrives with the agent id, so the one list that has
            // to be exactly right — which agent did what — is updated directly
            // rather than waited on a refetch.
            setTraceVersion((version) => version + 1);
            break;
          case "log":
            setAgentVersion((version) => version + 1);
            break;
          case "pong":
            break;
        }
      },
    });
    return close;
  }, [upsert]);

  const selectedAgent = useMemo(
    () => agents.find((agent) => agent.id === selectedAgentId) ?? null,
    [agents, selectedAgentId],
  );

  const value = useMemo<StudioState>(
    () => ({
      agents,
      selectedAgentId,
      selectedAgent,
      setSelectedAgentId,
      connected,
      traceVersion,
      agentVersion,
      info,
    }),
    [agents, selectedAgentId, selectedAgent, connected, traceVersion, agentVersion, info],
  );

  return <StudioContext.Provider value={value}>{children}</StudioContext.Provider>;
};

export const useStudio = (): StudioState => {
  const value = useContext(StudioContext);
  if (!value) throw new Error("useStudio must be used inside <StudioProvider>");
  return value;
};

/** The dot's colour, and the word beside it. Colour never carries it alone. */
export const statusTone = (status: Agent["status"]): { dot: string; label: string; badge: "good" | "warn" | "danger" | "neutral" | "accent" } => {
  switch (status) {
    case "running":
      return { dot: "bg-emerald-400", label: "running", badge: "good" };
    case "starting":
      return { dot: "bg-accent", label: "starting", badge: "accent" };
    case "idle":
      return { dot: "bg-amber-400", label: "idle", badge: "warn" };
    case "failed":
      return { dot: "bg-rose-400", label: "failed", badge: "danger" };
    case "stopped":
      return { dot: "bg-zinc-500", label: "stopped", badge: "neutral" };
    case "exited":
      return { dot: "bg-zinc-400", label: "exited", badge: "neutral" };
  }
};