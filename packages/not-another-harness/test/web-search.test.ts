import { describe, expect, it } from "vitest";

import { createCodingTools } from "../src/tools.js";
import { createWebSearchTool, parseDuckDuckGoResults } from "../src/web-search.js";
import { createNodeEnvironment } from "../src/node.js";

type ToolMap = Record<
	string,
	{ execute: (i: never, c: unknown) => Promise<string> }
>;

const RESULTS: Array<{ title: string; url: string; snippet: string }> = [
	{
		title: "Polymarket Trading Strategies",
		url: "https://example.com/polymarket-strategy",
		snippet: "A guide to polymarket prediction market strategies including arbitrage and directional trading.",
	},
	{
		title: "Polymarket Hedge Strategies",
		url: "https://example.com/polymarket-hedge",
		snippet: "How to hedge positions on polymarket using correlated markets and opposite bets.",
	},
	{
		title: "Polymarket Bot Trading",
		url: "https://example.com/polymarket-bot",
		snippet: "Automated trading bots for polymarket: setup, configuration, and risk management.",
	},
];

const DIR = "/tmp/nah-websearch-test";

const build = (options?: Parameters<typeof createCodingTools>[1]): ToolMap =>
	createCodingTools(createNodeEnvironment(DIR), options ?? {}) as ToolMap;

const searchTool = (options?: Parameters<typeof createCodingTools>[1]) => {
	const tools = build(options);
	const tool = tools.web_search;
	if (!tool) throw new Error("web_search was not registered");
	return (input: unknown, ctx: unknown = {}) =>
		tool.execute(input as never, ctx);
};

const customSearch = (results: typeof RESULTS) =>
	async (_query: string) => results;

