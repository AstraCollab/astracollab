/**
 * Searching the web, and turning what comes back into something a model can read.
 *
 * `web_fetch` needs an absolute URL — "if you do not know the exact URL, you
 * cannot use this — there is no search here." This tool is the complement: it
 * takes a query and returns a list of results (title, URL, snippet), so the
 * model can discover pages it does not already know about, then `web_fetch` the
 * ones that look promising.
 *
 * The search backend is injectable: `search` defaults to a DuckDuckGo HTML
 * scrape (no API key), but a host that wants Brave, Serper, Tavily, or Google
 * passes its own function. `fetchImpl` is injected for the same reason it is in
 * `web-fetch.ts`: egress routing, auditing, and tests that do not reach the
 * public internet.
 *
 * Results are capped and cached per query, because a tool result is re-sent on
 * every later step of the turn and anything uncapped is paid for repeatedly.
 */

import { type Tool, tool } from "ai";
import { Parser } from "htmlparser2";
import { z } from "zod";

import { DEFAULT_CAPS, type OutputCaps, capHead } from "./caps.js";

export type WebSearchResult = {
	/** Page title, as the search engine presented it. */
	title: string;
	/** Absolute URL of the result. */
	url: string;
	/** Search engine's snippet / description for the result. */
	snippet: string;
};

export type WebSearchFn = (
	query: string,
	opts: { maxResults: number; signal: AbortSignal },
) => Promise<WebSearchResult[]>;

export type WebSearchOptions = {
	/** Output caps, already resolved by the caller. */
	caps?: OutputCaps;
	/** The `fetch` behind the default DuckDuckGo search. */
	fetchImpl?: typeof fetch;
	/**
	 * The search backend. Defaults to a DuckDuckGo HTML scrape
	 * (https://html.duckduckgo.com/html/), which needs no API key. Pass your own
	 * to use Brave, Serper, Tavily, Google, or any other search provider.
	 */
	search?: WebSearchFn;
	/** Ceiling on results returned per call. Default 8. */
	maxResults?: number;
	/** Request timeout when the caller names none. Default 30s. */
	defaultTimeoutSeconds?: number;
	/** Ceiling on the caller's timeout. Default 120s. */
	maxTimeoutSeconds?: number;
	/** `User-Agent` for the search request. */
	userAgent?: string;
};

const DEFAULT_MAX_RESULTS = 8;
const DEFAULT_TIMEOUT_SECONDS = 30;
const MAX_TIMEOUT_SECONDS = 120;

const DEFAULT_USER_AGENT =
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36";

/** DuckDuckGo's HTML search endpoint. No API key, no JavaScript required. */
const DUCKDUCKGO_HTML = "https://html.duckduckgo.com/html/";

/** How many converted result pages a run holds on to. */
const CACHE_ENTRIES = 8;

/**
 * The `web_search` tool.
 */
export const createWebSearchTool = (options: WebSearchOptions = {}): Tool => {
	const caps = options.caps ?? DEFAULT_CAPS;
	const fetchImpl = options.fetchImpl ?? fetch;
	const search = options.search ?? createDuckDuckGoSearch(fetchImpl, options.userAgent);
	const maxResults = options.maxResults ?? DEFAULT_MAX_RESULTS;
	const defaultTimeout = options.defaultTimeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS;
	const maxTimeout = options.maxTimeoutSeconds ?? MAX_TIMEOUT_SECONDS;

	/**
	 * Results this run has already paid for.
	 *
	 * Keyed by query *and* limit, because asking for 20 results over a query
	 * already served as 8 is a different question. Re-serving beats re-requesting.
	 */
	const served = new Map<string, string>();

	return tool({
		description:
			"Search the web and return a list of results (title, URL, snippet). " +
			"Use this when you do not know the exact URL to fetch — it finds pages " +
			"matching a query, and you can then `web_fetch` the promising ones. " +
			"Results are capped; narrow the query if there are more relevant pages. " +
			"Read-only: it changes nothing on disk. " +
			"One query at a time.",
		inputSchema: z.object({
			query: z.string().min(1).describe("The search query"),
			maxResults: z
				.number()
				.int()
				.min(1)
				.max(maxResults)
				.optional()
				.describe(`Max results to return (default ${maxResults}, max ${maxResults})`),
		}),
		execute: async ({ query, maxResults: requested }, callOptions) => {
			const limit = Math.min(requested ?? maxResults, maxResults);
			const cacheKey = `${query}\n${limit}`;

			const known = served.get(cacheKey);
			if (known !== undefined) {
				return `${known}\n\n[already searched this query earlier in this run with the same limit — the results above are the same ones, no second request was made.]`;
			}

			const cancelled = (callOptions as { abortSignal?: AbortSignal } | undefined)
				?.abortSignal;
			const signal = AbortSignal.any([
				AbortSignal.timeout(defaultTimeout * 1000),
				...(cancelled ? [cancelled] : []),
			]);

			let results: WebSearchResult[];
			try {
				results = await search(query, { maxResults: limit, signal });
			} catch (error) {
				if (cancelled?.aborted) {
					return "Cancelled: the turn was interrupted before the search finished.";
				}
				if (signal.aborted) {
					return `Error: search for "${query}" did not respond within ${defaultTimeout}s. Retry with a larger timeoutSeconds.`;
				}
				return `Error: could not search for "${query}" — ${
					error instanceof Error ? error.message : String(error)
				}`;
			}

			// The backend may return more than asked; cap what we display so the
			// limit is real even when the backend ignores `maxResults`.
			results = results.slice(0, limit);

			if (results.length === 0) {
				return `No results for "${query}".`;
			}

			const lines = results.map(
				(r, i) =>
					`${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`,
			);

			const header = `Results for "${query}":`;
			const more = results.length > limit ? `\n[truncated at ${limit} results — narrow the query]` : "";

			const full = [header, ...lines, more].filter(Boolean).join("\n").trim();

			served.set(cacheKey, full);
			if (served.size > CACHE_ENTRIES) {
				const oldest = served.keys().next();
				if (!oldest.done) served.delete(oldest.value);
			}

			return capHead(
				full,
				caps.webSearch.maxLines,
				caps.webSearch.maxChars,
				`Narrow the query to see different results.`,
			);
		},
	});
};

