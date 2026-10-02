import { useEffect, useMemo, useState, type ReactNode } from "react";

import { duration, prettyJson, toneClass, scoreTone, attributeLabel, attributeValue } from "../lib/format";
import { Badge, StatusDot, inputClass } from "./primitives";
import type { Span, Trace } from "../types";

/**
 * The trace-detail furniture: waterfall, span inspector, JSON viewer.
 *
 * These three are the reason the UI exists, so they get the attention. The
 * waterfall answers "where did the time go", the inspector answers "what was in
 * that call", and the JSON viewer is there for when the summary is not enough.
 */

/**
 * The waterfall.
 *
 * Bar position is absolute time, not duration-scaled: a step that took 4s of a 7s
 * run and a step that took 400ms should look like that, and a layout that packed
 * each span to fill its row would hide exactly the difference you opened this to
 * find.
 */
export const Waterfall = ({
  spans,
  onSelect,
  selectedId,
}: {
  spans: Span[];
  onSelect: (span: Span) => void;
  selectedId?: string;
}) => {
  const bounds = useMemo(() => {
    const starts = spans.map((span) => span.startTime);
    const ends = spans.map((span) => span.endTime ?? span.startTime);
    const start = Math.min(...starts);
    // A run whose root never closed would otherwise divide by zero here.
    const end = Math.max(...ends, start + 1);
    return { start, total: Math.max(1, end - start) };
  }, [spans]);

  const depth = (span: Span): number => {
    let level = 0;
    let parent = span.parentId;
    while (parent) {
      const found = spans.find((candidate) => candidate.id === parent);
      if (!found) break;
      level += 1;
      parent = found.parentId;
    }
    return level;
  };

  const barTone = (span: Span): string => {
    if (span.status === "error") return "bg-rose-400/70 border-rose-400";
    switch (span.kind) {
      case "tool":
        return "bg-emerald-400/45 border-emerald-400/60";
      case "model":
        return "bg-amber-300/35 border-amber-300/55";
      case "compaction":
        return "bg-sky-400/35 border-sky-400/55";
      default:
        return "bg-violet-300/50 border-violet-300/70";
    }
  };

  return (
    <div className="divide-y divide-white/[0.04]">
      {spans.map((span) => {
        const offset = ((span.startTime - bounds.start) / bounds.total) * 100;
        const width = (((span.endTime ?? span.startTime) - span.startTime) / bounds.total) * 100;
        const level = depth(span);
        return (
          <button
            key={span.id}
            type="button"
            onClick={() => onSelect(span)}
            title={`${span.name} · ${duration((span.endTime ?? span.startTime) - span.startTime)}`}
            className={`grid w-full grid-cols-[minmax(0,15rem)_1fr_5rem] items-center gap-3 px-4 py-1.5 text-left transition hover:bg-white/[0.03] ${
              selectedId === span.id ? "bg-violet-300/[0.07]" : ""
            }`}
          >
            <span className="flex min-w-0 items-center gap-2" style={{ paddingLeft: `${level * 12}px` }}>
              <StatusDot status={span.status} />
              <span className="truncate font-mono text-[11px] text-zinc-300">{span.name}</span>
              <span className="eyebrow shrink-0">{span.kind}</span>
            </span>
            <span className="relative h-4">
              <span
                className={`absolute top-0.5 h-3 rounded-[3px] border ${barTone(span)}`}
                style={{ left: `${offset}%`, width: `${Math.max(0.4, width)}%` }}
              />
            </span>
            <span className="num text-right text-[11px] text-zinc-600">
              {duration((span.endTime ?? span.startTime) - span.startTime)}
            </span>
          </button>
        );
      })}
    </div>
  );
};

/** A JSON block with copy, and no 400-line wall of unstyled text. */
export const JsonViewer = ({ value, label }: { value: unknown; label?: string }) => {
  const text = useMemo(() => prettyJson(value), [value]);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1400);
    return () => clearTimeout(timer);
  }, [copied]);

  if (text === "") return null;

  return (
    <div className="flex flex-col">
      <div className="flex items-center justify-between border-b border-white/[0.06] px-3 py-1.5">
        <span className="eyebrow">{label ?? "payload"}</span>
        <button
          type="button"
          onClick={() => {
            void navigator.clipboard?.writeText(text);
            setCopied(true);
          }}
          className="eyebrow transition hover:text-violet-200"
        >
          {copied ? "copied" : "copy"}
        </button>
      </div>
      <pre className="num max-h-96 overflow-auto px-3 py-2.5 font-mono text-[11px] leading-relaxed whitespace-pre-wrap text-zinc-400">
        {text}
      </pre>
    </div>
  );
};

