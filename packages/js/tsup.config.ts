import { defineConfig } from "tsup";

export default defineConfig({
	entry: ["src/index.ts"],
	format: ["cjs", "esm"],
	dts: true,
	splitting: false,
	sourcemap: true,
	clean: true,
	treeshake: true,
	external: [],
	minify: true,
	env: {
		NODE_ENV: process.env.NODE_ENV || "development",
	},
	define: {
		"process.env.NODE_ENV": JSON.stringify(process.env.NODE_ENV || "development"),
	},
});