describe("web_search", () => {
	describe("registration", () => {
		it("is registered by default", () => {
			expect(Object.keys(build())).toContain("web_search");
		});

		it("can be turned off", () => {
			expect(Object.keys(build({ withWebSearch: false }))).not.toContain(
				"web_search",
			);
		});

		it("does not affect web_fetch", () => {
			const without = build({ withWebSearch: false });
			expect(without.web_search).toBeUndefined();
			expect(without.web_fetch).toBeDefined();
		});
	});

	describe("approval gating", () => {
		it("is approval-gated, because search results are untrusted input", async () => {
			const asked: string[] = [];
			const gated = searchTool({
				approveToolCall: async (name) => {
					asked.push(name);
					return false;
				},
			});
			const out = await gated({ query: "polymarket strategies" });
			expect(asked).toEqual(["web_search"]);
			expect(out).toContain("DENIED");
		});

		it("stays ungated when the host passes no approver", async () => {
			const tool = createWebSearchTool({
				search: customSearch(RESULTS),
			});
			const out = await (tool.execute as (i: never, c: unknown) => Promise<string>)(
				{ query: "polymarket strategies" },
				{},
			);
			expect(out).toContain("Polymarket Trading Strategies");
			expect(out).not.toContain("DENIED");
		});
	});

	describe("search results", () => {
		it("returns title, URL and snippet for each result", async () => {
			const tool = createWebSearchTool({ search: customSearch(RESULTS) });
			const out = await (tool.execute as (i: never, c: unknown) => Promise<string>)(
				{ query: "polymarket strategies" },
				{},
			);
			expect(out).toContain('Results for "polymarket strategies":');
			expect(out).toContain("1. Polymarket Trading Strategies");
			expect(out).toContain("https://example.com/polymarket-strategy");
			expect(out).toContain("A guide to polymarket prediction market strategies");
			expect(out).toContain("2. Polymarket Hedge Strategies");
			expect(out).toContain("3. Polymarket Bot Trading");
		});

		it("returns no results when the backend returns none", async () => {
			const tool = createWebSearchTool({ search: customSearch([]) });
			const out = await (tool.execute as (i: never, c: unknown) => Promise<string>)(
				{ query: "nothing matches" },
				{},
			);
			expect(out).toContain("No results for \"nothing matches\".");
		});

		it("respects maxResults", async () => {
			const tool = createWebSearchTool({ search: customSearch(RESULTS) });
			const out = await (tool.execute as (i: never, c: unknown) => Promise<string>)(
				{ query: "polymarket strategies", maxResults: 1 },
				{},
			);
			expect(out).toContain("1. Polymarket Trading Strategies");
			expect(out).not.toContain("2. Polymarket Hedge Strategies");
		});

		it("defaults to returning all results when none is given", async () => {
			const tool = createWebSearchTool({ search: customSearch(RESULTS) });
			const out = await (tool.execute as (i: never, c: unknown) => Promise<string>)(
				{ query: "polymarket strategies" },
				{},
			);
			expect(out).toContain("3. Polymarket Bot Trading");
		});
	});

	describe("custom search backend", () => {
		it("uses an injected search function instead of DuckDuckGo", async () => {
			const tool = createWebSearchTool({
				search: async (query) => [
					{
						title: `Custom result for ${query}`,
						url: "https://custom.example.com/result",
						snippet: "A custom search result.",
					},
				],
			});
			const out = await (tool.execute as (i: never, c: unknown) => Promise<string>)(
				{ query: "polymarket strategies" },
				{},
			);
			expect(out).toContain("Custom result for polymarket strategies");
			expect(out).toContain("https://custom.example.com/result");
			expect(out).toContain("A custom search result.");
		});
	});

	describe("caching", () => {
		it("re-serves a repeated search instead of requesting again", async () => {
			let calls = 0;
			const tool = createWebSearchTool({
				search: async () => {
					calls += 1;
					return RESULTS;
				},
			});
			const execute = tool.execute as (i: never, c: unknown) => Promise<string>;
			const first = await execute({ query: "polymarket strategies" }, {});
			const second = await execute({ query: "polymarket strategies" }, {});
			expect(calls).toBe(1);
			expect(second).toContain("already searched this query");
			expect(second).toContain("Polymarket Trading Strategies");
			expect(first.split("\n\n")[0]).toBe(second.split("\n\n")[0]);
		});

		it("does not re-serve across limits, which is a different question", async () => {
			let calls = 0;
			const tool = createWebSearchTool({
				search: async () => {
					calls += 1;
					return RESULTS;
				},
			});
			const execute = tool.execute as (i: never, c: unknown) => Promise<string>;
			await execute({ query: "polymarket strategies", maxResults: 1 }, {});
			await execute({ query: "polymarket strategies", maxResults: 3 }, {});
			expect(calls).toBe(2);
		});
	});

	describe("errors", () => {
		it("reports a backend error", async () => {
			const tool = createWebSearchTool({
				search: async () => {
					throw new Error("search engine down");
				},
			});
			const out = await (tool.execute as (i: never, c: unknown) => Promise<string>)(
				{ query: "polymarket strategies" },
				{},
			);
			expect(out).toContain("could not search");
			expect(out).toContain("search engine down");
		});

		it("reports an interrupted turn differently from a slow one", async () => {
			const controller = new AbortController();
			controller.abort();
			const tool = createWebSearchTool({
				search: async (_query, { signal }) => {
					if (signal.aborted) {
						const err = new Error("aborted") as Error & { name: string };
						err.name = "AbortError";
						throw err;
					}
					return RESULTS;
				},
			});
			const out = await (tool.execute as (i: never, c: unknown) => Promise<string>)(
				{ query: "polymarket strategies" },
				{ abortSignal: controller.signal },
			);
			expect(out).toContain("interrupted");
		});
	});

	describe("DuckDuckGo parser", () => {
		it("extracts title, URL and snippet from a results page", () => {
			const html = `<!doctype html><html><body>
<div class="result results_links_deep web-result">
  <div class="links_main">
    <a class="result__a" href="https://duckduckgo.com/l/?udd=aHR0cHM6Ly9leGFtcGxlLmNvbS9wb2x5bWFya2V0">Polymarket Home</a>
    <div class="result__snippet">The polymarket prediction market.</div>
  </div>
</div>
<div class="result results_links_deep web-result">
  <div class="links_main">
    <a class="result__a" href="https://direct.example.com/page">Direct Link</a>
    <div class="result__snippet">A direct link, no redirect.</div>
  </div>
</div></body></html>`;
			const results = parseDuckDuckGoResults(html, 10);
			expect(results).toHaveLength(2);
			expect(results[0].title).toBe("Polymarket Home");
			expect(results[0].url).toBe("https://example.com/polymarket");
			expect(results[0].snippet).toBe("The polymarket prediction market.");
			expect(results[1].title).toBe("Direct Link");
			expect(results[1].url).toBe("https://direct.example.com/page");
			expect(results[1].snippet).toBe("A direct link, no redirect.");
		});

		it("respects maxResults", () => {
			const html = `<!doctype html><html><body>
<div class="result"><div class="links_main"><a class="result__a" href="https://duckduckgo.com/l/?udd=aHR0cHM6Ly9leGFtcGxlLmNvbS8x">One</a><div class="result__snippet">snippet one</div></div></div>
<div class="result"><div class="links_main"><a class="result__a" href="https://duckduckgo.com/l/?udd=aHR0cHM6Ly9leGFtcGxlLmNvbS8y">Two</a><div class="result__snippet">snippet two</div></div></div>
<div class="result"><div class="links_main"><a class="result__a" href="https://duckduckgo.com/l/?udd=aHR0cHM6Ly9leGFtcGxlLmNvbS8z">Three</a><div class="result__snippet">snippet three</div></div></div></body></html>`;
			const results = parseDuckDuckGoResults(html, 2);
			expect(results).toHaveLength(2);
			expect(results[0].title).toBe("One");
			expect(results[1].title).toBe("Two");
		});

		it("returns empty for a page with no results", () => {
			const html = `<!doctype html><html><body><div class="no-results">No results found.</div></body></html>`;
			expect(parseDuckDuckGoResults(html, 10)).toEqual([]);
		});
	});
});
