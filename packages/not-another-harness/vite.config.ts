import { resolve } from "node:path";
import { defineConfig } from "vite";
import dts from "vite-plugin-dts";

export default defineConfig({
	build: {
		target: "es2022",
		sourcemap: true,
		minify: false,
		lib: {
			entry: {
				index: resolve(__dirname, "src/index.ts"),
				node: resolve(__dirname, "src/node.ts"),
			},
			formats: ["es", "cjs"],
			fileName: (format, entryName) =>
				`${entryName}.${format === "cjs" ? "cjs" : "js"}`,
		},
		rollupOptions: {
			/**
			 * `turndown` is external, and it is the one dependency here that has to
			 * be. It pulls `@mixmark-io/domino` — a full DOM implementation, 8.6MB on
			 * disk — and inlining it took `dist/index.js` from 276KB to 789KB. That
			 * is not a rounding error: it is paid by every consumer who bundles this
			 * package, to serve one optional tool, whether or not they ever fetch a
			 * URL.
			 *
			 * Nothing is lost by leaving it out. `turndown` is a real entry in
			 * `dependencies`, so npm installs it and Node resolves it from
			 * `not-another-harness/node_modules` at runtime — the same reasoning
			 * `pi-tui` keeps external in nah's config. A consumer that does bundle
			 * can dedupe it against their own copy; nobody should get a second one
			 * silently inlined here.
			 *
			 * `htmlparser2` is deliberately *not* on this list. It is ESM-only, so
			 * the CommonJS output would have to `require()` it, and that needs a
			 * `require(esm)` Node that `engines: >=22.0.0` does not promise. It
			 * costs about 40KB and brings no DOM of its own.
			 *
			 * Being external also side-steps a trap that is easy to fall into again.
			 * turndown ships a `browser` field that maps `@mixmark-io/domino` to
			 * `false` and its own entries to builds needing a global `document`, and
			 * vite applies that field by default because its `mainFields` starts
			 * with `"browser"`. Bundling it therefore produced a file that loads and
			 * then fails at `domino.createDocument is not a function`. Overriding
			 * `mainFields` also fixed that, but only for this package: the moment
			 * another dependency with a `browser` field is added, the override stops
			 * covering it. Not resolving the module at all cannot rot that way.
			 *
			 * None of this is visible to the unit tests, which resolve node-first and
			 * so read different files than the bundle does. `test/dist-smoke.test.ts`
			 * asserts against the built artifact — that it converts HTML, that it
			 * loads as both module formats, and that it is not carrying a DOM.
			 */
			external: ["ai", /^ai\//, "zod", /^node:/, "turndown"],
		},
	},
	plugins: [
		dts({
			entryRoot: "src",
			outDir: "dist",
			tsconfigPath: "./tsconfig.json",
			rollupTypes: false,
		}),
	],
	test: {
		environment: "node",
		include: ["test/**/*.test.ts"],
	},
});