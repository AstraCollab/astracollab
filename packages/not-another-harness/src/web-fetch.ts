/**
 * Fetching a URL, and turning what comes back into something a model can read.
 *
 * The reason this is a tool and not `curl` in bash is not convenience. A shell
 * fetch spends a step and a model round trip to decode terminal output back into
 * structure, and it hands back markup rather than text: a documentation page
 * arrives as 400KB of `<nav>`, `<script>` and inline CSS, of which the answer is
 * maybe 4KB. The same argument `prompt.ts` already makes for `read` over `cat`,
 * applied to the network.
 *
 * So this converts before returning: HTML becomes markdown, or plain text, or
 * raw markup if that is what was asked for. Conversion is where the saving is,
 * and it is also why a size ceiling has to exist on the *download*, not only on
 * the output — 5MB of markup usually collapses to 30KB of markdown, but nothing
 * knows that until the whole body has arrived.
 *
 * Three things are deliberately borrowed from opencode's `webfetch`:
 *
 * - **Per-format `Accept` negotiation.** Asking for `text/markdown` first means a
 *   site that serves it (a growing number of docs sites, and every GitHub
 *   README) is never round-tripped through HTML conversion at all.
 * - **A browser `User-Agent`, with an honest one as the fallback.** Documentation
 *   hosts sit behind bot protection that challenges anything without one. The
 *   retry matters more than it looks: the first request claims to be a browser
 *   while presenting a Node TLS fingerprint, which is exactly the mismatch
 *   Cloudflare's challenge is looking for, so a 403 with `cf-mitigated:
 *   challenge` is answered by asking again as plainly as possible rather than as
 *   a browser pretending.
 * - **A content-length check before reading the body.** Cheap, and it is the only
 *   thing standing between a hostile or broken server and an out-of-memory crash
 *   — with a streaming read as the backstop for the responses that send no
 *   content-length at all.
 *
 * What is borrowed from nothing: opencode returns fetched images as attachments
 * and errors out above 5MB. Neither fits here. Every tool in this harness
 * returns a capped string, because a tool result is re-sent on every later step
 * of the turn and anything uncapped is paid for repeatedly; and a binary body
 * becomes a one-line notice rather than an error, since "this URL is a PNG" is a
 * fact the agent can act on.
 */
import { type Tool, tool } from "ai";
import { Parser } from "htmlparser2";
import TurndownService from "turndown";
import { z } from "zod";

import { DEFAULT_CAPS, type OutputCaps, capHead } from "./caps.js";

export type WebFetchFormat = "markdown" | "text" | "html";

export type WebFetchOptions = {
	/**
	 * Output caps, already resolved by the caller.
	 *
	 * Falls back to `DEFAULT_CAPS` when a caller assembling this tool on its own
	 * passes nothing, so the numbers here are the same ones the built-in tools
	 * get rather than a second set written out beside them.
	 */
	caps?: OutputCaps;
	/**
	 * The `fetch` to make requests with.
	 *
	 * Injectable because the alternative is a test suite that reaches the public
	 * internet, and because a host that has to route or audit its own egress
	 * (a sandbox, a proxy, an egress-logging gateway) needs somewhere to put
	 * that policy.
	 */
	fetchImpl?: typeof fetch;
	/** Download ceiling, enforced while streaming. Default 5MB. */
	maxBytes?: number;
	/** Request timeout when the caller names none. Default 30s. */
	defaultTimeoutSeconds?: number;
	/** Ceiling on the caller's timeout. Default 120s. */
	maxTimeoutSeconds?: number;
	/** `User-Agent` for the first attempt; the fallback asks as `nah`. */
	userAgent?: string;
};

/** Download ceiling. Big enough for a minified bundle, small enough to survive. */
const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;

const DEFAULT_TIMEOUT_SECONDS = 30;
const MAX_TIMEOUT_SECONDS = 120;

