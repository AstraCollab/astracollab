/**
 * The built artifact, exercised the way a consumer loads it.
 *
 * This exists because of a bug no amount of unit testing could have found.
 * turndown ships a `browser` field pointing at builds that need a global
 * `document`, and a `module` entry that is CommonJS wearing an ES-module
 * filename. Vite's default resolution honoured both, so `pnpm test` passed —
 * vitest resolves node-first, and so was reading a *different file* than the
 * bundle — while the published `dist/index.js` threw `document is not defined`
 * on the first HTML fetch.
 *
 * Everything else in this suite tests the source. This tests `dist`, in a child
 * process, through Node's own module loader, because the bundler is a component
 * with its own resolution rules and a build that is wrong only in the bundle is
 * still wrong.
 *
 * Skipped when there is no build to test, so `pnpm test` on a fresh clone does
 * not fail on an absent artifact. Run `pnpm build` first to exercise it.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const entry = resolve(__dirname, "../dist/index.js");

/**
 * Each case costs a Node process loading the whole bundle, which is a few hundred
 * milliseconds of real work rather than a mock. The suite's other slow tests run
 * against wall-clock budgets, so these get room of their own rather than sitting
 * at the 5s default where a loaded machine turns them into intermittent failures
 * that look like the artifact is broken.
 */
const SPAWN_TIMEOUT = 30_000;

/** Run a snippet against the built ESM entry, in a real Node process. */
const inDist = (source: string): string => run(["--input-type=module", "-e", source]);

/**
 * Run a snippet against the built CommonJS entry.
 *
 * No `--input-type=module`: that flag is what makes the default entry ESM, which
 * is how a `require` of the CJS bundle gets to be tested at all. It also means no
 * top-level `await`, hence the promise chain.
 */
const inDistCjs = (source: string): string => run(["-e", source]);

const run = (argv: string[]): string => {
	try {
		return execFileSync(process.execPath, argv, {
			cwd: resolve(__dirname, ".."),
			encoding: "utf8",
			timeout: SPAWN_TIMEOUT,
			stdio: ["ignore", "pipe", "pipe"],
		}).trim();
	} catch (error) {
		// Without this the child is a black box: execFileSync's message names the
		// exit code and nothing else, and the reason a bundle fails to load is
		// always printed on the child's stderr.
		const stderr = (error as { stderr?: string }).stderr ?? "";
		throw new Error(`${(error as Error).message}\n${stderr}`);
	}
};

describe.skipIf(!existsSync(entry))("built artifact", () => {
	it(
		"does not carry turndown's DOM implementation",
		() => {
			// `@mixmark-io/domino` is 8.6MB on disk and ~490KB inlined, which took
			// this bundle from 296KB to 789KB to serve one optional tool. `turndown`
			// is in `dependencies`, so Node resolves it at runtime and no consumer
			// should be handed a second copy.
			//
			// Asserted on the artifact rather than the config, because the config is
			// the thing most likely to drift: one stray dependency added to
			// `rollupOptions.external` removed, or a new package that pulls in a DOM,
			// and the cost is invisible until someone measures the tarball.
			const bundle = readFileSync(entry, "utf8");
			expect(bundle).not.toContain("@mixmark-io/domino");
			expect(bundle).not.toContain("createHTMLDocument");
			// It should still be *used* — external, not quietly deleted.
			expect(bundle).toMatch(/from ["']turndown["']|require\(["']turndown["']\)/);
		},
		SPAWN_TIMEOUT,
	);

	it(
		"stays a library bundle rather than growing without bound",
		() => {
			// A ceiling, not a snapshot: it exists to make an accidental 3x jump
			// someone else's problem to notice. The file is unminified with full
			// source maps, so the number is only meaningful next to those two facts.
			const kb = Math.round(readFileSync(entry).byteLength / 1024);
			expect(kb).toBeLessThan(400);
		},
		SPAWN_TIMEOUT,
	);

	it(
		"converts HTML to markdown without a DOM",
		() => {
			// The regression this file was written for. `document is not defined`
			// here means the bundle picked turndown's browser build.
			expect(
				inDist(`
					import { createWebFetchTool } from "./dist/index.js";
					const tool = createWebFetchTool({
						fetchImpl: async () => new Response(
							"<title>T</title><h1>Built ok</h1><script>x=1</script><p>Body <b>text</b></p>",
							{ headers: { "content-type": "text/html" } },
						),
					});
					process.stdout.write(await tool.execute({ url: "https://example.com/" }, {}));
				`),
			).toBe("# Built ok\n\nBody **text**");
		},
		SPAWN_TIMEOUT,
	);

	it(
		"registers web_fetch, and honours withWebFetch: false",
		() => {
			expect(
				inDist(`
					import { createCodingTools } from "./dist/index.js";
					const env = {
						readFile: async () => "", writeFile: async () => {},
						exists: async () => false, readdir: async () => [],
						grep: async () => "", exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
					};
					const keys = (o) => Object.keys(o).sort().join(",");
					process.stdout.write(
						keys(createCodingTools(env)) + "\\n" + keys(createCodingTools(env, { withWebFetch: false })),
					);
				`),
			).toBe(
				"bash,edit,grep,list,outline,read,web_fetch,write\nbash,edit,grep,list,outline,read,write",
			);
		},
		SPAWN_TIMEOUT,
	);

	it(
		"still refuses a non-http scheme from the bundle",
		() => {
			expect(
				inDist(`
					import { createWebFetchTool } from "./dist/index.js";
					const out = await createWebFetchTool().execute({ url: "file:///etc/passwd" }, {});
					process.stdout.write(out);
				`),
			).toContain("only http and https");
		},
		SPAWN_TIMEOUT,
	);

	it(
		"loads as CommonJS too",
		() => {
			// The package ships `dist/index.cjs`, and the two formats resolve
			// independently — a CJS-only failure here is the same class of bug with
			// a different symptom.
			if (!existsSync(resolve(__dirname, "../dist/index.cjs"))) return;
			expect(
				inDistCjs(`
					const { createWebFetchTool } = require("./dist/index.cjs");
					createWebFetchTool({
						fetchImpl: async () => new Response("<h1>CJS ok</h1>", {
							headers: { "content-type": "text/html" },
						}),
					}).execute({ url: "https://example.com/" }, {}).then((out) => {
						process.stdout.write(out);
					});
				`),
			).toBe("# CJS ok");
		},
		SPAWN_TIMEOUT,
	);
});