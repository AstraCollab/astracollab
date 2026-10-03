/**
 * Hard output caps for tool results.
 *
 * Every model step replays the transcript, so a large result is paid for again on
 * every later step. But a cap is only a saving if the agent does not go and
 * recover what the cut removed.
 *
 * `read` is truncated aggressively: when it does cut, the fix is paging with
 * `offset`/`limit`, which fetches *different* lines, so the truncated bytes are
 * never re-requested.
 *
 * `bash` is the hard case, because its output cannot be paged — there is no
 * offset. A cut at 120 lines once caused the agent to re-run the whole command
 * piped to `| tail -n N`, paying for the identical output twice and costing more
 * than the original (noted in an audit run; that is why it used to sit at 40k).
 *
 * So the cap is set where the reference implementation sets it — 30k characters
 * for a successful command — and the failure path is much tighter at 10k, because
 * a failing command is the one whose output nobody needs in full. What changed
 * instead of the cap is the notice: it no longer invites a re-run, because that
 * was the actual mechanism of the regression.
 *
 * `grep` defaults to file paths rather than matching lines, which is worth more
 * than any of these caps on an exploratory workload.
 *
 * `webFetch` is the awkward one, because unlike every other tool here its result
 * cannot be narrowed on a second call — there is no offset into a web page, and
 * re-fetching it is not cheaper than the first fetch. So the notice attached to a
 * cut page must not suggest another fetch, and the cap has to be low enough that
 * being cut is the normal case rather than a rare one. 30k is where a successful
 * shell command sits, on the reasoning that both are "the thing the agent asked
 * for, and it is bigger than expected"; the failure path is far tighter, for the
 * same reason it is for `bash` — a 403 page is context, not the answer.
 */
export const DEFAULT_CAPS = {
	read: { maxLines: 250, maxChars: 20_000 },
	list: { maxLines: 350, maxChars: 14_000 },
	/** Successful command. */
	bash: { maxLines: 400, maxChars: 30_000 },
	/** Non-zero exit. Errors live at the end, so this is a tail. */
	bashFailure: { maxLines: 120, maxChars: 10_000 },
	grep: { maxMatches: 60, maxPerFile: 30, lineMaxChars: 200 },
	glob: { maxMatches: 100 },
	/** A fetched page, converted. */
	webFetch: { maxLines: 400, maxChars: 30_000 },
	/** A fetch that did not return 2xx. */
	webFetchFailure: { maxLines: 80, maxChars: 4_000 },
} as const;

export type OutputCaps = typeof DEFAULT_CAPS;

/**
 * Per-tool cap overrides, partial at the number level.
 *
 * `Partial<OutputCaps>` would force a caller to restate every field of a tool to
 * change one — `{ read: { maxLines: 400 } }` is the override anyone actually
 * wants, and making them look up `maxChars` to go with it is how an override ends
 * up silently loosening the thing it was meant to keep.
 */
export type CapsOverrides = {
	[K in keyof OutputCaps]?: Partial<OutputCaps[K]>;
};

/**
 * Merge overrides over the defaults, per tool.
 *
 * Exported because a caller assembling its own tools — a client with a custom
 * read, say — needs the same numbers the built-in tools get, or it silently
 * loses the caps the harness ships with.
 */
export const resolveCaps = (overrides?: CapsOverrides): OutputCaps => {
	if (!overrides) return DEFAULT_CAPS;
	// A separate mutable type: DEFAULT_CAPS is `as const`, so a spread of it is
	// still readonly and cannot be filled in per tool.
	const merged = { ...DEFAULT_CAPS } as unknown as Record<
		string,
		Record<string, number>
	>;
	for (const [tool, values] of Object.entries(overrides) as Array<
		[string, Record<string, number> | undefined]
	>) {
		if (!values || !merged[tool]) continue;
		merged[tool] = { ...merged[tool], ...values };
	}
	return merged as unknown as OutputCaps;
};

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

/**
 * Cap a full file body into `offset`/`limit` line windows with 1-based numbers.
 *
 * Also returns the window that was actually covered (`start`..`end`), because
 * the caller has to tell the model where to resume and cannot work that out
 * from `totalLines` alone — a read that started at line 180 covers a different
 * range from one that started at line 1.
 */
/**
 * A page of a numbered file.
 *
 * `maxLines` is a parameter rather than the module default so a caller's cap
 * overrides actually apply: clamping here against `DEFAULT_CAPS` meant a run
 * configured with a tighter read cap still printed the default number of lines,
 * which looks like the override being ignored rather than like a bug.
 */
export const sliceFileLines = (
	text: string,
	offset?: number,
	limit?: number,
	maxLines: number = DEFAULT_CAPS.read.maxLines,
): { body: string; totalLines: number; start: number; end: number } => {
	const lines = toLines(text);
	const start = offset !== undefined && offset > 1 ? Math.floor(offset) : 1;
	const cappedLimit = Math.min(limit ?? maxLines, maxLines);
	const slice = lines.slice(start - 1, start - 1 + cappedLimit);
	return {
		body: slice.map((line, i) => `${start + i}|${line}`).join("\n"),
		totalLines: lines.length,
		start,
		// Clamped to the real file: an offset past EOF must not invite a resume
		// point beyond the end.
		end: Math.min(start - 1 + slice.length, lines.length),
	};
};
