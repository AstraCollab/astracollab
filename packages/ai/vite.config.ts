import { defineConfig } from "vite";
import dts from "vite-plugin-dts";
import { resolve } from "node:path";

export default defineConfig({
  build: {
    target: "es2022",
    sourcemap: true,
    minify: false,
    lib: {
      entry: {
        index: resolve(__dirname, "src/index.ts"),
        "cursor/index": resolve(__dirname, "src/cursor/index.ts"),
        "workflows/index": resolve(__dirname, "src/workflows/index.ts"),
        "workflows/mastra/index": resolve(
          __dirname,
          "src/workflows/mastra/index.ts",
        ),
      },
      formats: ["es", "cjs"],
      fileName: (format, entryName) =>
        `${entryName}.${format === "cjs" ? "cjs" : "js"}`,
    },
    rollupOptions: {
      external: [
        "ofetch",
        "@ai-sdk/openai-compatible",
        "@mastra/core",
        "@mastra/core/workflows",
        /^@mastra\/core\//,
        "ai",
        "zod",
        /^@ai-sdk\//,
        /^ai\//,
      ],
      output: {
        preserveModules: false,
        // Avoid shared chunks (e.g. resolver-*.js) that Turbopack cannot resolve via file: symlinks.
        manualChunks: undefined,
      },
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
});