/**
 * DuckDuckGo HTML search backend. No API key.
 *
 * Fetches https://html.duckduckgo.com/html/?q=<query> and extracts the
 * result blocks: title, URL, and snippet for each.
 *
 * Exported so a host can wrap or replace it, and so tests can exercise the
 * parser without reaching the network.
 */
export const createDuckDuckGoSearch = (
	fetchImpl: typeof fetch,
	userAgent?: string,
): WebSearchFn => {
	return async (query, { maxResults, signal }) => {
		const url = `${DUCKDUCKGO_HTML}?q=${encodeURIComponent(query)}`;
		const response = await fetchImpl(url, {
			redirect: "follow",
			signal,
			headers: {
				"User-Agent": userAgent ?? DEFAULT_USER_AGENT,
				Accept: "text/html",
				"Accept-Language": "en-US,en;q=0.9",
			},
		});

		if (!response.ok) {
			throw new Error(`HTTP ${response.status} ${response.statusText}`);
		}

		const html = await response.text();
		return parseDuckDuckGoResults(html, maxResults);
	};
};

/**
 * Extract results from a DuckDuckGo HTML page.
 *
 * Collects every `result__a` link (title + URL) and every `result__snippet`
 * in document order, then pairs them by index. DuckDuckGo emits them in the
 * same order, so index alignment is correct.
 *
 * Exported for tests.
 */
export const parseDuckDuckGoResults = (
	html: string,
	maxResults: number,
): WebSearchResult[] => {
	const titles: string[] = [];
	const urls: string[] = [];
	const snippets: string[] = [];

	let currentField: "title" | "snippet" | null = null;
	let text = "";

	const parser = new Parser({
		onopentag(name, attribs) {
			const className = attribs.class ?? "";
			if (name === "a" && className.includes("result__a")) {
				currentField = "title";
				urls.push(decodeDuckDuckGoUrl(attribs.href ?? ""));
			} else if (className.includes("result__snippet")) {
				currentField = "snippet";
			}
			text = "";
		},
		ontext(input) {
			text += input;
		},
		onclosetag() {
			if (currentField === "title") {
				titles.push(text.trim());
				currentField = null;
			} else if (currentField === "snippet") {
				snippets.push(text.trim());
				currentField = null;
			}
			text = "";
		},
	});

	parser.write(html);
	parser.end();

	const results: WebSearchResult[] = [];
	const count = Math.min(titles.length, urls.length, snippets.length, maxResults);
	for (let i = 0; i < count; i++) {
		results.push({
			title: titles[i] ?? "",
			url: urls[i] ?? "",
			snippet: snippets[i] ?? "",
		});
	}
	return results;
};

/**
 * Decode a DuckDuckGo redirect link into the real destination URL.
 *
 * DuckDuckGo wraps external links as `/l/?udd=<base64url>&...`. The `udd`
 * parameter is base64url-encoded; decode it and return the real URL when it is
 * an http(s) URL. Otherwise return the href as-is.
 */
const decodeDuckDuckGoUrl = (href: string): string => {
	try {
		const u = new URL(href);
		if (u.pathname === "/l/" || u.hostname.endsWith("duckduckgo.com")) {
			const encoded = u.searchParams.get("udd");
			if (encoded) {
				// DuckDuckGo uses base64url: - instead of +, _ instead of /
				const base64 = encoded.replace(/-/g, "+").replace(/_/g, "/");
				const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
				const decoded = Buffer.from(padded, "base64").toString("utf8");
				if (decoded.startsWith("http://") || decoded.startsWith("https://")) {
					return decoded;
				}
			}
		}
	} catch {
		// fall through — return the href unchanged
	}
	return href;
};
