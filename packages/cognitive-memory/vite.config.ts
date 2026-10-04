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
      // Three entries, each with a different peer-dependency profile:
      //
      //  - `index`    — everything, including the HTTP client, so it needs `ofetch`.
      //  - `engine`   — the deterministic core only. No `ofetch`, so a consumer that
      //                 never makes a network call is not made to install one. This is
      //                 a *fix*, not a nicety: a top-level `import { ofetch }` in the
      //                 main entry threw ERR_MODULE_NOT_FOUND in pnpm workspaces,
      //                 where npm's automatic peer installation does not apply.
      //  - `arbiter`  — the only thing that needs `ai` and `zod`. Bundling it into the
      //                 main entry would force those peers on every consumer, and
      //                 `ai` is not a small dependency.
      entry: {
        index: resolve(__dirname, "src/index.ts"),
        engine: resolve(__dirname, "src/engine.ts"),
        arbiter: resolve(__dirname, "src/arbiter.ts")
      },
      name: "CognitiveMemory",
      formats: ["es", "cjs"],
      // Must match the `exports` map in package.json, or the package resolves
      // to files that do not exist — a failure that only shows up on install.
      fileName: (format, entryName) =>
        `${entryName === "index" ? "cognitive-memory" : entryName}.${format === "cjs" ? "cjs" : "js"}`
    },
    rollupOptions: {
      external: ["ofetch", "ai", /^ai\//, "zod"],
      output: {
        globals: { ofetch: "ofetch", ai: "ai", zod: "zod" }
      }
    }
  },
  plugins: [dts({ rollupTypes: true, entryRoot: "src" })],
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"]
  }
})
