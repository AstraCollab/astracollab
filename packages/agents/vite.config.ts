import { defineConfig } from "vite";
import dts from "vite-plugin-dts";

/**
 * Built as a library, not an app.
 *
 * `ai` and `zod` stay external because they are the consumer's AI SDK, and
 * bundling a second copy is how a tool schema ends up validating against a
 * different `z` than the harness the tools are handed to.
 */
export default defineConfig({
  build: {
    target: "es2022",
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: true,
    lib: { entry: "src/index.ts", formats: ["es", "cjs"], fileName: (f) => (f === "cjs" ? "index.cjs" : "index.js") },
    rollupOptions: {
      external: [/^node:/, "ai", /^ai\//, "zod", "not-another-harness", /^not-another-harness\//],
    },
  },
  test: { environment: "node", include: ["test/**/*.test.ts"] },
  plugins: [dts({ entryRoot: "src", outDir: "dist", tsconfigPath: "./tsconfig.json", rollupTypes: false })],
});