/**
 * What to ask for, per format.
 *
 * The q-values are the point: a server that can serve markdown does, one that
 * cannot falls to plain text, and one that only has HTML is asked for that last
 * rather than being handed a bare wildcard and left to guess. The trailing
 * wildcard at q=0.1 keeps the door open, so a JSON endpoint returns its JSON
 * instead of an error page.
 */
const ACCEPT: Record<WebFetchFormat, string> = {
	markdown:
		"text/markdown;q=1.0, text/x-markdown;q=0.9, text/plain;q=0.8, text/html;q=0.7, */*;q=0.1",
	text: "text/plain;q=1.0, text/markdown;q=0.9, text/html;q=0.8, */*;q=0.1",
	html: "text/html;q=1.0, application/xhtml+xml;q=0.9, text/plain;q=0.8, text/markdown;q=0.7, */*;q=0.1",
};

/**
 * A browser user agent for the first attempt.
 *
 * The point of the browser string is only to get past the bot checks that sit in
 * front of documentation; there is no attempt here to look like a browser
 * session, because the honest fallback below is the one that matters and a tool
 * that needed the disguise to work would be a tool that does not work.
 */
const DEFAULT_USER_AGENT =
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36";

/** The identity used for the retry, and the one worth naming in a notice. */
const HONEST_USER_AGENT = "nah";

/**
 * Content types worth decoding as text.
 *
 * An allowlist rather than "not `image/*`", because the failure being avoided is
 * a base64 PDF or a zip arriving in a tool result as mojibake that costs a step
 * to diagnose. `+json`/`+xml` are checked because API responses are the most
 * common thing an agent is sent to fetch.
 */
const TEXTUAL_MIME =
	/^(?:text\/|application\/(?:json|xml|javascript|ecmascript|xhtml\+xml|x-yaml|yaml|toml|x-www-form-urlencoded|graphql|ld\+json)\b)|[+](?:json|xml)\b/;

/** Content types that are HTML for conversion purposes. */
const HTML_MIME = /^(?:text\/html|application\/xhtml\+xml)\b/;

/**
 * Elements whose text is never the answer.
 *
 * `head` and `title` are here because turndown and a naive text extraction both
 * happily emit them, and a page whose markdown opens with its own `<title>` and
 * a link to itself has spent the first lines of a capped result on the part of
 * the page nobody reads. The `<h1>` is the title.
 */
const NON_CONTENT = new Set([
	"head",
	"title",
	"script",
	"style",
	"noscript",
	"template",
	"iframe",
	"object",
	"embed",
	"svg",
	"canvas",
]);

/**
 * How many converted pages a run holds on to.
 *
 * Small on purpose: this exists to make the *accidental* repeat free, and it is
 * paid for in memory on every entry. Eight is past the number of pages one
 * investigation actually revisits.
 */
const CACHE_ENTRIES = 8;

/**
 * The visible text of an HTML document.
 *
 * A streaming parse rather than `parseDocument`, because the only thing wanted
 * here is text and building a DOM for a 5MB page to throw all but the text away
 * costs more than the text. `skipDepth` rather than a set of open tags because
 * these nest (`<noscript><iframe>`), and a boolean would resume collecting after
 * the inner tag closed.
 */
const htmlToText = (html: string): string => {
	let text = "";
	let skipDepth = 0;
	const parser = new Parser({
		onopentag(name) {
			if (skipDepth > 0 || NON_CONTENT.has(name)) skipDepth += 1;
		},
		ontext(input) {
			if (skipDepth === 0) text += input;
		},
		onclosetag() {
			if (skipDepth > 0) skipDepth -= 1;
		},
	});
	parser.write(html);
	parser.end();
	return text.trim();
};

/**
 * Markdown for a model that will quote it back.
 *
 * `atx` headings because `#` is what every model has seen most of; `-` bullets
 * for the same reason; and `fenced` code blocks, because an indented block
 * survives the round trip through a transcript far less reliably than a fence
 * does. The non-content elements are removed rather than skipped over: turndown
 * would otherwise emit their contents as body text.
 */
