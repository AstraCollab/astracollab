import { resolve } from "node:path"
import { defineConfig } from "vite"
import dts from "vite-plugin-dts"

/**
 * Library build.
 *
 * Vite rather than a hand-rolled tsup/rollup setup because the three things that
 * matter for an SDK are handled rather than configured: native ESM in, both ESM
 * and CJS out, and tree-shaking that actually works because nothing is bundled
 * by accident.
 *
 * `ofetch` is external and a peer dependency. Bundling it would ship a second
 * copy inside every consumer that already has one, which is the axios-shaped
 * mistake the whole exercise is meant to avoid.
 */
export default defineConfig({
  build: {
    target: "es2022",
    sourcemap: true,
    minify: "esbuild",
    lib: {
      entry: resolve(__dirname, "src/index.ts"),
      name: "CognitiveMemory",
      formats: ["es", "cjs"],
      // Must match the `exports` map in package.json, or the package resolves
      // to files that do not exist — a failure that only shows up on install.
      fileName: (format) => `cognitive-memory.${format === "cjs" ? "cjs" : "js"}`
    },
    rollupOptions: {
      external: ["ofetch"],
      output: {
        globals: { ofetch: "ofetch" }
      }
    }
  },
  plugins: [dts({ rollupTypes: true, entryRoot: "src" })],
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"]
  }
})
