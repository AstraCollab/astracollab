/**
 * Hard output caps for tool results.
 *
 * Every model step replays the transcript, so a large result is paid for again on
 * every later step. But a cap is only a saving if the agent does not go and
 * recover what was cut.
 *
 * `read` is truncated aggressively: when it does cut, the fix is paging with
 * `offset`/`limit`, which fetches *different* lines, so the truncated bytes are
 * never re-requested.
 *
 * `bash` is deliberately left roomy. Its truncation notice tells the agent to
 * re-run the command with `| tail -n N`, which pays for the same output twice.
 * A live audit run cut at 120 lines did exactly that and cost more than the
 * original. An agent doing real investigation needs whole command output.
 */
export const DEFAULT_CAPS = {
  read: { maxLines: 250, maxChars: 20_000 },
  list: { maxLines: 350, maxChars: 14_000 },
  bash: { maxLines: 400, maxChars: 40_000 },
  grep: { maxMatches: 60, maxPerFile: 30, lineMaxChars: 200 },
  glob: { maxMatches: 200 },
} as const;

export type OutputCaps = typeof DEFAULT_CAPS;

/**
 * Split text into lines, ignoring the empty trailing element produced by a
 * final newline.
 *
 * `"a\nb\n".split("\n")` is `["a", "b", ""]` — counting that phantom line made
 * `read` tell the model a five-line file had six lines, which then pushed it to
 * page for a line number that does not exist.
 */
export const toLines = (text: string): string[] => {
  if (text.length === 0) {
    return [];
  }
  const lines = text.split("\n");
  if (lines.length > 1 && lines[lines.length - 1] === "") {
    lines.pop();
  }
  return lines;
};

const countLines = (text: string): number => toLines(text).length;

/** Keep the first maxLines/maxChars with a paging notice. */
export const capHead = (
  text: string,
  maxLines: number,
  maxChars: number,
  hint: string,
): string => {
  const totalLines = countLines(text);
  if (totalLines <= maxLines && text.length <= maxChars) {
    return text;
  }
  let kept = toLines(text).slice(0, maxLines);
  let out = kept.join("\n");
  if (out.length > maxChars) {
    out = out.slice(0, maxChars);
    kept = out.split("\n");
  }
  return `${out}\n\n[output truncated — showing ${kept.length} of ${totalLines} lines. ${hint}]`;
};

/** Keep the last maxLines/maxChars with a notice (errors live at the tail). */
export const capTail = (
  text: string,
  maxLines: number,
  maxChars: number,
  hint: string,
): string => {
  const totalLines = countLines(text);
  if (totalLines <= maxLines && text.length <= maxChars) {
    return text;
  }
  let out = toLines(text).slice(-maxLines).join("\n");
  if (out.length > maxChars) {
    out = out.slice(out.length - maxChars);
  }
  const shown = out.length === 0 ? 0 : out.split("\n").length;
  return `[output truncated — ${totalLines} lines total, showing the last ${shown}. ${hint}]\n\n${out}`;
};

/** Cap a full file body into `offset`/`limit` line windows with 1-based numbers. */
export const sliceFileLines = (
  text: string,
  offset?: number,
  limit?: number,
): { body: string; totalLines: number } => {
  const lines = toLines(text);
  const start = offset !== undefined && offset > 1 ? Math.floor(offset) : 1;
  const cappedLimit = Math.min(limit ?? DEFAULT_CAPS.read.maxLines, DEFAULT_CAPS.read.maxLines);
  const slice = lines.slice(start - 1, start - 1 + cappedLimit);
  return {
    body: slice.map((line, i) => `${start + i}|${line}`).join("\n"),
    totalLines: lines.length,
  };
};
