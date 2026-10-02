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
    // The UI is built into `dist/ui` first and must survive this build, so the
    // lib step only ever adds `cli.js` beside it.
    emptyOutDir: false,
    lib: {
      entry: {
        cli: resolve(__dirname, "src/cli.ts"),
      },
      formats: ["es"],
      fileName: () => "cli.js",
    },
    rollupOptions: {
      // Same reasoning as the CLI: the engine and the terminal UI are published,
      // versioned packages, so inlining a copy here would let the dashboard
      // trace runs through a different build than the one it claims to debug.
      external: [/^node:/, "@astracollab/not-another-harness", "nah", "@earendil-works/pi-tui", "@blaxel/core"],
      output: {
        // Providers and the agent are lazy-imported; the banner makes the entry
        // executable, and only the entry — a shebang on a shared chunk is noise.
        banner: (chunk) => (chunk.isEntry && chunk.name === "cli" ? "#!/usr/bin/env node" : ""),
      },
    },
  },
  plugins: [
    dts({
      entryRoot: "src",
      outDir: "dist",
      // The UI is typechecked by its own config; this one is about the server.
      exclude: ["src-ui/**", "src/wire.ts"],
      tsconfigPath: "./tsconfig.json",
      rollupTypes: false,
    }),
  ],
  define: {
    __NAH_STUDIO_VERSION__: JSON.stringify(version),
  },
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
  },
});
