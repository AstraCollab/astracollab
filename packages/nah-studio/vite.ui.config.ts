import { resolve } from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/**
 * The Studio UI, built to plain static files.
 *
 * Output is relative (`base: "./"`) because the files are served by the Studio's
 * own server rather than from a domain root, and hashed assets are inlined only
 * when tiny — the point of the build is small cacheable files with real names,
 * not one self-contained blob that changes on every keystroke of source.
 *
 * Lives under `dist/ui` beside `dist/cli.js` so one published package holds both
 * halves of the Studio, and the server finds its own assets relative to its
 * entry point with no configuration.
 */
export default defineConfig({
	// Relative asset URLs: the server may be behind a path prefix.
	base: "./",
	root: resolve(__dirname, "src-ui"),
	plugins: [react(), tailwindcss()],
	build: {
		target: "es2022",
		outDir: resolve(__dirname, "dist/ui"),
		emptyOutDir: true,
		// Hashed filenames are what make a year-long immutable cache header honest.
		assetsDir: "assets",
		sourcemap: false,
		chunkSizeWarningLimit: 900,
	},
	server: {
		port: 4112,
		// The dev server proxies to a running studio, so the UI can be worked on
		// against real data without a mock layer. `sse` is required for the live
		// event stream: without it Vite buffers the response and the dashboard
		// updates in one lump when the connection closes.
		proxy: {
			"/api": {
				target: "http://127.0.0.1:4111",
				changeOrigin: true,
				sse: true,
			},
		},
	},
});