const htmlToMarkdown = (html: string): string => {
	const service = new TurndownService({
		headingStyle: "atx",
		hr: "---",
		bulletListMarker: "-",
		codeBlockStyle: "fenced",
		emDelimiter: "*",
	});
	service.remove([...NON_CONTENT]);
	return service.turndown(html);
};

/** `https://host/path`, with the scheme and any credentials dropped. */
const displayUrl = (url: URL): string => `${url.protocol}//${url.host}${url.pathname}`;

const tooLarge = (maxBytes: number): string =>
	`Error: response exceeds the ${Math.round(maxBytes / 1024)}KB download limit. Fetch a more specific URL (a single file or section) instead of the whole page.`;

/**
 * Read a response body, giving up once it passes `maxBytes`.
 *
 * The `content-length` check alone is not enough, and the reason is worth
 * stating because it is the whole reason this function exists: a chunked
 * response sends no `content-length`, so the header check passes and the body
 * then streams in without bound. Counting while reading is what makes the
 * ceiling real rather than advisory.
 */
const readCapped = async (
	response: Response,
	maxBytes: number,
): Promise<Uint8Array | null> => {
	const declared = Number(response.headers.get("content-length"));
	if (Number.isFinite(declared) && declared > maxBytes) {
		return null;
	}
	const body = response.body;
	if (!body) {
		const whole = new Uint8Array(await response.arrayBuffer());
		return whole.byteLength > maxBytes ? null : whole;
	}
	const reader = body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			if (!value) continue;
			total += value.byteLength;
			if (total > maxBytes) {
				await reader.cancel();
				return null;
			}
			chunks.push(value);
		}
	} finally {
		reader.releaseLock();
	}
	const out = new Uint8Array(total);
	let at = 0;
	for (const chunk of chunks) {
		out.set(chunk, at);
		at += chunk.byteLength;
	}
	return out;
};

/**
 * The `web_fetch` tool.
 *
 * Annotated rather than inferred, for the reason `createOutlineTool` gives:
 * `tool()` returns a type that reaches into `@ai-sdk/provider-utils`, and
 * leaving it inferred produces a declaration file that cannot name its own
 * return type (TS2742).
 */
