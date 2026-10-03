import { defineConfig } from "vite";
import dts from "vite-plugin-dts";
import { resolve } from "node:path";
import { createRequire } from "node:module";

const { version } = createRequire(import.meta.url)("./package.json") as {
  version: string;
};

export default defineConfig({
  build: {
    target: "es2022",
    sourcemap: false,
    minify: true,
    emptyOutDir: true,
    lib: {
      entry: {
        cli: resolve(__dirname, "src/cli.ts"),
        // The read-only agent the Studio runs, so a dashboard debugs the same
        // agent rather than a second assembly of the same prompt and tools.
        agent: resolve(__dirname, "src/agent.ts"),
      },
      formats: ["es"],
    },
    rollupOptions: {
      // pi-tui reaches for node:child_process (it can shell out for its
      // autocomplete provider) and ships native clipboard prebuilds, so it must
      // stay a real runtime dependency rather than being inlined into the CLI
      // bundle. It is declared in `dependencies`, so npm installs it.
      //
      // The workspace packages are external for the mirror-image reason: they are
      // published and versioned on their own, so inlining a copy would let the
      // CLI ship a different build of the engine than the one its tests ran
      // against. `@astracollab/cogmem` joins them for the hosted memory backend.
      external: [
        /^node:/,
        "@astracollab/cogmem",
        "not-another-harness",
        "@blaxel/core",
        "@earendil-works/pi-tui",
      ],
      output: {
        // Two entries with fixed names, because `package.json` points at them:
        // `dist/cli.js` is the bin and `dist/agent.js` is what the Studio imports.
        // Shared code goes to `chunks/` rather than the dist root, where it would
        // sit next to the two files the manifest names.
        entryFileNames: "[name].js",
        chunkFileNames: "chunks/[name]-[hash].js",
        // Providers are lazy-imported; the banner makes dist/cli.js executable,
        // and only the entry gets one — a shebang on a shared chunk is noise, and
        // a library entry with a shebang is a lie about what it is.
        banner: (chunk) => (chunk.isEntry && chunk.name === "cli" ? "#!/usr/bin/env node" : ""),
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
  define: {
    __NAH_VERSION__: JSON.stringify(version),
  },
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
  },
});
