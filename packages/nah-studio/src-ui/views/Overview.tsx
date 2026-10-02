import { useEffect, useState } from "react";

import { api } from "../api";
import { duration, percent, tokens, usd } from "../lib/format";
import { Badge, Button, Empty, ErrorNote, Panel, Stat } from "../components/primitives";
import { useStudio } from "../store";

/**
 * Overview: the numbers a team looks at before anyone opens a trace.
 *
 * Deliberately five figures. A dashboard that answers twelve questions answers
 * none, and the four questions that always come up are: is it running, is it
 * erroring, what does it cost, and is it getting slower.
 */
export const OverviewView = ({ onOpenTraces }: { onOpenTraces: () => void }) => {
  const [overview, setOverview] = useState<Awaited<ReturnType<typeof api.overview>> | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Whatever the header is scoped to, these numbers are. A summary of everything
  // shown next to a filter that says otherwise is how a dashboard starts lying.
  const { selectedAgentId, traceVersion } = useStudio();

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const next = await api.overview(24, selectedAgentId);
        if (!cancelled) {
          setOverview(next);
          setError(null);
        }
      } catch (caught) {
        if (!cancelled) setError(caught instanceof Error ? caught.message : String(caught));
      }
    };
    void load();
    // A slow floor under the live stream rather than the primary mechanism: the
    // stream says when something changed, and this covers the case where it is
    // blocked by a proxy and never says anything.
    const timer = setInterval(() => void load(), 10_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [selectedAgentId, traceVersion]);

  if (error) return <ErrorNote error={error} onRetry={() => window.location.reload()} />;
  if (!overview) return <Empty title="Loading…" />;

  const series = overview.timeseries ?? [];
  const errorRate = overview.traces === 0 ? 0 : overview.errors / overview.traces;
  const cacheTokens = overview.inputTokens;

  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
        <Stat
          label="traces"
          value={overview.traces.toLocaleString()}
          spark={series.map((point) => point.traces)}
          detail="all time"
        />
        <Stat
          label="error rate"
          value={percent(errorRate, 1)}
          tone={errorRate > 0.05 ? "danger" : errorRate > 0 ? "warn" : "default"}
          spark={series.map((point) => point.errors)}
          detail={`${overview.errors} failed runs`}
        />
        <Stat
          label="spend"
          value={usd(overview.costUsd)}
          spark={series.map((point) => point.costUsd)}
          detail="priced at model rates"
        />
        <Stat
          label="median duration"
          value={duration(overview.medianDurationMs)}
          spark={series.map((point) => point.medianMs)}
          detail="per trace"
        />
        <Stat
          label="tokens"
          value={tokens(overview.inputTokens + overview.outputTokens)}
          detail={`${tokens(overview.inputTokens)} in · ${tokens(overview.outputTokens)} out`}
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-[1fr_20rem]">
        <Panel
          title="runs over time"
          bodyClassName="p-0"
          action={
            <Button onClick={onOpenTraces} variant="ghost">
              all traces →
            </Button>
          }
        >
          {series.length < 2 ? (
            <Empty title="Not enough history yet." hint="The chart fills in as runs accumulate." />
          ) : (
            <div className="px-4 py-4">
              <SparklineLarge series={series} />
              <div className="mt-3 flex items-center justify-between font-mono text-[10px] text-zinc-600">
                <span>{new Date(series[0]!.t).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false })}</span>
                <span>{new Date(series[series.length - 1]!.t).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false })}</span>
              </div>
            </div>
          )}
        </Panel>

        <Panel title="this store">
          <dl className="flex flex-col gap-3">
            <div>
              <dt className="eyebrow">location</dt>
              <dd className="num mt-1 font-mono text-[11px] text-zinc-400">~/.nah/studio/studio.sqlite</dd>
            </div>
            <div>
              <dt className="eyebrow">prompt tokens</dt>
              <dd className="num mt-1 font-mono text-xs text-zinc-200">{tokens(cacheTokens)}</dd>
            </div>
            <div>
              <dt className="eyebrow">retention</dt>
              <dd className="mt-1 text-[11px] leading-4 text-zinc-500">
                Unbounded. Prune from the server when it needs to shrink.
              </dd>
            </div>
            <div>
              <dt className="eyebrow">agent mode</dt>
              <dd className="mt-1">
                <Badge tone="good">read-only</Badge>
              </dd>
            </div>
          </dl>
        </Panel>
      </div>
    </div>
  );
};

/** A filled area chart, hand-drawn. One polyline per series, no chart library. */
const SparklineLarge = ({
  series,
}: {
  series: Array<{ t: number; traces: number; errors: number; costUsd: number; medianMs: number }>;
}) => {
  const width = 900;
  const height = 180;
  const max = Math.max(...series.map((point) => point.traces), 1);
  const step = width / Math.max(1, series.length - 1);

  const path = (pick: (point: (typeof series)[number]) => number) => {
    let out = "";
    series.forEach((point, index) => {
      const x = index * step;
      const y = height - (pick(point) / max) * (height - 12) - 6;
      out += `${index === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
    });
    return out;
  };

  const tracesPath = path((point) => point.traces);

  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="h-44 w-full" preserveAspectRatio="none" aria-label="Runs over time">
      <defs>
        <linearGradient id="fill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#a78bfa" stopOpacity={0.28} />
          <stop offset="100%" stopColor="#a78bfa" stopOpacity={0} />
        </linearGradient>
      </defs>
      {[0.25, 0.5, 0.75].map((fraction) => (
        <line key={fraction} x1={0} x2={width} y1={height * fraction} y2={height * fraction} stroke="rgba(255,255,255,0.04)" />
      ))}
      <path d={`${tracesPath} L${width},${height} L0,${height} Z`} fill="url(#fill)" />
      <path d={tracesPath} fill="none" stroke="#a78bfa" strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
      <path
        d={path((point) => point.errors)}
        fill="none"
        stroke="#fb7185"
        strokeWidth={1.25}
        strokeDasharray="3 3"
        vectorEffect="non-scaling-stroke"
        opacity={0.85}
      />
    </svg>
  );
};