export const createWebFetchTool = (options: WebFetchOptions = {}): Tool => {
	const caps = options.caps ?? DEFAULT_CAPS;
	const fetchImpl = options.fetchImpl ?? fetch;
	const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
	const defaultTimeout = options.defaultTimeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS;
	const maxTimeout = options.maxTimeoutSeconds ?? MAX_TIMEOUT_SECONDS;
	const userAgent = options.userAgent ?? DEFAULT_USER_AGENT;

	/**
	 * Converted pages this run has already paid for.
	 *
	 * Keyed by URL *and* format, because `format: "text"` over a page already
	 * fetched as markdown is a different question and converting twice is the
	 * cost being avoided here, not the request. Re-serving beats re-requesting:
	 * the step-scoped de-duplication in `dedupe.ts` only collapses two identical
	 * calls in the same step, so the repeat that actually costs money is the same
	 * URL fetched again four steps later, on a transcript that re-sends itself
	 * from there on.
	 */
	const served = new Map<string, string>();

	return tool({
		description:
			"Fetch a URL and return its content as markdown (default), plain text, or raw HTML. " +
			"HTML is converted before it is returned, so a documentation page arrives as the prose and code in it rather than as markup — this is the tool to use for reading docs, an API reference, a release note, or an issue. " +
			"Prefer this over `curl`/`wget` in bash: the shell version costs a step to decode, and returns markup. " +
			"Output is capped, and the notice on a cut fetch will not ask you to fetch again — ask for a more specific URL instead. " +
			"Read-only: it changes nothing on disk. " +
			"Fetch one URL at a time. If you do not know the exact URL, you cannot use this — there is no search here.",
		inputSchema: z.object({
			url: z.string().min(1).describe("The absolute URL to fetch (http or https)"),
			format: z
				.enum(["markdown", "text", "html"])
				.optional()
				.describe(
					"markdown (default) converts HTML to markdown; text returns visible text only; html returns the raw markup. Use text for a page you only need to skim for one string.",
				),
			timeoutSeconds: z
				.number()
				.int()
				.min(1)
				.max(MAX_TIMEOUT_SECONDS)
				.optional()
				.describe(`Request timeout in seconds (default ${defaultTimeout}, max ${maxTimeout})`),
		}),
		execute: async ({ url, format, timeoutSeconds }, callOptions) => {
			const wanted: WebFetchFormat = format ?? "markdown";
			const cacheKey = `${url}\n${wanted}`;

			const known = served.get(cacheKey);
			if (known !== undefined) {
				return `${known}\n\n[already fetched this URL earlier in this run with the same format — the content above is the same one, no second request was made.]`;
			}

			let target: URL;
			try {
				target = new URL(url);
			} catch {
				return `Error: ${url} is not a valid absolute URL. Include the scheme, e.g. https://example.com/docs.`;
			}
			if (target.protocol !== "http:" && target.protocol !== "https:") {
				// The gate exists so `file:///etc/passwd` and a `data:` URL carrying
				// a payload are refused before anything is opened, not after.
				return `Error: only http and https URLs can be fetched, not ${target.protocol}//`;
			}

			const seconds = Math.min(timeoutSeconds ?? defaultTimeout, maxTimeout);
			// The turn being interrupted and the request running long are different
			// failures with different advice, so both signals are kept and reported
			// apart rather than collapsing into one "aborted".
			const cancelled = (callOptions as { abortSignal?: AbortSignal } | undefined)
				?.abortSignal;
			const signal = AbortSignal.any([
				AbortSignal.timeout(seconds * 1000),
				...(cancelled ? [cancelled] : []),
			]);

			const request = async (agent: string): Promise<Response> =>
				fetchImpl(target, {
					redirect: "follow",
					signal,
					headers: {
						"User-Agent": agent,
						Accept: ACCEPT[wanted],
						"Accept-Language": "en-US,en;q=0.9",
					},
				});

			let response: Response;
			try {
				response = await request(userAgent);
				// Cloudflare's challenge is triggered by the TLS fingerprint
				// disagreeing with the claimed browser, so the disguise is exactly
				// what provoked it. Asking again as `nah` is the request that tends
				// to be let through.
				if (
					response.status === 403 &&
					response.headers.get("cf-mitigated") === "challenge"
				) {
					await response.body?.cancel();
					response = await request(HONEST_USER_AGENT);
				}
			} catch (error) {
				if (cancelled?.aborted) {
					return "Cancelled: the turn was interrupted before the fetch finished.";
				}
				if (signal.aborted) {
					return `Error: ${displayUrl(target)} did not respond within ${seconds}s. Retry with a larger timeoutSeconds, or a URL that answers faster.`;
				}
				return `Error: could not reach ${displayUrl(target)} — ${
					error instanceof Error ? error.message : String(error)
				}`;
			}

			let bytes: Uint8Array | null;
			try {
				bytes = await readCapped(response, maxBytes);
			} catch (error) {
				// A body that fails part-way through is reported as a failure to
				// read, not as an over-limit body: the two have different causes and
				// the same advice, but only one of them is worth retrying.
				if (cancelled?.aborted) {
					return "Cancelled: the turn was interrupted before the body finished downloading.";
				}
				return `Error: ${displayUrl(target)} — the response body failed part-way through (${
					error instanceof Error ? error.message : String(error)
				}).`;
			}
			if (bytes === null) {
				return `Error: ${displayUrl(target)} returned a body over the ${Math.round(
					maxBytes / 1024,
				)}KB download limit. Fetch a more specific URL — one section or one file — rather than retrying this one.`;
			}

			const contentType = response.headers.get("content-type") ?? "";
			const mime = (contentType.split(";")[0] ?? "").trim().toLowerCase();
			const shown = displayUrl(new URL(response.url || target.href));
			const raw = new TextDecoder().decode(bytes);

			if (!response.ok) {
				// The body is the useful part: a 404 explains which path was wrong,
				// and a 403 explains which host is refusing. Both are what an agent
				// needs to pick its next move, and both are worth the bytes.
				const detail =
					mime !== "" && !TEXTUAL_MIME.test(mime)
						? ""
						: `\n\n${capHead(
								raw.trim(),
								caps.webFetchFailure.maxLines,
								caps.webFetchFailure.maxChars,
								"The status line is the answer; the body is context for it.",
							)}`;
				return `HTTP ${response.status} ${response.statusText || ""}`.trim() +
					` for ${shown}${detail}`;
			}

			if (mime !== "" && !TEXTUAL_MIME.test(mime)) {
				// Named rather than decoded: base64 of a PDF in a tool result is
				// unreadable, and an unreadable result costs a step to diagnose the
				// same way a wrong file costs one to open.
				return `${mime} (${Math.round(bytes.byteLength / 1024)}KB) fetched from ${shown}. This tool returns text, so the body was not read — there is nothing here to quote.`;
			}

			/**
			 * Whether this is markup, when the server would not say.
			 *
			 * A missing `content-type` is rare but not exotic — a misconfigured
			 * origin, or a proxy that rewrites headers — and defaulting to "not
			 * HTML" there hands the model a page of raw tags under a heading that
			 * claimed markdown, which is the failure that makes the tool look
			 * broken rather than the server.
			 */
			const isHtml = mime === "" ? /<[a-z][^>]*>/i.test(raw) : HTML_MIME.test(mime);

			const body =
				!isHtml || wanted === "html"
					? raw
					: wanted === "markdown"
						? htmlToMarkdown(raw)
						: htmlToText(raw);

			/**
			 * Notes that carry information rather than decorate.
			 *
			 * A URL that redirected, and a page served in a medium other than the
			 * one asked for, are both cases where the agent's model of what it now
			 * holds is wrong — and both are cheap to state and impossible to guess.
			 */
			const notes: string[] = [];
			if (shown !== displayUrl(target)) {
				notes.push(`[redirected to ${shown}]`);
			}
			if (wanted !== "html" && isHtml === false && mime !== "" && !HTML_MIME.test(mime)) {
				notes.push(`[served as ${mime}, not HTML — returned as-is, no conversion applied]`);
			}

			const capped = capHead(
				body.trim(),
				caps.webFetch.maxLines,
				caps.webFetch.maxChars,
				/**
				 * No re-fetch, and the wording says why.
				 *
				 * This is the `bash` regression at `tools.ts`: a cap notice that
				 * suggests trying again for the rest sends the agent round the same
				 * loop, paying for the identical page twice and ending up worse off
				 * than never having capped. A web page cannot be narrowed the way a
				 * file can be paged, so the only honest advice is a smaller request.
				 */
				"This page cannot be paged, so do not fetch it again to see the rest — ask for a more specific URL (one section, one file) or use format:\"text\" for a smaller body.",
			);

			/**
			 * The assembled answer, notes included.
			 *
			 * Cached whole rather than caching only the body, because the notes are
			 * part of what this call returned — a re-serve that dropped the
			 * "[redirected to …]" line would silently contradict the first answer
			 * about where the content came from.
			 */
			const full = [capped, ...notes].join("\n\n");

			served.set(cacheKey, full);
			if (served.size > CACHE_ENTRIES) {
				// Oldest first: `Map` preserves insertion order, and re-setting a key
				// would move it, so this only ever drops a page nobody revisited.
				const oldest = served.keys().next();
				if (!oldest.done) served.delete(oldest.value);
			}

			return full;
		},
	});
};