/** The span inspector: attributes, payloads, and the error if there was one. */
export const SpanInspector = ({ span }: { span: Span }) => {
  const attributes = Object.entries(span.attributes).filter(([, value]) => value !== null && value !== undefined);
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium text-zinc-100">{span.name}</span>
        <Badge tone={span.status === "error" ? "danger" : span.status === "ok" ? "good" : "neutral"}>{span.kind}</Badge>
        <Badge
          tone="neutral"
          title="Wall-clock duration of this span"
        >{duration((span.endTime ?? span.startTime) - span.startTime)}</Badge>
      </div>

      {span.error && (
        <div className="rounded-lg border border-rose-400/25 bg-rose-400/[0.06] p-3">
          <p className="eyebrow text-rose-300/80">{span.error.name}</p>
          <p className="mt-1.5 text-xs leading-5 text-rose-100/90">{span.error.message}</p>
          {span.error.stack && (
            <pre className="num mt-2 max-h-48 overflow-auto font-mono text-[10px] leading-4 whitespace-pre-wrap text-rose-200/60">
              {span.error.stack}
            </pre>
          )}
        </div>
      )}

      {attributes.length > 0 && (
        <dl className="grid grid-cols-[minmax(0,14rem)_1fr] gap-x-4 gap-y-1.5">
          {attributes.map(([key, value]) => (
            <div key={key} className="contents">
              <dt className="num truncate font-mono text-[11px] text-zinc-600" title={key}>
                {attributeLabel(key)}
              </dt>
              <dd className="num font-mono text-[11px] text-zinc-300">
                {attributeValue(key, value as string | number | boolean | null)}
              </dd>
            </div>
          ))}
        </dl>
      )}

      <div className="grid gap-3 lg:grid-cols-2">
        {span.input !== undefined && (
          <div className="panel-flat overflow-hidden">
            <JsonViewer value={span.input} label="input" />
          </div>
        )}
        {span.output !== undefined && (
          <div className="panel-flat overflow-hidden">
            <JsonViewer value={span.output} label="output" />
          </div>
        )}
      </div>
    </div>
  );
};

/** The trace header: the figures you open a trace to check. */
export const TraceSummary = ({ trace }: { trace: Trace }) => {
  const cells: Array<[string, ReactNode]> = [
    ["Status", <Badge key="s" tone={trace.status === "error" ? "danger" : "good"}>{trace.status}</Badge>],
    ["Cost", <span key="c">{trace.costUsd === undefined ? "—" : `$${trace.costUsd.toFixed(4)}`}</span>],
    ["Input tokens", <span key="i">{trace.inputTokens?.toLocaleString() ?? "—"}</span>],
    ["Output tokens", <span key="o">{trace.outputTokens?.toLocaleString() ?? "—"}</span>],
    ["Duration", <span key="d">{(trace.endTime ?? trace.startTime) - trace.startTime} ms</span>],
  ];
  return (
    <dl className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-5">
      {cells.map(([label, value]) => (
        <div key={label}>
          <dt className="eyebrow">{label}</dt>
          <dd className="num mt-1 font-mono text-xs text-zinc-200">{value}</dd>
        </div>
      ))}
    </dl>
  );
};

/** A sortable column header. Clicking twice reverses; the third click resets. */
export const SortHeader = <T,>({
  label,
  field,
  sort,
  order,
  onChange,
  align = "left",
}: {
  label: string;
  field: T;
  sort: T;
  order: "asc" | "desc";
  onChange: (field: T) => void;
  align?: "left" | "right";
}) => {
  const active = sort === field;
  return (
    <th scope="col" className={`px-3 py-2 ${align === "right" ? "text-right" : "text-left"}`}>
      <button
        type="button"
        onClick={() => onChange(field)}
        className={`eyebrow inline-flex items-center gap-1 transition hover:text-zinc-200 ${active ? "text-violet-200" : ""}`}
      >
        {label}
        <span className={active ? "opacity-100" : "opacity-0"}>{order === "asc" ? "↑" : "↓"}</span>
      </button>
    </th>
  );
};

export const SearchInput = ({
  value,
  onChange,
  placeholder,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
}) => (
  <input
    value={value}
    onChange={(event) => onChange(event.target.value)}
    placeholder={placeholder}
    className={inputClass}
    aria-label={placeholder ?? "Search"}
  />
);

/** Score cell: colour, number, and the reason on hover. */
export const ScoreCell = ({ score, reason, skipped }: { score: number; reason?: string; skipped?: boolean }) => (
  <span
    title={reason ?? (skipped ? "skipped" : undefined)}
    className={`num font-mono text-xs ${skipped ? "text-zinc-600 italic" : toneClass(scoreTone(skipped ? null : score))}`}
  >
    {skipped ? "skipped" : score.toFixed(2)}
  </span>
);