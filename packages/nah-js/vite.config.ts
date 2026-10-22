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
				client: resolve(__dirname, "src/client.ts"),
			},
			formats: ["es", "cjs"],
			fileName: (format, entryName) =>
				`${entryName}.${format === "cjs" ? "cjs" : "js"}`,
		},
		rollupOptions: {
			/**
			 * The harness and the AI SDK stay external for the same reason they do
			 * in `not-another-harness`: a runtime that bundles its own copy of the
			 * harness would carry two copies of the agent loop, and the types it
			 * exchanges with the app's copy would not be the same types.
			 *
			 * React is external because the client entry is a hook, not a
			 * component tree — there is nothing here that needs the JSX runtime,
			 * and bundling React would put two copies of it in the app.
			 */
			external: [
				"ai",
				/^ai\//,
				"zod",
				/^not-another-harness(\/.*)?$/,
				/^node:/,
				"react",
				"react-dom",
			],
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
		/**
		 * The facade re-exports the framework's Web runtime under its
		 * published path. The suite resolves that path to the source, so it
		 * does not need the framework to be built first.
		 */
		alias: {
			"not-another-harness/js/client": resolve(
				__dirname,
				"../not-another-harness/src/js/client.ts",
			),
			"not-another-harness/js": resolve(
				__dirname,
				"../not-another-harness/src/js/index.ts",
			),
		},
	},
});
