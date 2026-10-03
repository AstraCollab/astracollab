import { createServer, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as nodePath from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createNodeEnvironment } from "../src/node.js";
import { type CodingToolsOptions, createCodingTools } from "../src/tools.js";
import { createWebFetchTool } from "../src/web-fetch.js";

type ToolMap = Record<
	string,
	{ execute: (i: never, c: unknown) => Promise<string> }
>;

const PAGE = `<!doctype html>
<html><head><title>Ignored</title><style>p{color:red}</style></head>
<body>
<nav><a href="/other">nav link</a></nav>
<h1>Release notes</h1>
<p>The <code>fetch</code> tool takes a <b>url</b>.</p>
<ul><li>first</li><li>second</li></ul>
<pre><code>nah --model x</code></pre>
<script>var tracking = 1;</script>
<noscript>enable js</noscript>
</body></html>`;

describe("web_fetch", () => {
	let server: Server;
	let origin: string;
	/** Requests the server saw, so "was this fetched twice" is answerable. */
	let seen: Array<{ url: string; accept?: string; agent?: string }> = [];
	let dir: string;

	beforeAll(async () => {
		server = createServer((req, res) => {
			const path = (req.url ?? "/").split("?")[0] ?? "/";
			seen.push({
				url: req.url ?? "",
				accept: req.headers.accept,
				agent: req.headers["user-agent"],
			});

			if (path === "/page") {
				res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
				res.end(PAGE);
				return;
			}
			if (path === "/markdown") {
				res.writeHead(200, { "content-type": "text/markdown" });
				res.end("# Already markdown\n\nNo conversion needed.\n");
				return;
			}
			if (path === "/json") {
				res.writeHead(200, { "content-type": "application/json" });
				res.end('{"answer":42}');
				return;
			}
			if (path === "/png") {
				res.writeHead(200, { "content-type": "image/png" });
				res.end(Buffer.alloc(2048));
				return;
			}
			if (path === "/redirect") {
				res.writeHead(302, { location: "/page" });
				res.end();
				return;
			}
			if (path === "/missing") {
				res.writeHead(404, { "content-type": "text/html" });
				res.end("<h1>Not found</h1><p>No such page.</p>");
				return;
			}
			if (path === "/guarded") {
				if ((req.headers["user-agent"] ?? "").startsWith("Mozilla/5.0")) {
					res.writeHead(403, {
						"content-type": "text/html",
						"cf-mitigated": "challenge",
					});
					res.end("<h1>Just a moment...</h1>");
					return;
				}
				res.writeHead(200, { "content-type": "text/html" });
				res.end("<h1>Real content</h1>");
				return;
			}
			if (path === "/declared-huge") {
				// Declares 100KB up front, so the ceiling can be enforced from the
				// header without the body ever being read.
				const filler = `<p>${"x".repeat(1024)}</p>`;
				const body = filler.repeat(100);
				res.writeHead(200, {
					"content-type": "text/html",
					"content-length": String(Buffer.byteLength(body)),
				});
				res.end(body);
				return;
			}
			if (path === "/huge") {
				// No content-length: a chunked response is the case where the
				// header check passes and the body still has to be counted.
				res.writeHead(200, { "content-type": "text/html" });
				for (let i = 0; i < 40; i += 1) {
					res.write(`<p>${"y".repeat(1024)}</p>`);
				}
				res.end();
				return;
			}
			if (path === "/hang") {
				return; // never responds
			}
			res.writeHead(500, { "content-type": "text/plain" });
			res.end("boom");
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const address = server.address();
		if (address === null || typeof address === "string") {
			throw new Error("server did not bind a port");
		}
		origin = `http://127.0.0.1:${address.port}`;
	});

	afterAll(async () => {
		await new Promise<void>((resolve) => server.close(() => resolve()));
	});

	beforeEach(async () => {
		seen = [];
		dir = await mkdtemp(nodePath.join(tmpdir(), "nah-webfetch-"));
	});

	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	const build = (options?: CodingToolsOptions): ToolMap =>
		createCodingTools(createNodeEnvironment(dir), options) as ToolMap;

	/** The tool with its own download ceiling, for the size-limit cases. */
	const smallFetch = (maxBytes: number) => {
		const tool = createWebFetchTool({ maxBytes });
		return (input: unknown, ctx: unknown = {}) => tool.execute(input as never, ctx);
	};

	const fetchTool = (options?: CodingToolsOptions) => {
		const tools = build(options);
		const tool = tools.web_fetch;
		if (!tool) throw new Error("web_fetch was not registered");
		return (input: unknown, ctx: unknown = {}) => tool.execute(input as never, ctx);
	};

	describe("registration", () => {
		it("is registered by default and can be turned off", () => {
			expect(Object.keys(build())).toContain("web_fetch");
			expect(Object.keys(build({ withWebFetch: false }))).not.toContain(
				"web_fetch",
			);
		});

		it("is approval-gated, because a fetched page is untrusted input", async () => {
			const asked: string[] = [];
			const gated = fetchTool({
				approveToolCall: async (name) => {
					asked.push(name);
					return false;
				},
			});
			const out = await gated({ url: `${origin}/page` });
			expect(asked).toEqual(["web_fetch"]);
			expect(out).toContain("DENIED");
			// The refusal has to happen before the request, or the gate is theatre.
			expect(seen).toEqual([]);
		});

		it("stays ungated when the host passes no approver", async () => {
			// Pi-style trust: an omitted gate means everything is allowed.
			const out = await fetchTool()({ url: `${origin}/page` });
			expect(out).toContain("Release notes");
		});
	});

	describe("conversion", () => {
		it("returns markdown by default, not markup", async () => {
			const out = await fetchTool()({ url: `${origin}/page` });
			expect(out).toContain("# Release notes");
			expect(out).toContain("`fetch`");
			expect(out).toContain("[nav link](/other)");
			expect(out).toContain("nah --model");
			expect(out).not.toContain("<h1>");
		});

		it("drops script, style and noscript content", async () => {
			const out = await fetchTool()({ url: `${origin}/page` });
			expect(out).not.toContain("var tracking");
			expect(out).not.toContain("color:red");
			expect(out).not.toContain("enable js");
			// The <title> in <head> is not the page's title; the <h1> is.
			expect(out).not.toContain("Ignored");
		});

		it("returns visible text only for format:text", async () => {
			const out = await fetchTool()({ url: `${origin}/page`, format: "text" });
			expect(out).toContain("Release notes");
			// Prose, with every tag gone but the words inside kept — including the
			// nav, which is text a reader sees even though it is not the answer.
			expect(out).toContain("nav link");
			expect(out).not.toContain("<");
			expect(out).not.toContain("# Release notes");
		});

		it("returns the raw markup for format:html", async () => {
			const out = await fetchTool()({ url: `${origin}/page`, format: "html" });
			expect(out).toContain("<h1>Release notes</h1>");
			expect(out).toContain("var tracking");
		});

		it("does not convert a page already served as markdown", async () => {
			const out = await fetchTool()({ url: `${origin}/markdown` });
			expect(out).toContain("# Already markdown");
			expect(seen[0]?.accept).toContain("text/markdown;q=1.0");
		});

		it("returns JSON untouched and says it was not converted", async () => {
			const out = await fetchTool()({ url: `${origin}/json` });
			expect(out).toContain('{"answer":42}');
			expect(out).toContain("application/json");
		});

		it("asks for the format it was given", async () => {
			await fetchTool()({ url: `${origin}/page`, format: "text" });
			expect(seen[0]?.accept).toContain("text/plain;q=1.0");
		});

		it("names a binary content type instead of decoding it", async () => {
			const out = await fetchTool()({ url: `${origin}/png` });
			expect(out).toContain("image/png");
			expect(out).toContain("nothing here to quote");
		});
	});

	describe("refusals", () => {
		it("refuses a scheme that is not http or https", async () => {
			const out = await fetchTool()({ url: "file:///etc/passwd" });
			expect(out).toContain("only http and https");
			expect(seen).toEqual([]);
		});

		it("refuses a bare hostname, and says what a valid URL looks like", async () => {
			const out = await fetchTool()({ url: "example.com/docs" });
			expect(out).toContain("not a valid absolute URL");
		});

		it("reports a non-2xx with its status and its body", async () => {
			const out = await fetchTool()({ url: `${origin}/missing` });
			expect(out).toContain("HTTP 404");
			expect(out).toContain("No such page.");
		});

		it("tells the agent a fetch needs a URL it has, not a search", () => {
			// Carried by the description rather than the schema: there is no search
			// behind this tool, and a model that has guessed is going to try anyway.
			const built = createWebFetchTool();
			expect(built.description).toContain("no search here");
			// The redirect that makes the tool worth having has to be stated too,
			// or the model shells out to curl and pays for the markup.
			expect(built.description).toContain("curl");
		});
	});

	describe("limits", () => {
		it("gives up on a chunked body over the ceiling, where no header says so", async () => {
			// 40KB over a 1KB ceiling with no content-length: the header check
			// passes, and only counting bytes while reading stops it.
			const run = smallFetch(1024);
			expect(await run({ url: `${origin}/huge` })).toContain("download limit");
		});

		it("gives up on a declared content-length over the ceiling", async () => {
			// A header promising more than the ceiling is refused before the body
			// is touched, which is the cheap half of the same guarantee.
			const run = smallFetch(1024);
			expect(await run({ url: `${origin}/declared-huge` })).toContain(
				"download limit",
			);
		});

		it("keeps a body that fits", async () => {
			const run = smallFetch(64 * 1024);
			expect(await run({ url: `${origin}/page` })).toContain(
				"# Release notes",
			);
		});

		it("caps the converted page and does not ask for a second fetch", async () => {
			const tools = build({ caps: { webFetch: { maxChars: 60 } } });
			const out = await (
				tools.web_fetch as { execute: (i: never, c: unknown) => Promise<string> }
			).execute({ url: `${origin}/page` } as never, {});
			expect(out).toContain("output truncated");
			// The bash regression at tools.ts: a notice that suggests re-fetching
			// sends the agent round the same loop and costs more than no cap at all.
			expect(out).toContain("do not fetch it again");
		});

		it("times out, and says the timeout was the problem", async () => {
			const out = await fetchTool()({
				url: `${origin}/hang`,
				timeoutSeconds: 1,
			});
			expect(out).toContain("did not respond within 1s");
		}, 10_000);

		it("reports an interrupted turn differently from a slow one", async () => {
			const controller = new AbortController();
			controller.abort();
			const out = await fetchTool()({
				url: `${origin}/page`,
			}, { abortSignal: controller.signal });
			expect(out).toContain("interrupted");
		});
	});

	describe("polite fetching", () => {
		it("retries an honest user agent when a bot challenge blocks the first", async () => {
			const out = await fetchTool()({ url: `${origin}/guarded` });
			expect(out).toContain("Real content");
			expect(seen).toHaveLength(2);
			expect(seen[0]?.agent).toContain("Mozilla/5.0");
			expect(seen[1]?.agent).toBe("nah");
		});

		it("follows a redirect and says where it landed", async () => {
			const out = await fetchTool()({ url: `${origin}/redirect` });
			expect(out).toContain("Release notes");
			expect(out).toContain("[redirected to");
		});
	});

	describe("paying for a page once", () => {
		it("re-serves a repeated fetch instead of requesting it again", async () => {
			const run = fetchTool();
			const first = await run({ url: `${origin}/page` });
			const second = await run({ url: `${origin}/page` });
			expect(seen).toHaveLength(1);
			expect(second).toContain("already fetched this URL");
			// Same content, so a re-read of the transcript after compaction still
			// shows what came back rather than a pointer to a result nobody has.
			expect(second).toContain("# Release notes");
			expect(first.split("\n\n")[0]).toBe(second.split("\n\n")[0]);
		});

		it("does not re-serve across formats, which is a different question", async () => {
			const run = fetchTool();
			await run({ url: `${origin}/page` });
			await run({ url: `${origin}/page`, format: "text" });
			expect(seen).toHaveLength(2);
		});

		it("re-serves the notes as well as the body", async () => {
			const run = fetchTool();
			const first = await run({ url: `${origin}/redirect` });
			const second = await run({ url: `${origin}/redirect` });
			// A re-serve that dropped the redirect line would contradict the first
			// answer about where the content came from.
			expect(first).toContain("[redirected to");
			expect(second).toContain("[redirected to");
		});
	});
});
