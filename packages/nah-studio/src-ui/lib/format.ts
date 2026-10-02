/** Formatting. Every number in the UI goes through here so they agree. */

export const duration = (ms: number | null | undefined): string => {
  if (ms === null || ms === undefined) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `${minutes}m ${seconds}s`;
};

export const usd = (value: number | null | undefined): string => {
  if (value === null || value === undefined) return "—";
  // Sub-cent figures are the normal case here, and "$0.0000" reads as missing.
  if (value === 0) return "$0";
  if (value < 0.0001) return "<$0.0001";
  if (value < 1) return `$${value.toFixed(4)}`;
  return `$${value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
};

export const tokens = (value: number | null | undefined): string => {
  if (value === null || value === undefined) return "—";
  if (value < 1000) return String(value);
  if (value < 1_000_000) return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)}k`;
  return `${(value / 1_000_000).toFixed(1)}M`;
};

export const percent = (value: number | null | undefined, digits = 0): string =>
  value === null || value === undefined ? "—" : `${(value * 100).toFixed(digits)}%`;

const RELATIVE: Array<[number, Intl.RelativeTimeFormatUnit]> = [
  [60, "second"],
  [3600, "minute"],
  [86_400, "hour"],
  [604_800, "day"],
  [2_629_800, "week"],
  [31_557_600, "month"],
];

const relativeFormatter = new Intl.RelativeTimeFormat("en", { numeric: "auto" });

export const relativeTime = (epochMs: number): string => {
  const seconds = (epochMs - Date.now()) / 1000;
  const absolute = Math.abs(seconds);
  if (absolute < 5) return "just now";
  let chosen: [number, Intl.RelativeTimeFormatUnit] = RELATIVE[0]!;
  for (const unit of RELATIVE) {
    if (absolute >= unit[0]) chosen = unit;
  }
  return relativeFormatter.format(Math.round(seconds / chosen[0]), chosen[1]);
};

export const timestamp = (epochMs: number): string =>
  new Date(epochMs).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });

export const scoreLabel = (score: number | null | undefined): string =>
  score === null || score === undefined ? "—" : score.toFixed(2);

/** The three bands every score in the UI is coloured by. */
export const scoreTone = (score: number | null | undefined): "high" | "mid" | "low" | "none" => {
  if (score === null || score === undefined) return "none";
  if (score >= 0.75) return "high";
  if (score >= 0.5) return "mid";
  return "low";
};

export const toneClass = (tone: "high" | "mid" | "low" | "none"): string => {
  switch (tone) {
    case "high":
      return "text-emerald-300";
    case "mid":
      return "text-amber-300";
    case "low":
      return "text-rose-300";
    case "none":
      return "text-zinc-600";
  }
};

export const compactNumber = (value: number): string =>
  value.toLocaleString("en-US", { notation: value >= 10_000 ? "compact" : "standard", maximumFractionDigits: 1 });

export const truncate = (value: string, max: number): string =>
  value.length <= max ? value : `${value.slice(0, max - 1)}…`;

export const attributeLabel = (key: string): string =>
  key
    .replace(/^gen_ai\.usage\./, "")
    .replace(/^nah\./, "")
    .replace(/[._]/g, " ")
    .replace(/\b\w/g, (character) => character.toUpperCase());

export const attributeValue = (key: string, value: string | number | boolean | null): string => {
  if (value === null) return "unbounded";
  if (key.includes("usd")) return usd(Number(value));
  if (typeof value === "boolean") return value ? "yes" : "no";
  if (typeof value === "number") {
    if (key.includes("rate") || key.includes("fraction")) return percent(Number(value), 1);
    if (key.includes("tokens")) return tokens(Number(value));
    return value.toLocaleString("en-US");
  }
  return String(value);
};

/** Safe JSON for a viewer: a string that is already JSON gets pretty-printed. */
export const prettyJson = (value: unknown): string => {
  if (value === undefined) return "";
  if (typeof value === "string") {
    try {
      return JSON.stringify(JSON.parse(value), null, 2);
    } catch {
      return value;
    }
  }
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
};