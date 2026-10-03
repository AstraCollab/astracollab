/**
 * Notice when a search repeats one this run already answered.
 *
 * The step-scoped de-duplication in `dedupe.ts` only collapses two identical
 * calls emitted in the *same* step. The waste it misses is the same search run
 * again several steps later, and searches overlapping enough to be the same
 * search asked in different words. Both are common on an unfamiliar codebase:
 * the pattern is that the agent greps `<button`, then `inline-flex`, then `btn-`
 * and gets nearly the same file list back three times, paying for a step and the
 * whole result each time, on a transcript that re-sends itself every step after.
 *
 * It is also a symptom worth naming out loud. Three greps for one question means
 * the agent is searching without deciding what it is looking for, and the
 * redundancy notice is the only place that gets said.
 *
 * Results are dropped on any mutation, for the same reason the read cache is: a
 * stale "already searched" is far worse than a duplicate search.
 */

/** Fraction of one search's files that must reappear for it to count as the same. */
const OVERLAP_THRESHOLD = 0.8;

/**
 * Below this many files, two searches look alike by coincidence. Three greps
 * over one or two files is just reading them.
 */
const MIN_FILES = 3;

/** Bounds memory on a long run; the oldest searches are the least relevant. */
const MAX_RECORDS = 24;

export type SearchRecord = {
	pattern: string;
	files: string[];
};

export type SearchLedger = {
	/**
	 * Record a completed search and return a notice about earlier ones it
	 * duplicates, or null when this one is new.
	 */
	note(
		pattern: string,
		scope: string | undefined,
		files: string[],
	): string | null;
	/** Forget every search. Called on anything that can change a file. */
	clear(): void;
	/** Searches flagged as repeats of an earlier one. */
	readonly repeats: number;
};

/** Two searches in the same scope, scored by how much of the earlier set returns. */
const overlap = (earlier: string[], files: string[]): number => {
	if (earlier.length === 0) return 0;
	const found = new Set(files);
	let hits = 0;
	for (const file of earlier) {
		if (found.has(file)) hits += 1;
	}
	return hits / earlier.length;
};

export const createSearchLedger = (): SearchLedger => {
	let records: SearchRecord[] = [];
	let repeats = 0;

	return {
		note(pattern, scope, files) {
			const distinct = [...new Set(files)];
			let notice: string | null = null;

			for (const record of records) {
				if (record.pattern === pattern) {
					repeats += 1;
					notice = `[already searched] "${pattern}" returned these ${record.files.length} file(s) earlier in this run and nothing has changed since. Read one of them instead of searching again.`;
					break;
				}
				const shared = overlap(record.files, distinct);
				if (shared < OVERLAP_THRESHOLD) continue;
				// Two searches landing on the same one or two files is not a pattern,
				// it is just reading them. Below this, "similar" is coincidence.
				if (Math.min(record.files.length, distinct.length) < MIN_FILES)
					continue;
				repeats += 1;
				notice =
					`[redundant search] ${Math.round(shared * 100)}% of these files were already returned by "${record.pattern}"` +
					`${scope ? ` (same scope: ${scope})` : ""}. Search once, read the files, and move on to the edit.`;
				break;
			}

			records.push({ pattern, files: distinct });
			if (records.length > MAX_RECORDS) {
				records = records.slice(-MAX_RECORDS);
			}
			return notice;
		},
		clear() {
			records = [];
		},
		get repeats() {
			return repeats;
		},
	};
};

/**
 * Track whether anything has changed a file, so a caller can offer the nudge.
 *
 * Separate from the ledger because it answers a different question: not "was
 * this search redundant" but "has this run written anything at all". A run that
 * has spent a dozen steps without touching a file is not searching, it is
 * circling, and that is worth saying once.
 */
export type MutationLedger = {
	/** Record a tool call; returns true when it was a mutation. */
	note(toolName: string): boolean;
	/** How many mutating calls this run has made. */
	readonly mutations: number;
};

/**
 * Shell counts. Not every bash call writes, but a run that has shelled out has
 * usually built, tested, or inspected something, and either way it is doing
 * rather than reading — which is the distinction the nudge turns on.
 */
const MUTATING = new Set([
	"edit",
	"write",
	"bash",
	"multi_edit",
	"notebook_edit",
	"apply_patch",
]);

export const createMutationLedger = (): MutationLedger => {
	let mutations = 0;
	return {
		note(toolName) {
			if (!MUTATING.has(toolName)) return false;
			mutations += 1;
			return true;
		},
		get mutations() {
			return mutations;
		},
	};
};
